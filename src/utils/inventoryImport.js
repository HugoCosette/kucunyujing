import { HEAT_FACTOR_FIELDS, QUANTITY_FIELDS } from '@/data/quantityFields'
import { normalizeProductName } from './inventory.js'

// 导入模板列：主面板基本面信息 + 计算所需输入项 + 热度配置的动销指标。
// 热度由“热度配置”规则计算，不再作为导入列。
export const IMPORT_TEMPLATE_COLUMNS = [
  '色彩',
  '品名',
  '颜色',
  '生产中',
  '欠货',
  '周消耗',
  '在仓库存',
  '在途库存',
  '周转入',
  ...HEAT_FACTOR_FIELDS.map((entry) => entry.label),
]

export const IMPORT_TEMPLATE_SAMPLE_ROWS = [
  ['黑白', '挪威网', '1#黑色', 3443, 280, 940, 3217, 3443, 0, 4120, 14520, 12, 9],
  ['彩色', '挪威网', '193#浅咖', 1735, 260, 1160, 2871, 1735, 0, 4980, 11800, 12, 6],
]

const HEADER_ALIASES = new Map([
  ['品名', 'product'],
  ['产品名称', 'product'],
  ['颜色', 'color'],
  ['色号', 'color'],
  // 旧模板的热度列仅用于统计被忽略的行数，不参与导入。
  ['热度', 'stockingType'],
  // 兼容旧模板 / 旧导出文件的表头写法。
  ['备货类型', 'stockingType'],
  ['备货分类', 'stockingType'],
  ['色彩', 'category'],
  ['色彩类别', 'category'],
  ['生产中', 'producing'],
  ['欠货', 'backorder'],
  ['周消耗', 'weeklyUsage'],
  ['在仓库存', 'warehouseStock'],
  ['在途库存', 'inTransitStock'],
  ['周转入', 'turnoverIn'],
  ...HEAT_FACTOR_FIELDS.map((entry) => [entry.label, entry.field]),
  // 仅用于识别并提示被忽略的列，不参与导入。
  ['需安排', 'planned'],
])

const CATEGORIES = ['黑白', '彩色']
const EMPTY_QUANTITY_TOKENS = new Set(['', '--', '-', '—', '缺省', 'null'])
const HEADER_SCAN_ROWS = 10

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[*＊]/g, '')
}

// 表头文字 → 库存字段名，全面板据此判断哪些列可做 SPU 汇总。
export function resolveInventoryField(label) {
  return HEADER_ALIASES.get(normalizeHeader(label)) ?? ''
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
  let ignoredHeatRows = 0

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
    for (const { field, label } of [...QUANTITY_FIELDS, ...HEAT_FACTOR_FIELDS]) {
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

    seenKeys.set(rowKey, row.rowNumber)
    items.push({ product, color, category, ...quantities })
  }

  if (!items.length) {
    throw new Error(
      errors.length ? '没有可导入的有效数据行，请修正提示的错误后重试' : '表格中没有数据行',
    )
  }

  return { items, errors, blankRows, ignoredPlannedRows, ignoredHeatRows }
}

// 全面板展示用：不做字段映射与校验，完整保留表头以下的所有非空行与全部列。
// 主面板仍按 parseInventorySheet 的特定字段导入，两者共用同一份行数据。
export function readSheetTable(rows) {
  const header = locateHeader(rows)
  if (!header) {
    throw new Error('未找到表头：Excel 中需要包含“品名”和“颜色”两列')
  }

  const { headerIndex } = header
  const headerCells = rows[headerIndex].cells
  const dataRows = rows.slice(headerIndex + 1).filter((row) => !isRowEmpty(row.cells))
  // 部分文件会残留无内容的格式单元格，按实际有值的最后一列截断，避免出现大量空列。
  let columnCount = 0
  const markLastUsedColumn = (cells) => {
    for (let index = cells.length - 1; index >= 0; index -= 1) {
      if (String(cells[index] ?? '').trim() !== '') {
        columnCount = Math.max(columnCount, index + 1)
        return
      }
    }
  }
  markLastUsedColumn(headerCells)
  for (const row of dataRows) markLastUsedColumn(row.cells)

  const columns = Array.from({ length: columnCount }, (_, index) => {
    const label = String(headerCells[index] ?? '').trim()
    return { key: `c${index}`, label: label || `列${index + 1}` }
  })
  const tableRows = dataRows.map((row) => ({
    rowNumber: row.rowNumber,
    cells: Array.from({ length: columnCount }, (_, index) => row.cells[index] ?? ''),
  }))

  return { columns, rows: tableRows }
}
