// 本次补货风险：三个因子各自落「低 / 中 / 高」档，以「中」为 0 点算净偏离再相加：
//   高 +1、中 0、低 −1；合计 > 0 高风险、= 0 中风险、< 0 低风险。
// 完全对称 —— 三项里比「中」多的和比「中」少的相抵，剩哪边就是哪档，不设权重、不设特例。
// 三个因子的口径都取现有的唯一实现：
//   日库销比（补货后）= calculateInventoryRow 的预警灯，与主面板「日库销比」列同一条判定；
//   综合评分 = evaluateRowHealth 的综合分档位（按量模式没有综合分，取两项判定里更差的一项）；
//   本次进销比（按填报）= 填报量 ÷ 累积销量，分档沿用评分因子的 ratio 区间。

import {
  SCORING_DIMENSIONS,
  SCORING_TIER_LABELS,
  describeBulkRule,
  describeScoringRanges,
  matchScoringTier,
  normalizeBulkScoring,
  normalizeScoring,
  resolveBulkTier,
} from './scoring.js'

// 档位 → 净偏离：以「中」为 0 点，往上为高、往下为低
export const REPLENISH_TIER_DEVIATION = { high: 1, mid: 0, low: -1 }

// 门槛：合计 ≥ 1 高、= 0 中、≤ −1 低（唯一来源，hover 里那句规则也读这里）
export const REPLENISH_RISK_THRESHOLDS = { high: 1, low: -1 }

export const REPLENISH_RISK_RULE_TEXT =
  '高 +1，中 0，低 −1；三项相加 > 0 高风险，= 0 中风险，< 0 低风险'

// 对外只出三档，档位名与配色在这里定
export const REPLENISH_RISK_LEVELS = {
  high: { label: '高风险', tone: 'red' },
  mid: { label: '中风险', tone: 'yellow' },
  low: { label: '低风险', tone: 'green' },
}

// 结论句按「日库销比方向 × 风险档」取；偏多与偏少动作相反，档位由净偏离定
const VERDICT_TITLES = {
  high: {
    over: '补货后库存偏多，建议下调',
    under: '补完仍不够卖，建议上调',
    off: '量偏离正常带，且另有偏高项，建议先调量再补',
    normal: '量落在正常带，但另两项净偏高，建议缩量或分批',
  },
  mid: {
    over: '补货后库存偏多，另两项偏弱，可小幅下调',
    under: '补完仍不够卖，另两项偏弱，可小幅上调',
    off: '量偏离正常带，另两项合计为 0，建议微调',
    normal: '量落在正常带，另两项都不突出，建议盯住',
  },
  low: {
    over: '补货后库存偏多，另两项都低，建议复核',
    under: '补完仍不够卖，另两项都低，建议复核',
    off: '量略偏离正常带，另两项都低',
    normal: '量落在正常带，可以补',
  },
}

const DAYS_STATE_BY_TONE = { green: 'normal', yellow: 'off', purple: 'over', red: 'under' }
const DAYS_STATE_LABELS = { normal: '正常带', off: '偏离', over: '偏多', under: '偏少' }
const TONE_BY_TIER = { high: 'red', mid: 'yellow', low: 'green' }
const TONE_RANK = { red: 3, yellow: 2, green: 1, unavailable: 0 }

function deviationOf(tier) {
  if (!tier) return 0
  return REPLENISH_TIER_DEVIATION[tier] ?? 0
}

function levelOfScore(score) {
  if (score >= REPLENISH_RISK_THRESHOLDS.high) return 'high'
  if (score <= REPLENISH_RISK_THRESHOLDS.low) return 'low'
  return 'mid'
}

// 带符号写法：+1 / 0 / −1（负号用 U+2212，跟卡面数字同一套字形）
function formatSigned(value) {
  const number = Number(value) || 0
  if (number > 0) return `+${number}`
  if (number < 0) return `−${Math.abs(number)}`
  return '0'
}

function formatInt(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return Math.round(number).toLocaleString('zh-CN')
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function tierOfTone(tone) {
  if (tone === 'red') return 'high'
  if (tone === 'yellow') return 'mid'
  if (tone === 'green') return 'low'
  return null
}

// 日库销比因子：状态（正常 / 偏离 / 偏多 / 偏少）直接取自预警灯，不另设阈值。
function buildQuantityFactor(row, state) {
  const isDays = row.modeMetric === 'days'
  const unit = isDays ? '天' : '公斤'
  const noun = isDays ? '日库销比' : '库存'
  const indicator = row.daysOfStock
  const available = Number.isFinite(indicator)
  const redLine = Number(row.redLineFactor)
  const normal = Number(row.normalFactor)
  const peak = Number(row.peakFactor)
  const lowBand = Number.isFinite(normal) ? Math.round(normal * 0.8) : null
  const highBand = Number.isFinite(normal) ? Math.round(normal * 1.2) : null
  const bandText =
    lowBand === null ? '' : `${formatInt(lowBand)} ~ ${formatInt(highBand)} ${unit}`

  let detail = `加权月销量为 0，${noun}按 ∞ 计，直接判库存偏多`
  if (available) {
    if (state === 'over') {
      detail = `补货后${noun}约 ${formatInt(indicator)} ${unit}，高于峰值 ${formatInt(peak)} ${unit}`
    } else if (state === 'under') {
      detail = `补货后${noun}约 ${formatInt(indicator)} ${unit}，低于红线 ${formatInt(redLine)} ${unit}`
    } else if (state === 'off') {
      detail = `补货后${noun}约 ${formatInt(indicator)} ${unit}，偏离正常带 ${bandText}`
    } else {
      detail = `补货后${noun}约 ${formatInt(indicator)} ${unit}，落在正常带 ${bandText}`
    }
  }

  const ruleText = isDays
    ? `红线 ${formatInt(redLine)} 天 / 正常 ${formatInt(normal)} 天 / 峰值 ${formatInt(peak)} 天`
    : `红线 ${formatInt(redLine)} 公斤 / 正常 ${formatInt(normal)} 公斤 / 峰值 ${formatInt(peak)} 公斤`

  const tier = state === 'normal' ? 'low' : state === 'off' ? 'mid' : 'high'
  return {
    key: 'quantity',
    label: isDays ? '日库销比' : '补货后库存',
    valueText: available ? `${formatInt(indicator)} ${unit}` : `∞ ${unit}`,
    tier,
    tierLabel: DAYS_STATE_LABELS[state],
    tone:
      state === 'normal' ? 'green' : state === 'off' ? 'yellow' : state === 'over' ? 'purple' : 'red',
    points: deviationOf(tier),
    detail,
    ruleText,
  }
}

// 综合评分因子：多维模式读综合分档位；按量模式没有综合分，取两项判定里更差的一项。
function buildHealthFactor(health, scoringConfig) {
  if (!health?.participates) return null

  if (health.mode === 'bulk') {
    const dimensions = health.dimensions ?? []
    if (!dimensions.length) return null
    const worst = dimensions.reduce(
      (picked, dimension) =>
        TONE_RANK[dimension.tone] > TONE_RANK[picked.tone] ? dimension : picked,
      dimensions[0],
    )
    const summary = dimensions
      .map((dimension) => `${dimension.label} ${dimension.valueText}（${dimension.tierLabel}）`)
      .join('、')
    const worstTier = tierOfTone(worst.tone)
    return {
      key: 'health',
      label: '按量健康度',
      valueText: worst.valueText,
      tier: worstTier,
      tierLabel: worst.tierLabel,
      tone: worst.tone,
      points: deviationOf(worstTier),
      detail: `按量取较差项 ${worst.label}：${summary}`,
      ruleText: '',
    }
  }

  if (
    typeof health.total !== 'number' ||
    !Number.isFinite(health.total) ||
    health.tone === 'unavailable'
  ) {
    return null
  }
  const scoring = normalizeScoring(scoringConfig)
  const midFrom = scoring.total.midFrom
  const midTo = scoring.total.midTo
  const tier = tierOfTone(health.tone)
  return {
    key: 'health',
    label: '综合评分',
    valueText: health.totalText,
    tier,
    tierLabel: health.toneLabel,
    tone: health.tone,
    points: deviationOf(tier),
    // 分数与档位 chip 上已经有了，浮层只补区间，不重复。
    detail: '',
    ruleText:
      midFrom === null || midTo === null
        ? ''
        : `低于 ${formatInt(midFrom)} 高风险，${formatInt(midFrom)} ~ ${formatInt(midTo)} 中风险，高于 ${formatInt(midTo)} 低风险`,
  }
}

// 本次进销比（按填报）：与评分因子同一条式子，只把分子从「建议值」换成填报量。
function buildRatioFactor({ quantity, cumulativeSales, scoringConfig, bulkHealthScoring, isBulk }) {
  const cumulative = Number(cumulativeSales)
  if (!Number.isFinite(cumulative) || cumulative <= 0) return null

  const value = roundTo((Number(quantity) / cumulative) * 100, 1)
  let tier
  let tierLabel
  let ruleText

  if (isBulk) {
    const scoring = normalizeBulkScoring(bulkHealthScoring)
    const bulkTier = resolveBulkTier('ratio', value, scoring)
    // 按量把「正常区间」当中风险档（不升级结论），但配色与按量健康度卡一致：正常为绿。
    tier = bulkTier === 'normal' ? 'mid' : bulkTier
    tierLabel = bulkTier === 'normal' ? '正常' : SCORING_TIER_LABELS[bulkTier]
    ruleText = describeBulkRule('ratio', scoring)
  } else {
    const scoring = normalizeScoring(scoringConfig)
    const entry = scoring.dimensions.ratio
    const definition = SCORING_DIMENSIONS.find((item) => item.key === 'ratio')
    tier = matchScoringTier(value, entry)
    tierLabel = SCORING_TIER_LABELS[tier]
    ruleText = describeScoringRanges(entry, definition)
  }

  return {
    key: 'ratio',
    label: '补货进销比',
    valueText: `${formatInt(value)}%`,
    tier,
    tierLabel,
    tone: isBulk && tierLabel === '正常' ? 'green' : TONE_BY_TIER[tier],
    points: deviationOf(tier),
    detail: `按 ${formatInt(quantity)} 公斤 ÷ 累积销量 ${formatInt(cumulative)} 公斤`,
    ruleText,
  }
}

// 动作句只给一句、带数字，长度按行内展示控制；没有明确动作就留空。
function buildSuggestion({ daysState, level, quantity, suggested }) {
  const target = Math.round(Number(suggested) || 0)

  if (daysState === 'over') {
    if (target <= 0) return '库存已够，建议不补'
    if (target < quantity) return `降到 ${formatInt(target)} 公斤`
    return ''
  }
  if (daysState === 'under') {
    // 补完仍偏少且另两项也不干净时，别鼓励一次补足
    if (level === 'high') return '先小批试补，别一次补到建议值'
    if (target > quantity) return `补到 ${formatInt(target)} 公斤`
    return ''
  }
  if (daysState === 'off') {
    if (target > 0 && target !== quantity) return `对齐 ${formatInt(target)} 公斤`
    return ''
  }
  if (level === 'high') return '分批下单或缩量'
  return ''
}

function unavailableResult({ previewRow }) {
  let title
  if (previewRow?.manualBehavior === 'order') {
    title = '订单货：按客户订单填量，不评估补货风险'
  } else if (previewRow?.excluded) {
    title = '该 SKU 不参与备货计算，不评估补货风险'
  } else if (!previewRow?.strategyAvailable) {
    title = '模式缺省或缺少系数，无法评估补货风险'
  } else {
    title = '缺少库存或销量数据，无法评估补货风险'
  }
  return {
    available: false,
    level: 'unavailable',
    riskLabel: '不参与',
    tone: 'unavailable',
    score: 0,
    scoreText: '',
    ruleText: '',
    title,
    suggestion: '',
    factors: [],
  }
}

/**
 * @param {object} input
 * @param {number} input.planned 本次要补的公斤数（已按「填报 → 已采纳 → 建议值」解析）
 * @param {object} input.previewRow calculateInventoryRow({...item, planned}) 的结果
 * @param {object} input.health evaluateRowHealth 的结果
 * @param {object} input.scoringConfig 方案里的 scoring 段
 * @param {object} input.bulkHealthScoring 按量模式的 healthScoring 段
 * @param {number} input.cumulativeSales 累积销量（公斤）
 * @param {number} input.suggested 建议需安排（公斤）
 */
export function evaluateReplenishRisk({
  planned,
  previewRow,
  health,
  scoringConfig = null,
  bulkHealthScoring = null,
  cumulativeSales = null,
  suggested = 0,
}) {
  const quantity = Number(planned)
  const isBulk = previewRow?.modeMetric === 'stock'
  // 没有可补的量（建议值为 0 且没填）时不出结论，交给「无法建议」的占位。
  if (!Number.isFinite(quantity) || quantity <= 0) return null

  const state = previewRow ? DAYS_STATE_BY_TONE[previewRow.urgencyTone] : null
  if (!state) return unavailableResult({ previewRow })

  const quantityFactor = buildQuantityFactor(previewRow, state)
  const healthFactor = buildHealthFactor(health, scoringConfig)
  const ratioFactor = buildRatioFactor({
    quantity,
    cumulativeSales,
    scoringConfig,
    bulkHealthScoring,
    isBulk,
  })
  // 卡面顺序也是结论的阅读顺序：库存天数 → 这次下的注 → SKU 底子
  const otherFactors = [ratioFactor, healthFactor].filter(Boolean)
  const factors = [quantityFactor, ...otherFactors]

  // 以「中」为 0 点：三项净偏离相加，> 0 高、= 0 中、< 0 低
  const score = factors.reduce((sum, factor) => sum + (factor.points ?? 0), 0)
  const level = levelOfScore(score)
  const verdict = REPLENISH_RISK_LEVELS[level]

  return {
    available: true,
    level,
    riskLabel: verdict.label,
    tone: verdict.tone,
    score,
    scoreText: `${formatSigned(score)} 分`,
    ruleText: REPLENISH_RISK_RULE_TEXT,
    title: VERDICT_TITLES[level][state],
    suggestion: buildSuggestion({ daysState: state, level, quantity, suggested }),
    factors,
  }
}
