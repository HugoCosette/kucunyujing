// 备货系数由 stocking 模块按「模式 × 评分档 × 色彩」给出，这里只负责库存与预警计算。
export function calculateInventoryRow(item) {
  const coefficientSet = item.stockingCoefficients ?? null
  const weeklyUsage = Number.isFinite(item.weeklyUsage) ? item.weeklyUsage : 0
  // 兜底只解决“归到哪条模式、哪个评分档”，还要能按色彩类别取到三档系数、且周消耗大于 0。
  const ruleFactors = coefficientSet?.[item.category] ?? null

  let strategyIssue = ''
  let strategyIssueShort = ''
  const slow = Boolean(item.strategySlow)
  if (slow) {
    strategyIssue = '滞销模式：不参与备货排名、预警与补货建议'
    strategyIssueShort = '滞销'
  } else if (!coefficientSet) {
    strategyIssue = '未命中任何模式档位'
    strategyIssueShort = '未命中档位'
  } else if (!ruleFactors) {
    if (item.category) {
      strategyIssue = `该评分档未配置「${item.category}」系数`
      strategyIssueShort = `缺${item.category}系数`
    } else {
      strategyIssue = '色彩未填写，无法确定取黑白还是彩色系数'
      strategyIssueShort = '色彩未填'
    }
  } else if (!Object.values(ruleFactors).every(Number.isFinite)) {
    strategyIssue = '红线 / 正常 / 峰值系数未填写完整'
    strategyIssueShort = '系数未填全'
  } else if (weeklyUsage <= 0) {
    strategyIssue = '周消耗为 0，备货库存无法计算'
    strategyIssueShort = '周消耗为0'
  }

  const strategyAvailable = strategyIssue === ''
  const factors = strategyAvailable
    ? ruleFactors
    : { redLine: null, normal: null, peak: null }
  const planned = item.planned ?? 0
  const turnoverIn = item.turnoverIn ?? 0
  // 在途库存为导入/录入值；未提供该字段的旧数据按“生产中”兜底。
  const inTransitStock = Number.isFinite(item.inTransitStock)
    ? item.inTransitStock
    : item.producing
  // 理论库存是事实层：只由导入数据派生。
  const theoreticalStock = item.warehouseStock + inTransitStock
  // 预计库存是评估层：事实层叠加“已采纳的需安排”，供使用者评估补货后结果。
  const projectedStock = theoreticalStock + planned
  const redLineStock = strategyAvailable ? weeklyUsage * factors.redLine : null
  const normalStock = strategyAvailable ? weeklyUsage * factors.normal : null
  const peakStock = strategyAvailable ? weeklyUsage * factors.peak : null
  const shortage = strategyAvailable ? normalStock - projectedStock : null
  const urgency = slow
    ? { text: '滞销', tone: 'unavailable' }
    : getUrgency(projectedStock, redLineStock, normalStock, peakStock)

  return {
    ...item,
    redLineFactor: factors.redLine,
    normalFactor: factors.normal,
    peakFactor: factors.peak,
    redLineStock,
    normalStock,
    peakStock,
    turnoverIn,
    inTransitStock,
    theoreticalStock,
    projectedStock,
    shortage,
    shortageRate:
      !strategyAvailable || normalStock === 0 ? null : (shortage / normalStock) * 100,
    stockSalesRatio: weeklyUsage === 0 || slow ? null : item.warehouseStock / weeklyUsage,
    strategyAvailable,
    strategyIssue,
    strategyIssueShort,
    strategySlow: slow,
    urgencyText: urgency.text,
    urgencyTone: urgency.tone,
  }
}

function getUrgency(theoreticalStock, redLineStock, normalStock, peakStock) {
  if (redLineStock === null || normalStock === null || peakStock === null) {
    return { text: '模式缺省', tone: 'unavailable' }
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
  if (row.strategySlow) return '滞销'
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

// 唯一标识是总表与销售表唯一的关联键；缺失时按空串处理，导入阶段已拦截。
export function normalizeSkuId(value) {
  return String(value ?? '').trim()
}
