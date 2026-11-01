import { normalizeProductName } from './inventory.js'

// 导入模板列：只包含基本面信息与参与计算的输入项，需安排由面板自己维护。
export const IMPORT_TEMPLATE_COLUMNS = [
  '备货类型',
  '色彩',
  '品名',
  '颜色',
  '生产中',
  '欠货',
  '周消耗',
  '在仓库存',
  '周转入',
]

export const IMPORT_TEMPLATE_SAMPLE_ROWS = [
  ['热销', '黑白', '挪威网', '1#黑色', 3443, 280, 940, 3217, 0],
  ['常规', '彩色', '挪威网', '193#浅咖', 1735, 260, 1160, 2871, 0],
]

const HEADER_ALIASES = new Map([
  ['品名', 'product'],
  ['产品名称', 'product'],
  ['颜色', 'color'],
  ['色号', 'color'],
  ['备货类型', 'stockingType'],
  ['备货分类', 'stockingType'],
  ['色彩', 'category'],
  ['色彩类别', 'category'],
  ['生产中', 'producing'],
  ['欠货', 'backorder'],
  ['周消耗', 'weeklyUsage'],
  ['在仓库存', 'warehouseStock'],
  ['周转入', 'turnoverIn'],
  // 仅用于识别并提示被忽略的列，不参与导入。
  ['需安排', 'planned'],
])

const QUANTITY_FIELDS = [
  { field: 'producing', label: '生产中' },
  { field: 'backorder', label: '欠货' },
  { field: 'weeklyUsage', label: '周消耗' },
  { field: 'warehouseStock', label: '在仓库存' },
  { field: 'turnoverIn', label: '周转入' },
]

const STOCKING_TYPES = ['热销', '常规']
const CATEGORIES = ['黑白', '彩色']
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

// 兼容导出文件的两行分组表头：定位到包含“品名”“颜色”的那一行作为表头。
function locateHeader(rows) {
  for (let index = 0; index < Math.min(rows.length, HEADER_SCAN_ROWS); index += 1) {
    const columnMap = new Map()
    rows[index].cells.forEach((cell, cellIndex) => {
      const field = HEADER_ALIASES.get(normalizeHeader(cell))
      if (field && !columnMap.has(field)) columnMap.set(field, cellIndex)
    })
    if (columnMap.has('product') && columnMap.has('color')) {
      return { headerIndex: index, columnMap }
    }
  }
  return null
}

// 将工作表行映射为库存行，错误行集中返回，不静默丢弃。
export function parseInventorySheet(rows) {
  const header = locateHeader(rows)
  if (!header) {
    throw new Error('未找到表头：Excel 中需要包含“品名”和“颜色”两列')
  }

  const { headerIndex, columnMap } = header
  const items = []
  const errors = []
  const seenKeys = new Map()
  let blankRows = 0
  let ignoredPlannedRows = 0

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

    const product = normalizeProductName(String(readCell('product') ?? ''))
    const color = String(readCell('color') ?? '').trim()
    if (!product || !color) {
      errors.push({ row: row.rowNumber, message: '品名或颜色为空' })
      continue
    }

    const rowKey = `${product}\u0000${color}`
    const duplicatedRow = seenKeys.get(rowKey)
    if (duplicatedRow !== undefined) {
      errors.push({
        row: row.rowNumber,
        message: `品名+颜色与第 ${duplicatedRow} 行重复`,
      })
      continue
    }

    const rowErrors = []
    const quantities = {}
    for (const { field, label } of QUANTITY_FIELDS) {
      quantities[field] = parseQuantity(readCell(field), label, row.rowNumber, rowErrors)
    }
    const stockingType = parseEnum(
      readCell('stockingType'),
      STOCKING_TYPES,
      '备货类型',
      row.rowNumber,
      rowErrors,
    )
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

    seenKeys.set(rowKey, row.rowNumber)
    items.push({ product, color, stockingType, category, ...quantities })
  }

  if (!items.length) {
    throw new Error(
      errors.length ? '没有可导入的有效数据行，请修正提示的错误后重试' : '表格中没有数据行',
    )
  }

  return { items, errors, blankRows, ignoredPlannedRows }
}
