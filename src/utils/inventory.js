// 备货计算：库存与销量统一用「公斤」比较。
// 库存里「在仓库存」是 SKU 自己的单位（码或公斤），乘以公斤系数换成公斤；
// 生产中取生产排单的「进仓重量」，本来就是公斤；需安排由人工按公斤填写。
// 热销 / 常规按「够卖多少天」比较（日库销比），按量按库存公斤数直接比较。

export function composeProductColorSkuId(product, color) {
  return `${String(product ?? '').trim()}|${String(color ?? '').trim()}`
}

function resolveIssue(item, kgFactor) {
  if (item.excluded) {
    // 订单货只是「不做预测」，数量和预警都不算，但照常进采购下单面板。
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
// < 红线 → 紧急补货；> 峰值 → 降低库存；≥ 正常 × 80%（且没超峰值）→ 无需补货；其余常规补货。
// 绿区上沿取「峰值」而不是「正常 × 120%」：需安排直接进预计库存，加量必须单调变好 ——
// 上沿若停在 1.2 × 正常，已补到位的行再加点量就会从绿掉回黄，还顶着「常规补货」的文案，
// 而实际含义是「已超目标、暂时别加」，方向读反了。
function getUrgency(indicator, coefficients) {
  if (indicator === null || Number.isNaN(indicator)) {
    return { text: '模式缺省', tone: 'unavailable' }
  }
  if (indicator < coefficients.redLine) return { text: '紧急补货', tone: 'red' }
  if (indicator > coefficients.peak) return { text: '降低库存', tone: 'purple' }
  if (indicator >= coefficients.normal * 0.8) return { text: '无需补货', tone: 'green' }
  return { text: '常规补货', tone: 'yellow' }
}

export function calculateInventoryRow(item) {
  const kgFactor =
    Number.isFinite(item.kgFactor) && item.kgFactor > 0 ? item.kgFactor : null
  // 需安排：人工按公斤填写（锁定态才算有效计划，未锁的草稿由页面另行展示）
  const planned = item.planned ?? 0
  // 采购执行层：累计下单 / 到货来自订单流水（只统计 active），三列互为校验：累计下单 = 待收 + 到货。
  const ordered = Number(item.ordered) > 0 ? Number(item.ordered) : 0
  const received = Number(item.received) > 0 ? Number(item.received) : 0
  const pendingOrder = Math.max(0, ordered - received)
  const turnoverIn = item.turnoverIn ?? 0
  // 生产中（原始）= 生产排单的进仓重量（公斤，累计流水）：新导入写在 producing，旧数据写在 inTransitStock 时优先取它。
  const inTransitStock = Number.isFinite(item.inTransitStock)
    ? item.inTransitStock
    : Number.isFinite(item.producing)
      ? item.producing
      : 0
  // 在仓库存是 SKU 自己的单位（码或公斤）→ 换算成公斤
  const warehouseKg = kgFactor ? item.warehouseStock * kgFactor : null
  // 在途（新口径）：调用方按 skuId 对账后传入 inTransitKg 时，预计库存 = 在仓 + 在途 + 需安排。
  // 排单（producing）与累计下单（ordered）已经算进在途，这里不再单独相加，避免同一批货算两遍。
  // 没传 inTransitKg 时保持旧口径（理论库存 + 累积下单 + 需安排），确保旧调用方行为不变。
  const inTransitKg = Number.isFinite(item.inTransitKg) ? Math.max(0, item.inTransitKg) : null
  const producingKg = Number.isFinite(item.producingKg) ? Math.max(0, item.producingKg) : null
  const arrangedKg = Number.isFinite(item.arrangedKg) ? Math.max(0, item.arrangedKg) : null
  // 理论库存 = 在仓 + 在途（也就是「预计库存 − 需安排」），与「在途 = 已安排 + 生产中」同一套口径。
  // 不能再用生产排单的原始累计：排单是只增不减的流水，滚动导入后已入库的那批货还留在表里，
  // 理论库存会虚高（例：D3 到仓 500 之后 = 在仓 1500 + 排单 500 = 2000）。没有对账值时退回旧口径。
  const theoreticalStock =
    warehouseKg === null
      ? null
      : warehouseKg + (inTransitKg === null ? inTransitStock : inTransitKg)
  // 预计库存 = 在仓kg + 在途 + 锁定需安排 = 理论库存 + 需安排。
  // 旧口径写成「待收 + 到货」与「累计下单」等价（待收 = 累计下单 − 到货）：到货时一减一增，合计不变，
  // 所以登记 / 撤销到货不会让预计库存跳动；超收（到货 > 累计下单）时也能把已到的货如实算进来。
  const projectedStock =
    theoreticalStock === null
      ? null
      : inTransitKg === null
        ? theoreticalStock + pendingOrder + received + planned
        : theoreticalStock + planned

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
    ordered,
    received,
    pendingOrder,
    // 新口径（调用方传了 inTransitKg 时才有值）：在途 = 已安排 + 生产中
    inTransitKg,
    producingKg,
    arrangedKg,
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

// 建议需安排（公斤）：补到「正常库存」（绿区中位）的差额。
// 新口径：基于在仓 + 在途（在途已含累积下单与排单在产），不会把同一批货扣两遍。
// 旧口径（没有 inTransitKg 时）：基于理论库存，累积下单算作即将到货先扣掉。
export function getSuggestedPlanned(row) {
  if (!row?.strategyAvailable) return 0
  if (Number.isFinite(row.inTransitKg)) {
    return Math.max(0, Math.ceil(row.normalStock - (Number(row.warehouseKg) || 0) - row.inTransitKg))
  }
  const incoming = Number(row.ordered) > 0 ? Number(row.ordered) : 0
  return Math.max(0, Math.ceil(row.normalStock - row.theoreticalStock - incoming))
}

// 表格展示口径：数量一律取整到整数（不出现小数），缺省与无穷大保留文字。
export function formatQuantity(value) {
  if (value === null || value === undefined) return '缺省'
  if (!Number.isFinite(value)) return '∞'
  return String(Math.round(value))
}

export function formatRate(value, strategyAvailable) {
  if (!strategyAvailable) return '缺省'
  return value === null ? '--' : `${Math.round(value)}%`
}

export function formatRatio(value) {
  if (value === null || value === undefined) return '--'
  if (!Number.isFinite(value)) return '∞'
  return String(Math.round(value))
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
