// 备货计算：库存与销量统一用「公斤」比较。
// 库存里只有「在仓库存」是 SKU 自己的单位（码或公斤），乘以公斤系数换成公斤；
// 在途库存取生产排单的「进仓重量」，本来就是公斤；需安排由人工按公斤填写。
// 热销 / 常规按「够卖多少天」比较（日库销比），按量按库存公斤数直接比较。

function resolveIssue(item, kgFactor) {
  if (item.excluded) {
    // 订单货只是「不做预测」，数量和预警都不算，但照常进采购清单下单。
    if (item.manualBehavior === 'order') {
      return {
        long: '订单货：按客户订单填量，不参与预警与评分',
        short: '订单货',
      }
    }
    return {
      long: `${item.modeLabel || item.modeName || '该模式'}：不参与备货计算`,
      short: item.exclusive ? '专属品' : item.modeName || '不参与',
    }
  }
  if (!item.modeParticipates || (item.modeMetric ?? 'none') === 'none') {
    return { long: '未命中可计算的模式', short: '未命中' }
  }
  if (!item.stockingCoefficients) {
    return item.category
      ? { long: `该模式未配置「${item.category}」系数`, short: `缺${item.category}系数` }
      : { long: '色彩未填写，无法确定取黑白还是彩色系数', short: '色彩未填' }
  }
  if (!kgFactor) {
    return {
      long: '该 SKU 缺少出码率，无法把库存换算成公斤（请补齐出码率后重新清洗）',
      short: '缺出码率',
    }
  }
  return { long: '', short: '' }
}

// 预警灯只描述「当前指标相对三档的位置」，纯给人看：
// 低于红线 → 紧急补货；高于峰值 → 降低库存；正常 ±20% → 无需补货；其余常规补货。
function getUrgency(indicator, coefficients) {
  if (indicator === null || Number.isNaN(indicator)) {
    return { text: '模式缺省', tone: 'unavailable' }
  }
  if (indicator < coefficients.redLine) return { text: '紧急补货', tone: 'red' }
  if (indicator > coefficients.peak) return { text: '降低库存', tone: 'purple' }
  if (indicator >= coefficients.normal * 0.8 && indicator <= coefficients.normal * 1.2) {
    return { text: '无需补货', tone: 'green' }
  }
  return { text: '常规补货', tone: 'yellow' }
}

export function calculateInventoryRow(item) {
  const kgFactor =
    Number.isFinite(item.kgFactor) && item.kgFactor > 0 ? item.kgFactor : null
  // 需安排：人工按公斤填写
  const planned = item.planned ?? 0
  const turnoverIn = item.turnoverIn ?? 0
  // 在途库存 = 生产排单的进仓重量（公斤）；未提供该字段的旧数据按“生产中”兜底。
  const inTransitStock = Number.isFinite(item.inTransitStock)
    ? item.inTransitStock
    : item.producing
  // 在仓库存是 SKU 自己的单位（码或公斤）→ 换算成公斤
  const warehouseKg = kgFactor ? item.warehouseStock * kgFactor : null
  // 理论库存是事实层：只由导入数据派生（公斤）
  const theoreticalStock = warehouseKg === null ? null : warehouseKg + inTransitStock
  // 预计库存是评估层：事实层叠加“已采纳的需安排”（公斤）
  const projectedStock = theoreticalStock === null ? null : theoreticalStock + planned

  const metric = item.modeMetric ?? 'none'
  const coefficients = item.stockingCoefficients ?? null
  const dailySales = Number.isFinite(item.dailySales) ? item.dailySales : null

  const issue = resolveIssue(item, kgFactor)
  const strategyAvailable = issue.long === ''

  let redLineStock = null
  let normalStock = null
  let peakStock = null
  let indicator = null

  if (strategyAvailable) {
    if (metric === 'days') {
      // 日库销比 = 库存公斤 ÷ 日销量（公斤）；销量为 0 时视为无限大天数。
      indicator = dailySales > 0 ? projectedStock / dailySales : Number.POSITIVE_INFINITY
      redLineStock = coefficients.redLine * dailySales
      normalStock = coefficients.normal * dailySales
      peakStock = coefficients.peak * dailySales
    } else {
      // 按量模式：系数本身就是公斤
      indicator = projectedStock
      redLineStock = coefficients.redLine
      normalStock = coefficients.normal
      peakStock = coefficients.peak
    }
  }

  const shortage = strategyAvailable ? normalStock - projectedStock : null

  const urgency = item.excluded
    ? { text: item.manualBehavior === 'order' ? '订单货' : '不参与', tone: 'unavailable' }
    : strategyAvailable
      ? getUrgency(indicator, coefficients)
      : { text: '模式缺省', tone: 'unavailable' }

  return {
    ...item,
    dailySales,
    kgFactor,
    warehouseKg,
    // 系数原样透出：天数模式是「天」，按量 / 手动自定是「公斤」。
    redLineFactor: strategyAvailable ? coefficients.redLine : null,
    normalFactor: strategyAvailable ? coefficients.normal : null,
    peakFactor: strategyAvailable ? coefficients.peak : null,
    redLineStock,
    normalStock,
    peakStock,
    turnoverIn,
    inTransitStock,
    theoreticalStock,
    projectedStock,
    daysOfStock: indicator,
    shortage,
    shortageRate:
      !strategyAvailable || !normalStock ? null : (shortage / normalStock) * 100,
    strategyAvailable,
    strategyIssue: issue.long,
    strategyIssueShort: issue.short,
    excluded: Boolean(item.excluded),
    urgencyText: urgency.text,
    urgencyTone: urgency.tone,
  }
}

// 建议需安排（公斤）：补到「正常库存 80% 下限」的差额，基于理论库存。
export function getSuggestedPlanned(row) {
  if (!row?.strategyAvailable) return 0
  return Math.max(0, Math.ceil(row.normalStock * 0.8 - row.theoreticalStock))
}

export function formatQuantity(value) {  if (value === null || value === undefined) return '缺省'
  if (!Number.isFinite(value)) return '∞'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function formatRate(value, strategyAvailable) {
  if (!strategyAvailable) return '缺省'
  return value === null ? '--' : `${value.toFixed(2)}%`
}

export function formatRatio(value) {
  if (value === null || value === undefined) return '--'
  if (!Number.isFinite(value)) return '∞'
  return value.toFixed(2)
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
