export function calculateInventoryRow(item, stockingRules) {
  const ruleFactors = stockingRules[item.stockingType]?.[item.category]
  const strategyAvailable = Boolean(
    ruleFactors && Object.values(ruleFactors).every(Number.isFinite),
  )
  const factors = strategyAvailable
    ? ruleFactors
    : { redLine: null, normal: null, peak: null }
  const planned = item.planned ?? 0
  const inTransitStock = planned + item.producing
  const theoreticalStock = item.warehouseStock + inTransitStock
  const redLineStock = strategyAvailable ? item.weeklyUsage * factors.redLine : null
  const normalStock = strategyAvailable ? item.weeklyUsage * factors.normal : null
  const peakStock = strategyAvailable ? item.weeklyUsage * factors.peak : null
  const shortage = strategyAvailable ? normalStock - theoreticalStock : null
  const urgency = getUrgency(theoreticalStock, redLineStock, normalStock, peakStock)

  return {
    ...item,
    redLineFactor: factors.redLine,
    normalFactor: factors.normal,
    peakFactor: factors.peak,
    redLineStock,
    normalStock,
    peakStock,
    inTransitStock,
    theoreticalStock,
    shortage,
    shortageRate:
      !strategyAvailable || normalStock === 0 ? null : (shortage / normalStock) * 100,
    stockSalesRatio:
      item.weeklyUsage === 0 ? null : item.warehouseStock / item.weeklyUsage,
    strategyAvailable,
    urgencyText: urgency.text,
    urgencyTone: urgency.tone,
  }
}

function getUrgency(theoreticalStock, redLineStock, normalStock, peakStock) {
  if (redLineStock === null || normalStock === null || peakStock === null) {
    return { text: '规则缺省', tone: 'unavailable' }
  }

  if (theoreticalStock < redLineStock) {
    return { text: '紧急补货', tone: 'red' }
  }
  if (theoreticalStock > peakStock) {
    return { text: '降低库存', tone: 'purple' }
  }
  if (theoreticalStock >= normalStock * 0.8 && theoreticalStock <= normalStock * 1.2) {
    return { text: '无需补货', tone: 'green' }
  }
  return { text: '常规补货', tone: 'yellow' }
}

export function formatQuantity(value) {
  if (value === null) return '缺省'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function formatRate(value, strategyAvailable) {
  if (!strategyAvailable) return '缺省'
  return value === null ? '--' : `${value.toFixed(2)}%`
}

export function formatRatio(value) {
  return value === null ? '--' : value.toFixed(2)
}

export function formatFactors(row) {
  if (!row.strategyAvailable) return '缺省'
  return `${row.redLineFactor}/${row.normalFactor}/${row.peakFactor}`
}

export function formatProductEditorValue(product) {
  const match = product.match(/^(\d+[a-z]+)(.+)$/i)
  return match ? `${match[1]}\n${match[2]}` : product
}

export function normalizeProductName(product) {
  return product.replace(/\s+/g, '').trim()
}
