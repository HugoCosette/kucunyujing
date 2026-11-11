// SKU 健康度评分：5 个维度各自配「高 / 中 / 低」三条风险区间与权重，
// 命中哪条区间就取对应档位的得分，再加权成综合分。
// 这里只做口径计算，不依赖 Vue 与 store：SKU 弹窗负责展示，配置页负责改参数。

// 同时也是展示顺序：低 → 中 → 高（区间从宽松到紧张）。
export const SCORING_TIERS = ['low', 'mid', 'high']

export const SCORING_TIER_LABELS = {
  high: '高风险',
  mid: '中风险',
  low: '低风险',
}

export const SCORING_TIER_TONES = {
  high: 'red',
  mid: 'yellow',
  low: 'green',
}

// 区间重叠时按「中风险优先」匹配：中风险通常代表正常范围，端点落在两档之间时归中风险。
const TIER_MATCH_ORDER = ['mid', 'high', 'low']

export const SCORING_DIMENSIONS = [
  { key: 'cr5', label: '客户数 CR5', unit: '%', decimals: 1 },
  { key: 'customers', label: '累计客户数', unit: '个', decimals: 0 },
  { key: 'growth', label: '销售环比率', unit: '%', decimals: 1 },
  { key: 'ratio', label: '本次进销比', unit: '%', decimals: 1 },
  { key: 'consumption', label: '预估月消耗', unit: '条', decimals: 1 },
]

const SCORING_DEFAULTS = {
  scores: { high: 40, mid: 60, low: 80 },
  total: { midFrom: 50, midTo: 70 },
  dimensions: {
    cr5: { weight: 15, ranges: { high: [60, null], mid: [40, 60], low: [0, 40] } },
    customers: { weight: 10, ranges: { high: [0, 10], mid: [11, 20], low: [21, null] } },
    growth: { weight: 20, ranges: { high: [null, -10], mid: [-10, 10], low: [10, null] } },
    ratio: { weight: 30, ranges: { high: [30, null], mid: [20, 30], low: [0, 20] } },
    consumption: { weight: 25, ranges: { high: [0, null], mid: [0, 0], low: [null, 0] } },
  },
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toNonNegative(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

// 区间端点：缺字段按默认，显式留空（null / 空串）表示不限。
function toOptionalNumber(value, fallback) {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function createDefaultRanges(definition) {
  return Object.fromEntries(
    SCORING_TIERS.map((tier) => {
      const [from, to] = SCORING_DEFAULTS.dimensions[definition.key].ranges[tier]
      return [tier, { from, to }]
    }),
  )
}

function normalizeRanges(source, definition) {
  const defaults = createDefaultRanges(definition)
  const input = isPlainObject(source) ? source : {}
  return Object.fromEntries(
    SCORING_TIERS.map((tier) => {
      const entry = isPlainObject(input[tier]) ? input[tier] : {}
      return [
        tier,
        {
          from: toOptionalNumber(entry.from, defaults[tier].from),
          to: toOptionalNumber(entry.to, defaults[tier].to),
        },
      ]
    }),
  )
}

export function createDefaultScoring() {
  return {
    scores: { ...SCORING_DEFAULTS.scores },
    total: { ...SCORING_DEFAULTS.total },
    dimensions: Object.fromEntries(
      SCORING_DIMENSIONS.map((definition) => [
        definition.key,
        {
          weight: SCORING_DEFAULTS.dimensions[definition.key].weight,
          ranges: createDefaultRanges(definition),
        },
      ]),
    ),
  }
}

export function normalizeScoring(source) {
  const defaults = createDefaultScoring()
  const input = isPlainObject(source) ? source : {}
  const scores = isPlainObject(input.scores) ? input.scores : {}
  const total = isPlainObject(input.total) ? input.total : {}
  const dimensions = isPlainObject(input.dimensions) ? input.dimensions : {}

  return {
    scores: {
      high: toNonNegative(scores.high, defaults.scores.high),
      mid: toNonNegative(scores.mid, defaults.scores.mid),
      low: toNonNegative(scores.low, defaults.scores.low),
    },
    total: {
      midFrom: toOptionalNumber(total.midFrom, defaults.total.midFrom),
      midTo: toOptionalNumber(total.midTo, defaults.total.midTo),
    },
    dimensions: Object.fromEntries(
      SCORING_DIMENSIONS.map((definition) => {
        const entry = isPlainObject(dimensions[definition.key])
          ? dimensions[definition.key]
          : {}
        return [
          definition.key,
          {
            weight: toNonNegative(entry.weight, defaults.dimensions[definition.key].weight),
            ranges: normalizeRanges(entry.ranges, definition),
          },
        ]
      }),
    ),
  }
}

export function validateScoring(source) {
  const scoring = normalizeScoring(source)
  const errors = []
  let weightTotal = 0

  for (const definition of SCORING_DIMENSIONS) {
    const entry = scoring.dimensions[definition.key]
    weightTotal += entry.weight
    for (const tier of SCORING_TIERS) {
      const band = entry.ranges[tier]
      if (band.from !== null && band.to !== null && band.from > band.to) {
        errors.push({
          message: `评分 · ${definition.label} · ${SCORING_TIER_LABELS[tier]}：区间下界不能大于上界（${band.from} > ${band.to}）`,
        })
      }
    }
  }

  if (!(weightTotal > 0)) {
    errors.push({ message: '评分：5 个维度的权重合计必须大于 0' })
  }
  if (
    scoring.total.midFrom !== null &&
    scoring.total.midTo !== null &&
    scoring.total.midFrom > scoring.total.midTo
  ) {
    errors.push({
      message: `评分：综合评分区间下界不能大于上界（${scoring.total.midFrom} > ${scoring.total.midTo}）`,
    })
  }

  return errors
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function formatNumber(value, decimals) {
  if (!Number.isFinite(value)) return '--'
  return decimals > 0 ? String(roundTo(value, decimals)) : String(Math.round(value))
}

function formatValue(value, definition) {
  const text = formatNumber(value, definition.decimals)
  return definition.unit === '%' ? `${text}%` : `${text} ${definition.unit}`
}

function formatBound(value, definition) {
  if (value === null) return '不限'
  const text = formatNumber(value, 2)
  return definition.unit === '%' ? `${text}%` : `${text} ${definition.unit}`
}

// 单条区间的展示文案：不限 / ≤ x / ≥ x / = x / a ~ b。
export function describeScoringBand(band, definition) {
  const from = band?.from ?? null
  const to = band?.to ?? null
  if (from === null && to === null) return '不限'
  if (from === null) return `≤ ${formatBound(to, definition)}`
  if (to === null) return `≥ ${formatBound(from, definition)}`
  if (from === to) return `= ${formatBound(from, definition)}`
  return `${formatBound(from, definition)} ~ ${formatBound(to, definition)}`
}

export function describeScoringRanges(entry, definition) {
  return SCORING_TIERS.map(
    (tier) => `${SCORING_TIER_LABELS[tier]} ${describeScoringBand(entry.ranges[tier], definition)}`,
  ).join(' · ')
}

// 「本期 / 上期」严格按打开系统的日期：≥26 号取「本月 vs 上月」，≤25 号取「上月 vs 前月」。
// 1 月时上期会落到去年 12 月 / 11 月，销售表只含本年 1-12 月，按「无数据」处理。
export function resolveGrowthMonths(now = new Date()) {
  const month = now.getMonth() + 1
  const current = now.getDate() >= 26 ? month : month - 1
  return { current, previous: current - 1 }
}

function growthMonthLabel(month) {
  return month >= 1 ? `${month} 月` : `去年 ${12 + month} 月`
}

function readMonthSales(counts, month) {
  if (!Array.isArray(counts) || month < 1 || month > counts.length) return null
  const raw = counts[month - 1]
  if (raw === null || raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

// 环比增长率 = (本期 - 上期) ÷ 上期；一个月的数据缺失时返回 null。
// 上期为 0、本期有销量按 +100% 处理；上期有销量、本期为 0 按 0% 处理；
// 两期都为 0 时没有比较基础，仍按无数据处理。
export function computeGrowthRate(counts, now = new Date()) {
  const { current, previous } = resolveGrowthMonths(now)
  const currentValue = readMonthSales(counts, current)
  const previousValue = readMonthSales(counts, previous)
  if (currentValue === null || previousValue === null) return null
  if (previousValue === 0) return currentValue > 0 ? 100 : null
  if (currentValue === 0) return 0
  return ((currentValue - previousValue) / previousValue) * 100
}

// 环比说明文案：有数据时写清比的是哪两个月，没数据时写清缺哪个月。
function describeGrowth(counts, now) {
  const { current, previous } = resolveGrowthMonths(now)
  if (current < 1) {
    return `缺${growthMonthLabel(current)}、${growthMonthLabel(previous)}销量（跨年数据不在本年 1-12 月内）`
  }
  if (previous < 1) {
    return `缺${growthMonthLabel(previous)}销量（跨年数据不在本年 1-12 月内）`
  }
  if (!Array.isArray(counts)) return `缺 ${current} 月、${previous} 月销量（未导入销售表）`

  const currentValue = readMonthSales(counts, current)
  const previousValue = readMonthSales(counts, previous)
  if (currentValue === null) return `缺 ${current} 月销量`
  if (previousValue === null) return `缺 ${previous} 月销量`
  if (previousValue === 0 && currentValue === 0) {
    return `${current} 月、${previous} 月销量都为 0，无法计算环比`
  }
  if (previousValue === 0) {
    return `${current} 月 vs ${previous} 月：100%（${previous} 月销量为 0，按 100% 计；${current} 月 ${formatNumber(
      currentValue,
      2,
    )} 公斤）`
  }
  if (currentValue === 0) {
    return `${current} 月 vs ${previous} 月：0%（${current} 月销量为 0，按 0% 计；${previous} 月 ${formatNumber(
      previousValue,
      2,
    )} 公斤）`
  }

  const rate = ((currentValue - previousValue) / previousValue) * 100
  return `${current} 月 vs ${previous} 月：${formatNumber(rate, 1)}%（${current} 月 ${formatNumber(
    currentValue,
    2,
  )} 公斤 ÷ ${previous} 月 ${formatNumber(previousValue, 2)} 公斤）`
}

// 留空的端点按不限（-∞ / +∞）处理；三条区间都没命中时按中风险兜底。
function tierOf(value, entry) {
  for (const tier of TIER_MATCH_ORDER) {
    const band = entry.ranges[tier]
    const from = band.from ?? Number.NEGATIVE_INFINITY
    const to = band.to ?? Number.POSITIVE_INFINITY
    if (value >= from && value <= to) return tier
  }
  return 'mid'
}

function readMetrics(metrics, now) {
  const monthlySales = Number(metrics.monthlySales) // 加权月销量（公斤）
  const suggestedQuantity = Number(metrics.suggestedQuantity) // 建议需安排（公斤）
  const theoreticalStock = Number(metrics.theoreticalStock) // 理论库存（公斤）
    // 累积销量（公斤，全历史）：进销比的分母，取清洗输出的「累积销量」
  const cumulativeSales = Number(metrics.cumulativeSales)
  const cr5 = metrics.cr5 === null || metrics.cr5 === undefined ? null : Number(metrics.cr5)
  const customers =
    metrics.activeCustomers === null || metrics.activeCustomers === undefined
      ? null
      : Number(metrics.activeCustomers)

  const suggestedKg = Number.isFinite(suggestedQuantity) ? suggestedQuantity : null
  const projectedKg =
    Number.isFinite(suggestedQuantity) && Number.isFinite(theoreticalStock)
      ? theoreticalStock + suggestedQuantity
      : null

  return {
    values: {
      cr5: Number.isFinite(cr5) ? cr5 * 100 : null,
      customers: Number.isFinite(customers) ? customers : null,
      growth: computeGrowthRate(metrics.sales, now),
      ratio:
        Number.isFinite(cumulativeSales) && cumulativeSales > 0 && Number.isFinite(suggestedKg)
          ? (suggestedKg / cumulativeSales) * 100
          : null,
      consumption:
        Number.isFinite(monthlySales) && Number.isFinite(projectedKg)
          ? monthlySales - projectedKg
          : null,
    },
    detail: {
      suggestedKg,
      projectedKg,
      monthlySales: Number.isFinite(monthlySales) ? monthlySales : null,
      cumulativeSales: Number.isFinite(cumulativeSales) ? cumulativeSales : null,
      growthText: describeGrowth(metrics.sales, now),
    },
  }
}

const MISSING_DETAILS = {
  cr5: '未导入客户 CR5 率',
  customers: '未导入累计客户数',
  growth: '缺少连续两个月的销量',
  ratio: '缺少建议补货量或累积销量',
  consumption: '缺少加权月销量或库存数据',
}

function buildDetail(key, value, detail) {
  // 环比无论有没有算出来，都要说清比的是哪两个月 / 缺哪个月。
  if (key === 'growth') return detail.growthText ?? MISSING_DETAILS.growth
  if (!Number.isFinite(value)) return MISSING_DETAILS[key] ?? '无数据'

  switch (key) {
    case 'cr5':
      return `前 5 客户销量占比 ${formatNumber(value, 1)}%`
    case 'customers':
      return `累计客户 ${formatNumber(value, 0)} 个`
    case 'ratio':
      return `建议补货 ${formatNumber(detail.suggestedKg, 2)} 公斤 ÷ 累积销量 ${formatNumber(
        detail.cumulativeSales,
        2,
      )} 公斤`
    case 'consumption':
      return `加权月销 ${formatNumber(detail.monthlySales, 2)} 公斤 − 预计库存 ${formatNumber(
        detail.projectedKg,
        2,
      )} 公斤`
    default:
      return ''
  }
}

// participates = false（专属品 / 尾货 / 滞销 / 模式缺省）时整块显示「不参与」，不产生综合分。
export function evaluateScoring({
  config,
  metrics = {},
  participates = true,
  now = new Date(),
}) {
  if (!participates) {
    return { participates: false, total: null, tone: 'unavailable', toneLabel: '不参与', dimensions: [] }
  }

  const scoring = normalizeScoring(config)
  const { values, detail } = readMetrics(metrics, now)

  const dimensions = SCORING_DIMENSIONS.map((definition) => {
    const entry = scoring.dimensions[definition.key]
    const raw = values[definition.key]
    const available = Number.isFinite(raw)
    const value = available ? roundTo(raw, definition.decimals) : null
    const tier = available ? tierOf(value, entry) : null
    const score = tier ? scoring.scores[tier] : null

    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      weight: entry.weight,
      weightText: `${formatNumber(entry.weight, 2)}%`,
      rangesText: describeScoringRanges(entry, definition),
      value,
      valueText: available ? formatValue(value, definition) : '无数据',
      tier,
      tierLabel: tier ? SCORING_TIER_LABELS[tier] : '无数据',
      tierRangeText: tier ? describeScoringBand(entry.ranges[tier], definition) : '',
      tone: tier ? SCORING_TIER_TONES[tier] : 'unavailable',
      score,
      scoreText: available ? formatNumber(score, 0) : '--',
      available,
      detail: buildDetail(definition.key, value, detail),
    }
  })

  const active = dimensions.filter((dimension) => dimension.available)
  const weightTotal = active.reduce((sum, dimension) => sum + dimension.weight, 0)
  const total =
    weightTotal > 0
      ? roundTo(
          active.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) /
            weightTotal,
          1,
        )
      : null

  const midFrom = scoring.total.midFrom ?? 0
  const midTo = scoring.total.midTo ?? Number.POSITIVE_INFINITY
  const tone =
    total === null ? 'unavailable' : total < midFrom ? 'red' : total <= midTo ? 'yellow' : 'green'

  return {
    participates: true,
    total,
    totalText: total === null ? '--' : formatNumber(total, 1),
    tone,
    toneLabel:
      tone === 'red' ? '高风险' : tone === 'yellow' ? '中风险' : tone === 'green' ? '低风险' : '数据不足',
    weightTotal,
    missing: dimensions.filter((dimension) => !dimension.available).length,
    dimensions,
  }
}

// —— 按量模式专属健康度：只判「本次进销比」与「累积客户数」两项，不做综合评分 ——
// 本次进销比沿用 5 维评分里的同一口径（建议补货 ÷ 累积销量），按量模式下低于下界低风险、
// 区间内正常、高于上界高风险；累积客户数少于下界高风险、区间内中风险、多于上界低风险。
// 两个区间都存在方案里「按量」模式的 healthScoring 段，配置页可改。
export const BULK_SCORING_DEFAULTS = {
  ratio: { normalFrom: 40, normalTo: 60 },
  customers: { normalFrom: 5, normalTo: 10 },
}

export const BULK_SCORING_DIMENSIONS = [
  { key: 'ratio', label: '本次进销比', unit: '%', decimals: 1 },
  { key: 'customers', label: '累积客户数', unit: '个', decimals: 0 },
]

const BULK_TIER_META = {
  normal: { label: '正常', tone: 'green' },
  high: { label: SCORING_TIER_LABELS.high, tone: SCORING_TIER_TONES.high },
  mid: { label: SCORING_TIER_LABELS.mid, tone: SCORING_TIER_TONES.mid },
  low: { label: SCORING_TIER_LABELS.low, tone: SCORING_TIER_TONES.low },
}

function toBulkBound(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function normalizeBulkScoring(source) {
  const input = isPlainObject(source) ? source : {}
  const ratio = isPlainObject(input.ratio) ? input.ratio : {}
  const customers = isPlainObject(input.customers) ? input.customers : {}
  return {
    ratio: {
      normalFrom: toBulkBound(ratio.normalFrom, BULK_SCORING_DEFAULTS.ratio.normalFrom),
      normalTo: toBulkBound(ratio.normalTo, BULK_SCORING_DEFAULTS.ratio.normalTo),
    },
    customers: {
      normalFrom: toBulkBound(customers.normalFrom, BULK_SCORING_DEFAULTS.customers.normalFrom),
      normalTo: toBulkBound(customers.normalTo, BULK_SCORING_DEFAULTS.customers.normalTo),
    },
  }
}

export function validateBulkScoring(source) {
  const scoring = normalizeBulkScoring(source)
  const errors = []
  for (const [key, label] of [
    ['ratio', '本次进销比'],
    ['customers', '累积客户数'],
  ]) {
    const band = scoring[key]
    if (band.normalFrom > band.normalTo) {
      errors.push({
        message: `按量 · ${label}：正常区间下界不能大于上界（${band.normalFrom} > ${band.normalTo}）`,
      })
    }
  }
  return errors
}

function describeBulkRule(key, scoring) {
  const { normalFrom, normalTo } = scoring[key]
  if (key === 'ratio') {
    const from = `${formatNumber(normalFrom, 2)}%`
    const to = `${formatNumber(normalTo, 2)}%`
    return `低于 ${from} 低风险，${from} ~ ${to} 正常，高于 ${to} 高风险`
  }
  const from = formatNumber(normalFrom, 0)
  const to = formatNumber(normalTo, 0)
  return `${from} ~ ${to} 个中风险，少于 ${from} 个高风险，多于 ${to} 个低风险`
}

function resolveBulkTier(key, value, scoring) {
  const { normalFrom, normalTo } = scoring[key]
  if (key === 'ratio') {
    if (value < normalFrom) return 'low'
    return value <= normalTo ? 'normal' : 'high'
  }
  if (value < normalFrom) return 'high'
  return value <= normalTo ? 'mid' : 'low'
}

export function evaluateBulkScoring({
  metrics = {},
  participates = true,
  healthScoring = null,
  now = new Date(),
}) {
  if (!participates) {
    return {
      mode: 'bulk',
      participates: false,
      total: null,
      tone: 'unavailable',
      toneLabel: '不参与',
      dimensions: [],
    }
  }

  const scoring = normalizeBulkScoring(healthScoring)
  const { values, detail } = readMetrics(metrics, now)

  const dimensions = BULK_SCORING_DIMENSIONS.map((definition) => {
    const raw = values[definition.key]
    const available = Number.isFinite(raw)
    const value = available ? roundTo(raw, definition.decimals) : null
    const meta = available
      ? BULK_TIER_META[resolveBulkTier(definition.key, value, scoring)]
      : null

    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      value,
      valueText: available ? formatValue(value, definition) : '无数据',
      tierLabel: meta?.label ?? '无数据',
      tone: meta?.tone ?? 'unavailable',
      ruleText: describeBulkRule(definition.key, scoring),
      available,
      detail: buildDetail(definition.key, value, detail),
    }
  })

  return {
    mode: 'bulk',
    participates: true,
    total: null,
    tone: 'unavailable',
    toneLabel: '',
    missing: dimensions.filter((dimension) => !dimension.available).length,
    dimensions,
  }
}
