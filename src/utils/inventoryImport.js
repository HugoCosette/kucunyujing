import {
  HEAT_FACTOR_FIELDS,
  QUANTITY_FIELDS,
  SKU_ID_FIELD,
  SKU_ID_LABEL,
} from '@/data/quantityFields'
import { CATEGORIES, LEGACY_METRIC_LABELS } from '@/stocking/constants'
import { normalizeProductName, normalizeSkuId } from './inventory.js'

// 总表模板列：SKU 关联键 + 基本面信息 + 备货计算所需的全部数量列。
// 「出码率 / 公斤系数」把库存（码或公斤）换算成公斤，缺失时该行不参与计算。
export const IMPORT_TEMPLATE_COLUMNS = [
  SKU_ID_LABEL,
  '色彩',
  '品名',
  '颜色',
  ...QUANTITY_FIELDS.map((entry) => entry.label),
  '出码率',
  '公斤系数',
]

export const IMPORT_TEMPLATE_SAMPLE_ROWS = [
  ['NO-0001', '黑白', '挪威网', '1#黑色', 3443, 280, 940, 3217, 3443, 0, 12000, 34, 0.029412],
  ['NO-0002', '彩色', '挪威网', '193#浅咖', 1735, 260, 1160, 2871, 1735, 0, 8600, 34, 0.029412],
]

const HEADER_ALIASES = new Map([
  [SKU_ID_LABEL, SKU_ID_FIELD],
  ['唯一编码', SKU_ID_FIELD],
  ['品名', 'product'],
  ['产品名称', 'product'],
  ['颜色', 'color'],
  ['色号', 'color'],
  ['色彩', 'category'],
  ['色彩类别', 'category'],
  ['树形分类', 'treeCategory'],
  ...QUANTITY_FIELDS.map((entry) => [entry.label, entry.field]),
  ['公斤系数', 'kgFactor'],
  ['出码率', 'unitRate'],
  ['单位', 'unit'],
  // 以下列已不参与总表导入，只用于统计并提示。
  ['评分档', 'stockingType'],
  ['热度', 'stockingType'],
  ['备货类型', 'stockingType'],
  ['备货分类', 'stockingType'],
  ['需安排', 'planned'],
  ...HEAT_FACTOR_FIELDS.map((entry) => [entry.label, entry.field]),
  ...LEGACY_METRIC_LABELS,
])

const EMPTY_QUANTITY_TOKENS = new Set(['', '--', '-', '—', '缺省', 'null'])
const HEADER_SCAN_ROWS = 10

// 公斤系数优先取显式列；缺列时用「出码率」反推（码单位），再退回按「单位」推断。
function resolveKgFactor(rawFactor, rawRate, rawUnit) {
  const factor = Number(String(rawFactor ?? '').trim().replace(/,/g, ''))
  if (Number.isFinite(factor) && factor > 0) return factor
  const rate = Number(String(rawRate ?? '').trim().replace(/,/g, ''))
  if (Number.isFinite(rate) && rate > 0) return 1 / rate
  const unit = String(rawUnit ?? '').trim()
  if (unit === '公斤') return 1
  return null
}

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[*＊]/g, '')
}

function isRowEmpty(cells) {
  return cells.every((cell) => String(cell ?? '').trim() === '')
}

function parseQuantity(raw, label, rowNumber, errors) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0

  const text = String(raw ?? '').trim()
  if (EMPTY_QUANTITY_TOKENS.has(text.toLowerCase())) return 0

  const number = Number(text.replace(/,/g, ''))
  if (!Number.isFinite(number)) {
    errors.push({ row: rowNumber, message: `${label}不是有效数字：${text}` })
    return 0
  }
  return number
}

function parseEnum(raw, allowed, label, rowNumber, errors) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (allowed.includes(text)) return text

  errors.push({
    row: rowNumber,
    message: `${label}只能是 ${allowed.join(' / ')}：${text}`,
  })
  return ''
}

// 兼容导出文件的两行分组表头：定位到包含“唯一标识”“品名”“颜色”的那一行作为表头。
function locateHeader(rows) {
  for (let index = 0; index < Math.min(rows.length, HEADER_SCAN_ROWS); index += 1) {
    const columnMap = new Map()
    rows[index].cells.forEach((cell, cellIndex) => {
      const field = HEADER_ALIASES.get(normalizeHeader(cell))
      if (field && !columnMap.has(field)) columnMap.set(field, cellIndex)
    })
    if (columnMap.has(SKU_ID_FIELD) && columnMap.has('product') && columnMap.has('color')) {
      return { headerIndex: index, columnMap }
    }
  }
  return null
}

// 将工作表行映射为库存行，错误行集中返回，不静默丢弃。
export function parseInventorySheet(rows) {
  const header = locateHeader(rows)
  if (!header) {
    throw new Error(
      '未找到表头：Excel 中需要包含“唯一标识”“品名”“颜色”三列',
    )
  }

  const { headerIndex, columnMap } = header
  const items = []
  const errors = []
  const seenSkuIds = new Map()
  const seenNames = new Map()
  let blankRows = 0
  let ignoredPlannedRows = 0
  let ignoredHeatRows = 0
  let ignoredMetricRows = 0

  for (const row of rows.slice(headerIndex + 1)) {
    const readCell = (field) => {
      const columnIndex = columnMap.get(field)
      return columnIndex === undefined ? '' : row.cells[columnIndex]
    }

    if (isRowEmpty(row.cells)) {
      blankRows += 1
      continue
    }

    if (String(readCell('planned') ?? '').trim() !== '') ignoredPlannedRows += 1
    if (String(readCell('stockingType') ?? '').trim() !== '') ignoredHeatRows += 1
    if (HEAT_FACTOR_FIELDS.some(({ field }) => String(readCell(field) ?? '').trim() !== '')) {
      ignoredMetricRows += 1
    }

    const skuId = normalizeSkuId(readCell(SKU_ID_FIELD))
    const product = normalizeProductName(String(readCell('product') ?? ''))
    const color = String(readCell('color') ?? '').trim()

    if (!skuId) {
      errors.push({ row: row.rowNumber, message: '唯一标识为空' })
      continue
    }
    if (!product || !color) {
      errors.push({ row: row.rowNumber, message: '品名或颜色为空' })
      continue
    }

    const duplicatedSku = seenSkuIds.get(skuId)
    if (duplicatedSku !== undefined) {
      errors.push({
        row: row.rowNumber,
        message: `唯一标识与第 ${duplicatedSku} 行重复：${skuId}`,
      })
      continue
    }

    const nameKey = `${product}\u0000${color}`
    const duplicatedName = seenNames.get(nameKey)
    if (duplicatedName !== undefined) {
      errors.push({
        row: row.rowNumber,
        message: `品名+颜色与第 ${duplicatedName} 行重复`,
      })
      continue
    }

    const rowErrors = []
    const quantities = {}
    for (const { field, label } of QUANTITY_FIELDS) {
      quantities[field] = parseQuantity(readCell(field), label, row.rowNumber, rowErrors)
    }
    const category = parseEnum(
      readCell('category'),
      CATEGORIES,
      '色彩',
      row.rowNumber,
      rowErrors,
    )

    if (rowErrors.length > 0) {
      errors.push(...rowErrors)
      continue
    }

    seenSkuIds.set(skuId, row.rowNumber)
    seenNames.set(nameKey, row.rowNumber)
    items.push({
      skuId,
      product,
      color,
      category,
      // 采购下单按树形分类取分单人员；总表没有该列时为空，可在下单设置里补。
      treeCategory: String(readCell('treeCategory') ?? '').trim(),
      kgFactor: resolveKgFactor(
        readCell('kgFactor'),
        readCell('unitRate'),
        readCell('unit'),
      ),
      unitRate: Number(String(readCell('unitRate') ?? '').trim().replace(/,/g, '')) || null,
      ...quantities,
    })
  }

  if (!items.length) {
    throw new Error(
      errors.length ? '没有可导入的有效数据行，请修正提示的错误后重试' : '表格中没有数据行',
    )
  }

  return {
    items,
    errors,
    blankRows,
    ignoredPlannedRows,
    ignoredHeatRows,
    ignoredMetricRows,
  }
}
