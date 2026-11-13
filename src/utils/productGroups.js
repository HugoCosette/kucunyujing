import { formatQuantity } from './inventory'

// 品名父行求和的数值字段：主面板的 SPU 汇总口径。
export const PRODUCT_SUMMARY_FIELDS = [
  'planned',
  'producing',
  'backorder',
  'weeklySales',
  'warehouseStock',
  'turnoverIn',
  'inTransitStock',
  'theoreticalStock',
  'projectedStock',
  'ordered',
  'received',
  'pendingOrder',
]

const strategyFields = ['redLineStock', 'normalStock', 'peakStock', 'shortage']

function sumField(rows, field) {
  if (field === 'planned') {
    return rows.reduce((total, row) => total + (row[field] ?? 0), 0)
  }

  // 汇总只看有数据的子行：缺省行跳过，不因为一个子行无数据就让整行变缺省。
  const values = rows
    .map((row) => row[field])
    .filter((value) => Number.isFinite(value))
  return values.length ? values.reduce((total, value) => total + value, 0) : null
}

function createProductSummary(allRows) {
  const summary = Object.fromEntries(
    PRODUCT_SUMMARY_FIELDS.map((field) => [field, sumField(allRows, field)]),
  )

  for (const field of strategyFields) {
    summary[field] = sumField(allRows, field)
  }

  // 日库销比由「汇总库存条数 ÷ 汇总日销量」还原，和子行同一口径。
  const projectedUnits = sumField(allRows, 'projectedUnits')
  const dailySales = sumField(allRows, 'dailySales')
  let daysOfStock = null
  if (projectedUnits !== null) {
    daysOfStock = dailySales > 0 ? projectedUnits / dailySales : Number.POSITIVE_INFINITY
  }

  const countedRows = allRows.filter((row) => row.strategyAvailable)
  const strategyAvailable = countedRows.length > 0

  return {
    ...summary,
    redLineFactor: null,
    normalFactor: null,
    peakFactor: null,
    daysOfStock,
    shortageRate:
      !strategyAvailable || !summary.normalStock
        ? null
        : (summary.shortage / summary.normalStock) * 100,
    strategyAvailable,
    strategyIssue: '',
    strategyIssueShort: '',
    // 整个品名下的 SKU 全部不参与计算时，父行也不参与。
    excluded: allRows.length > 0 && countedRows.length === 0,
    exclusive: false,
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
// 销售表 SPU 汇总：按品名把同一品名的行聚成一个父行，父行只填品名与数量列合计，
// 颜色等文本列留空，与主面板父行的展示口径一致。
export function groupTableRowsByProduct(
  rows,
  { productIndex, quantityIndexes, ratioColumns = [], columnCount },
) {
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

  const ratioIndexes = new Set(ratioColumns.map((entry) => entry.index))

  for (const group of groups) {
    if (!group.isProductGroup) continue
    for (const index of quantityIndexes) {
      // 比例列不能直接相加，下面单独按权重列聚合。
      if (ratioIndexes.has(index)) continue
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

    // 比例列（客户CR5率）：按权重列（累积条数）加权平均；
    // 权重全缺失时退回算术平均，两者都拿不到值就保持空白。
    for (const { index, weightIndex } of ratioColumns) {
      if (!Number.isInteger(index) || index < 0) continue
      let weightedSum = 0
      let weightTotal = 0
      let plainSum = 0
      let count = 0
      for (const child of group.children) {
        const value = toQuantityValue(child.cells[index])
        if (value === null) continue
        plainSum += value
        count += 1
        const weight = weightIndex >= 0 ? toQuantityValue(child.cells[weightIndex]) : null
        if (weight !== null && weight > 0) {
          weightedSum += value * weight
          weightTotal += weight
        }
      }
      if (weightTotal > 0) group.cells[index] = Number((weightedSum / weightTotal).toFixed(4))
      else if (count > 0) group.cells[index] = Number((plainSum / count).toFixed(4))
    }
  }

  return groups
}

// 按品名聚合父行：按品名建索引而不是只认「相邻同行」，
// 即使上游排序把同品名的行拆开，也不会生成两个同 id 的父行（虚拟滚动会错位）。
export function groupRowsByProduct(rows) {
  const groupsByProduct = new Map()

  for (const row of rows) {
    const product = String(row.product ?? '')
    let group = groupsByProduct.get(product)
    if (!group) {
      group = {
        id: `product:${product}`,
        product,
        color: '',
        category: '',
        skuId: '',
        modeKey: '',
        modeName: '',
        modeLabel: '',
        isProductGroup: true,
        children: [],
      }
      groupsByProduct.set(product, group)
    }
    group.children.push(row)
  }

  // 汇总字段要等子行收齐后再算。
  return [...groupsByProduct.values()].map((group) => ({
    ...createProductSummary(group.children),
    ...group,
  }))
}
