import {
  HEAT_FACTOR_FIELDS,
  SKU_ID_FIELD,
  SKU_ID_LABEL,
} from '@/data/quantityFields'
import { SALES_MONTH_FIELDS } from '@/data/salesFields'
import { LEGACY_METRIC_LABELS } from '@/stocking/constants'
import { normalizeProductName, normalizeSkuId } from './inventory'

// 销售表提供动销指标（模式判定的唯一来源）与 1-12 月条数/重量，统一按唯一标识匹配总表。
const PRODUCT_HEADERS = new Set(['品名', '产品名称'])
const COLOR_HEADERS = new Set(['颜色', '色号'])
const SKU_ID_HEADERS = new Set([SKU_ID_LABEL, '唯一编码'])
const METRIC_HEADERS = new Map([
  ...HEAT_FACTOR_FIELDS.map(({ label, field }) => [label, field]),
  // 旧销售表里的「动销客户」仍按累计客户解析
  ...LEGACY_METRIC_LABELS,
])
// 客户CR5率：比例列，与动销指标分开存（不进主面板、不参与评分）。
const CR5_HEADERS = new Set(['客户CR5率', '客户CR5'])
const CR5_LABEL = '客户CR5率'
const CUMULATIVE_SALES_LABEL = '累积销量'
const MONTH_SALES_PATTERN = /^(\d{1,2})月销量$/
// 旧销售表（v1.5 之前）用「N月条数 + N月重量」，仍按公斤口径读入
const MONTH_COUNT_PATTERN = /^(\d{1,2})月条数$/
const MONTH_WEIGHT_PATTERN = /^(\d{1,2})月重量$/
const MONTH_ORDER_PATTERN = /^(\d{1,2})月订单数$/
const EMPTY_QUANTITY_TOKENS = new Set(['', '--', '-', '—', '缺省', 'null'])
const HEADER_SCAN_ROWS = 10

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[*＊]/g, '')
}

function isRowEmpty(cells) {
  return cells.every((cell) => String(cell ?? '').trim() === '')
}

// 表头需包含唯一标识、品名、颜色，并至少有一列动销指标或月份数据。
function locateHeader(rows) {
  for (let index = 0; index < Math.min(rows.length, HEADER_SCAN_ROWS); index += 1) {
    let skuIndex = -1
    let productIndex = -1
    let colorIndex = -1
    const countIndexes = new Map()
    const weightIndexes = new Map()
    const salesIndexes = new Map()
    const orderIndexes = new Map()
    const metricIndexes = new Map()
    let cr5Index = -1
    let cumulativeSalesIndex = -1

    rows[index].cells.forEach((cell, cellIndex) => {
      const label = normalizeHeader(cell)
      if (skuIndex < 0 && SKU_ID_HEADERS.has(label)) {
        skuIndex = cellIndex
        return
      }
      if (productIndex < 0 && PRODUCT_HEADERS.has(label)) {
        productIndex = cellIndex
        return
      }
      if (colorIndex < 0 && COLOR_HEADERS.has(label)) {
        colorIndex = cellIndex
        return
      }

      if (cr5Index < 0 && CR5_HEADERS.has(label)) {
        cr5Index = cellIndex
        return
      }

      if (cumulativeSalesIndex < 0 && label === CUMULATIVE_SALES_LABEL) {
        cumulativeSalesIndex = cellIndex
        return
      }

      const metricField = METRIC_HEADERS.get(label)
      if (metricField && !metricIndexes.has(metricField)) {
        metricIndexes.set(metricField, cellIndex)
        return
      }

      const salesMatch = MONTH_SALES_PATTERN.exec(label)
      if (salesMatch) {
        const month = Number(salesMatch[1])
        if (month >= 1 && month <= 12 && !salesIndexes.has(month)) {
          salesIndexes.set(month, cellIndex)
        }
        return
      }

      const countMatch = MONTH_COUNT_PATTERN.exec(label)
      if (countMatch) {
        const month = Number(countMatch[1])
        if (month >= 1 && month <= 12 && !countIndexes.has(month)) {
          countIndexes.set(month, cellIndex)
        }
        return
      }

      const weightMatch = MONTH_WEIGHT_PATTERN.exec(label)
      if (weightMatch) {
        const month = Number(weightMatch[1])
        if (month >= 1 && month <= 12 && !weightIndexes.has(month)) {
          weightIndexes.set(month, cellIndex)
        }
        return
      }

      const orderMatch = MONTH_ORDER_PATTERN.exec(label)
      if (orderMatch) {
        const month = Number(orderMatch[1])
        if (month >= 1 && month <= 12 && !orderIndexes.has(month)) {
          orderIndexes.set(month, cellIndex)
        }
      }
    })

    if (skuIndex >= 0 && productIndex >= 0 && colorIndex >= 0) {
      return {
        headerIndex: index,
        skuIndex,
        productIndex,
        colorIndex,
        countIndexes,
        weightIndexes,
        salesIndexes,
        orderIndexes,
        metricIndexes,
        cr5Index,
        cumulativeSalesIndex,
      }
    }
  }
  return null
}

function parseQuantity(raw, label, rowNumber, errors) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null

  const text = String(raw ?? '').trim()
  if (EMPTY_QUANTITY_TOKENS.has(text.toLowerCase())) return null

  const number = Number(text.replace(/,/g, ''))
  if (!Number.isFinite(number)) {
    errors.push({ row: rowNumber, message: `${label}不是有效数字：${text}` })
    return null
  }
  return number
}

// 比例列统一存 0~1：0.9532 与 95.32 / 95.32% 都认（超过 1 一律按百分数理解）。
function parseRatio(raw, label, rowNumber, errors) {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (EMPTY_QUANTITY_TOKENS.has(text.toLowerCase())) return null
  const isPercent = text.endsWith('%')
  const value = parseQuantity(isPercent ? text.slice(0, -1) : raw, label, rowNumber, errors)
  if (value === null) return null
  const ratio = isPercent || value > 1 ? value / 100 : value
  // 保留 4 位，避免 95.32 / 100 这类浮点尾数（0.9531999…）出现在单元格里
  return Number(Math.min(1, Math.max(0, ratio)).toFixed(4))
}

// 解析销售表：月份列与动销指标列都可缺省，缺列时该指标记为空（评分判为 Z）。
export function parseSalesSheet(rows) {
  const header = locateHeader(rows)
  if (!header) {
    throw new Error('未找到表头：销售表需要包含“唯一标识”“品名”“颜色”三列')
  }

  const {
    headerIndex,
    skuIndex,
    productIndex,
    colorIndex,
    countIndexes,
    weightIndexes,
    salesIndexes,
    orderIndexes,
    metricIndexes,
    cr5Index,
    cumulativeSalesIndex,
  } = header
  const hasMonthColumns =
    countIndexes.size > 0 || weightIndexes.size > 0 || salesIndexes.size > 0 || orderIndexes.size > 0
  if (!hasMonthColumns && metricIndexes.size === 0 && cr5Index < 0) {
    throw new Error(
      '未找到销售数据列：需要“N月条数”“N月重量”“N月订单数”“客户CR5率”或动销指标列',
    )
  }

  const errors = []
  const seenKeys = new Map()
  const parsedRows = []
  let blankRows = 0

  for (const row of rows.slice(headerIndex + 1)) {
    if (isRowEmpty(row.cells)) {
      blankRows += 1
      continue
    }

    const skuId = normalizeSkuId(row.cells[skuIndex])
    const product = normalizeProductName(String(row.cells[productIndex] ?? ''))
    const color = String(row.cells[colorIndex] ?? '').trim()
    if (!skuId) {
      errors.push({ row: row.rowNumber, message: '唯一标识为空' })
      continue
    }
    if (!product || !color) {
      errors.push({ row: row.rowNumber, message: '品名或颜色为空' })
      continue
    }

    const duplicatedRow = seenKeys.get(skuId)
    if (duplicatedRow !== undefined) {
      errors.push({
        row: row.rowNumber,
        message: `唯一标识与第 ${duplicatedRow} 行重复：${skuId}`,
      })
      continue
    }

    const rowErrors = []
    const counts = Array.from({ length: SALES_MONTH_FIELDS.length }, () => null)
    const sales = Array.from({ length: SALES_MONTH_FIELDS.length }, () => null)
    const orders = Array.from({ length: SALES_MONTH_FIELDS.length }, () => null)
    for (const { month, index } of SALES_MONTH_FIELDS) {
      const countColumn = countIndexes.get(month)
      if (countColumn !== undefined) {
        counts[index] = parseQuantity(
          row.cells[countColumn],
          `${month}月条数`,
          row.rowNumber,
          rowErrors,
        )
      }
      // 新表用「N月销量」（公斤）；旧表只有「N月重量」（公斤口径），按同一字段读入
      const salesColumn = salesIndexes.get(month) ?? weightIndexes.get(month)
      if (salesColumn !== undefined) {
        sales[index] = parseQuantity(
          row.cells[salesColumn],
          `${month}月销量`,
          row.rowNumber,
          rowErrors,
        )
      }
      const orderColumn = orderIndexes.get(month)
      if (orderColumn !== undefined) {
        orders[index] = parseQuantity(
          row.cells[orderColumn],
          `${month}月订单数`,
          row.rowNumber,
          rowErrors,
        )
      }
    }

    const metrics = {}
    for (const { field, label } of HEAT_FACTOR_FIELDS) {
      const metricColumn = metricIndexes.get(field)
      metrics[field] =
        metricColumn === undefined
          ? null
          : parseQuantity(row.cells[metricColumn], label, row.rowNumber, rowErrors)
    }
    const cr5 =
      cr5Index < 0 ? null : parseRatio(row.cells[cr5Index], CR5_LABEL, row.rowNumber, rowErrors)
    const cumulativeSales =
      cumulativeSalesIndex < 0
        ? null
        : parseQuantity(row.cells[cumulativeSalesIndex], CUMULATIVE_SALES_LABEL, row.rowNumber, rowErrors)

    if (rowErrors.length > 0) {
      errors.push(...rowErrors)
      continue
    }

    seenKeys.set(skuId, row.rowNumber)
    parsedRows.push({ skuId, product, color, counts, sales, orders, metrics, cr5, cumulativeSales })
  }

  if (!parsedRows.length) {
    throw new Error(
      errors.length ? '没有可导入的有效数据行，请修正提示的错误后重试' : '表格中没有数据行',
    )
  }

  const months = SALES_MONTH_FIELDS.map((entry) => entry.month).filter(
    (month) =>
      countIndexes.has(month) || salesIndexes.has(month) || weightIndexes.has(month) || orderIndexes.has(month),
  )
  const metricFields = HEAT_FACTOR_FIELDS.map(({ field }) => field).filter((field) =>
    metricIndexes.has(field),
  )

  return { rows: parsedRows, errors, blankRows, months, metricFields, hasCr5: cr5Index >= 0 }
}

// 销售表按唯一标识匹配总表：只保留总表已有的 SKU，其余行跳过并计数。
export function attachSalesToInventory(salesRows, inventoryItems) {
  const inventorySkuIds = new Set(inventoryItems.map((item) => item.skuId))
  const bySku = new Map()
  const unmatchedSamples = []
  let unmatched = 0

  for (const row of salesRows) {
    if (!inventorySkuIds.has(row.skuId)) {
      unmatched += 1
      if (unmatchedSamples.length < 5) {
        unmatchedSamples.push(`${row.skuId} ${row.product} / ${row.color}`)
      }
      continue
    }
    bySku.set(row.skuId, {
      counts: row.counts,
      sales: row.sales,
      orders: row.orders,
      metrics: row.metrics,
      cr5: row.cr5 ?? null,
      cumulativeSales: row.cumulativeSales ?? null,
    })
  }

  return { bySku, matched: bySku.size, unmatched, unmatchedSamples }
}
