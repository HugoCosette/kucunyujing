import { formatQuantity } from './inventory'

// 品名父行求和的数值字段：主面板与全面板的 SPU 汇总共用同一组口径。
export const PRODUCT_SUMMARY_FIELDS = [
  'planned',
  'producing',
  'backorder',
  'weeklyUsage',
  'warehouseStock',
  'turnoverIn',
  'inTransitStock',
  'theoreticalStock',
  'projectedStock',
]

const strategyFields = ['redLineStock', 'normalStock', 'peakStock', 'shortage']

function sumField(rows, field) {
  if (field === 'planned') {
    return rows.reduce((total, row) => total + (row[field] ?? 0), 0)
  }

  return rows.every((row) => Number.isFinite(row[field]))
    ? rows.reduce((total, row) => total + row[field], 0)
    : null
}

function createProductSummary(rows) {
  const strategyAvailable = rows.every((row) => row.strategyAvailable)
  const summary = Object.fromEntries(
    PRODUCT_SUMMARY_FIELDS.map((field) => [field, sumField(rows, field)]),
  )

  for (const field of strategyFields) {
    summary[field] = strategyAvailable ? sumField(rows, field) : null
  }

  return {
    ...summary,
    redLineFactor: null,
    normalFactor: null,
    peakFactor: null,
    shortageRate:
      !strategyAvailable || summary.normalStock === 0
        ? null
        : (summary.shortage / summary.normalStock) * 100,
    stockSalesRatio:
      summary.weeklyUsage === 0 ? null : summary.warehouseStock / summary.weeklyUsage,
    strategyAvailable,
    urgencyText: '',
    urgencyTone: '',
  }
}

const EMPTY_QUANTITY_TOKENS = new Set(['', '--', '-', '—', '缺省', 'null'])

// 表格单元格转数量：空占位与非数字都视为无值，父行求和时跳过。
export function toQuantityValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value ?? '').trim()
  if (EMPTY_QUANTITY_TOKENS.has(text.toLowerCase())) return null
  const number = Number(text.replace(/,/g, ''))
  return Number.isFinite(number) ? number : null
}

// 单元格是否可参与数量汇总：空/占位或数字都接受，文本列会被排除。
export function isQuantityCell(value) {
  const text = String(value ?? '').trim()
  if (EMPTY_QUANTITY_TOKENS.has(text.toLowerCase())) return true
  return toQuantityValue(value) !== null
}

// 全面板 SPU 汇总：按品名把同一品名的行聚成一个父行，父行只填品名与数量列合计，
// 其余列（色彩、颜色、热度、动销指标等）留空，与主面板父行的展示口径一致。
export function groupTableRowsByProduct(rows, { productIndex, quantityIndexes, columnCount }) {
  const groupsByProduct = new Map()
  const groups = []

  for (const row of rows) {
    const product = String(row.cells[productIndex] ?? '').trim()
    // 品名为空的行（导入时未通过校验）无法归属到 SPU，按原始行展示。
    if (!product) {
      groups.push({ ...row, product: '' })
      continue
    }

    let group = groupsByProduct.get(product)
    if (!group) {
      group = {
        id: `product:${product}`,
        product,
        isProductGroup: true,
        children: [],
        cells: Array.from({ length: columnCount }, () => ''),
      }
      group.cells[productIndex] = product
      groupsByProduct.set(product, group)
      groups.push(group)
    }
    group.children.push(row)
  }

  for (const group of groups) {
    if (!group.isProductGroup) continue
    for (const index of quantityIndexes) {
      let total = 0
      let hasValue = false
      for (const child of group.children) {
        const value = toQuantityValue(child.cells[index])
        if (value === null) continue
        total += value
        hasValue = true
      }
      if (hasValue) group.cells[index] = formatQuantity(total)
    }
  }

  return groups
}

export function groupRowsByProduct(rows) {
  const groups = []

  for (let start = 0; start < rows.length; ) {
    let end = start + 1
    while (end < rows.length && rows[end].product === rows[start].product) end += 1

    const children = rows.slice(start, end)
    groups.push({
      ...createProductSummary(children),
      id: `product:${children[0].product}`,
      product: children[0].product,
      color: '',
      category: '',
      stockingType: '',
      isProductGroup: true,
      children,
    })
    start = end
  }

  return groups
}
