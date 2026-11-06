import {
  HEAT_FACTOR_FIELDS,
  SKU_ID_FIELD,
  SKU_ID_LABEL,
} from '@/data/quantityFields'
import { SALES_MONTH_FIELDS } from '@/data/salesFields'
import { normalizeProductName, normalizeSkuId } from './inventory'

// 销售表提供动销指标（评分因子的唯一来源）与 1-12 月条数/重量，统一按唯一标识匹配总表。
const PRODUCT_HEADERS = new Set(['品名', '产品名称'])
const COLOR_HEADERS = new Set(['颜色', '色号'])
const SKU_ID_HEADERS = new Set([SKU_ID_LABEL, '唯一编码'])
const METRIC_HEADERS = new Map(HEAT_FACTOR_FIELDS.map(({ label, field }) => [label, field]))
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
    const orderIndexes = new Map()
    const metricIndexes = new Map()

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

      const metricField = METRIC_HEADERS.get(label)
      if (metricField && !metricIndexes.has(metricField)) {
        metricIndexes.set(metricField, cellIndex)
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
        orderIndexes,
        metricIndexes,
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
    orderIndexes,
    metricIndexes,
  } = header
  const hasMonthColumns =
    countIndexes.size > 0 || weightIndexes.size > 0 || orderIndexes.size > 0
  if (!hasMonthColumns && metricIndexes.size === 0) {
    throw new Error('未找到销售数据列：需要“N月条数”“N月重量”“N月订单数”或动销指标列')
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
    const weights = Array.from({ length: SALES_MONTH_FIELDS.length }, () => null)
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
      const weightColumn = weightIndexes.get(month)
      if (weightColumn !== undefined) {
        weights[index] = parseQuantity(
          row.cells[weightColumn],
          `${month}月重量`,
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

    if (rowErrors.length > 0) {
      errors.push(...rowErrors)
      continue
    }

    seenKeys.set(skuId, row.rowNumber)
    parsedRows.push({ skuId, product, color, counts, weights, orders, metrics })
  }

  if (!parsedRows.length) {
    throw new Error(
      errors.length ? '没有可导入的有效数据行，请修正提示的错误后重试' : '表格中没有数据行',
    )
  }

  const months = SALES_MONTH_FIELDS.map((entry) => entry.month).filter(
    (month) => countIndexes.has(month) || weightIndexes.has(month) || orderIndexes.has(month),
  )
  const metricFields = HEAT_FACTOR_FIELDS.map(({ field }) => field).filter((field) =>
    metricIndexes.has(field),
  )

  return { rows: parsedRows, errors, blankRows, months, metricFields }
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
      weights: row.weights,
      orders: row.orders,
      metrics: row.metrics,
    })
  }

  return { bySku, matched: bySku.size, unmatched, unmatchedSamples }
}
