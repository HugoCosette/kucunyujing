const aggregatedFields = [
  'planned',
  'producing',
  'backorder',
  'weeklyUsage',
  'warehouseStock',
  'turnoverIn',
  'inTransitStock',
  'theoreticalStock',
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
    aggregatedFields.map((field) => [field, sumField(rows, field)]),
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
