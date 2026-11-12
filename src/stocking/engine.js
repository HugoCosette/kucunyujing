import { CUSTOMER_EXCLUSIVE, CUSTOMER_FLOW } from './constants.js'
import { getAutoModes, getManualModes, getSalesWeights, normalizeConfig } from './validate.js'

const DAYS_PER_MONTH = 30

function toOverrideMap(overrides) {
  if (overrides instanceof Map) return overrides
  if (overrides && typeof overrides === 'object') return new Map(Object.entries(overrides))
  return new Map()
}

// 基准月缺省时退化为「该 SKU 最后一个有销量的月份」，避免整行拿不到销量。
function lastActiveMonth(counts) {
  for (let index = counts.length - 1; index >= 0; index -= 1) {
    if (Number(counts[index]) > 0) return index + 1
  }
  return 0
}

// 加权月销量 = 近1个月 ×w1 + 近3个月月均 ×w3 + 近12个月月均 ×w12。
// 缺失月份按 0 计入（与「12 个月全平均、含 0」的口径一致）。
export function weightedMonthlySales(counts, baselineMonth, weights) {
  if (!Array.isArray(counts) || counts.length === 0) return null
  const base =
    Number.isFinite(baselineMonth) && baselineMonth > 0
      ? Math.min(Math.trunc(baselineMonth), counts.length)
      : lastActiveMonth(counts)
  if (!base) return 0

  const pick = (offset) => {
    const month = base - offset
    if (month < 1) return 0
    const value = Number(counts[month - 1])
    return Number.isFinite(value) ? value : 0
  }

  let sum1 = 0
  let sum3 = 0
  let sum12 = 0
  for (let offset = 0; offset < 12; offset += 1) {
    const value = pick(offset)
    sum12 += value
    if (offset < 3) sum3 += value
    if (offset === 0) sum1 = value
  }

  const w = weights ?? { m1: 0.5, m3: 0.3, m12: 0.2 }
  return w.m1 * sum1 + w.m3 * (sum3 / 3) + w.m12 * (sum12 / 12)
}

// 模式判定只看月均条数：按顺序命中第一条「区间包含该值」的模式（顺序即优先级）。
// 区间端点留空表示不限（下限 0 / 上限 +∞）；落在区间空档时退回到「下限最高且不高于该值」的模式。
function matchMode(modes, monthlyAvg) {
  for (const mode of modes) {
    const from = mode.range?.from ?? 0
    const to = mode.range?.to ?? Number.POSITIVE_INFINITY
    if (monthlyAvg >= from && monthlyAvg <= to) return mode
  }
  for (const mode of modes) {
    if (monthlyAvg >= (mode.range?.from ?? 0)) return mode
  }
  return modes[modes.length - 1] ?? null
}

function createResult(overrides = {}) {
  return {
    modeKey: '',
    modeName: '',
    modeLabel: '',
    metric: 'none',
    participates: false,
    coefficients: null,
    monthlySales: null,
    dailySales: null,
    exclusive: false,
    excluded: true,
    strategy: 'auto',
    modeId: '',
    manualBehavior: '',
    manualCoefficients: null,
    ...overrides,
  }
}

function evaluateManual(item, mode, override, weights, baselineMonth) {
  const behavior = mode.behavior === 'exclude' ? 'exclude' : 'custom'
  const coefficients = behavior === 'custom' ? override.coefficients ?? mode.defaultCoefficients ?? null : null
  const monthlySales = weightedMonthlySales(item?.monthSales, baselineMonth, weights)

  return createResult({
    modeKey: mode.id,
    modeName: mode.name,
    modeLabel: `手动·${mode.name}`,
    // 手动自定系数模式按库存条数比较（与按量模式同一口径）；排除模式不参与备货策略。
    metric: behavior === 'custom' ? 'stock' : 'none',
    participates: behavior === 'custom' && Boolean(coefficients),
    coefficients,
    monthlySales,
    dailySales: Number.isFinite(monthlySales) ? monthlySales / DAYS_PER_MONTH : null,
    excluded: behavior !== 'custom',
    strategy: 'manual',
    modeId: mode.id,
    manualBehavior: behavior,
    manualCoefficients: coefficients,
  })
}

// 建一次评估器跑全部 SKU：手动清单命中即短路，不参与自动判定。
// options.manualOverrides 为手动清单（skuId → { modeId, coefficients }）。
// options.baselineMonth 为「近 N 个月」的基准月（数据里最后一个有销量的月份）。
export function createEvaluator(config, options = {}) {
  const normalized = normalizeConfig(config)
  const weights = getSalesWeights(normalized)
  const baselineMonth = Number.isFinite(options.baselineMonth)
    ? options.baselineMonth
    : null
  const manualModesById = new Map(getManualModes(normalized).map((mode) => [mode.id, mode]))
  const autoModes = getAutoModes(normalized)
  const overrides = toOverrideMap(options.manualOverrides)

  function evaluate(item) {
    const skuId = String(item?.skuId ?? '').trim()
    const override = skuId ? overrides.get(skuId) : null
    if (override?.modeId) {
      const manualMode = manualModesById.get(override.modeId)
      if (manualMode) return evaluateManual(item, manualMode, override, weights, baselineMonth)
    }

    const rawMonthlyAvg = Number(item?.monthlyAvgCount)
    const monthlyAvg = Number.isFinite(rawMonthlyAvg) ? rawMonthlyAvg : 0
    const mode = matchMode(autoModes, monthlyAvg)
    if (!mode) return createResult()

    const monthlySales = weightedMonthlySales(item?.monthSales, baselineMonth, weights)
    const category = String(item?.category ?? '').trim()
    const exclusive = mode.splitByCustomer && Number(item?.activeCustomers) === 1
    const customerKind = exclusive ? CUSTOMER_EXCLUSIVE : CUSTOMER_FLOW
    const participates = mode.participates && !exclusive
    const coefficients = participates
      ? mode.coefficients?.[customerKind]?.[category] ?? null
      : null

    return createResult({
      modeKey: mode.key,
      modeName: mode.name,
      modeLabel: exclusive ? `${mode.name}·${CUSTOMER_EXCLUSIVE}` : mode.name,
      metric: participates ? mode.metric : 'none',
      participates,
      coefficients,
      monthlySales,
      dailySales: Number.isFinite(monthlySales) ? monthlySales / DAYS_PER_MONTH : null,
      exclusive,
      excluded: !participates,
      strategy: 'auto',
      modeId: mode.key,
    })
  }

  return { evaluate, modes: autoModes, config: normalized, baselineMonth }
}

// 计算时取值用：先抄一份再评估，绝不写回 store 里的原始行。
// 模式与系数只在渲染时现算，配置一改所有视图立刻一致。
export function evaluateItem(item, evaluator) {
  const result = evaluator.evaluate(item)
  return {
    ...item,
    modeKey: result.modeKey,
    modeName: result.modeName,
    modeLabel: result.modeLabel,
    modeMetric: result.metric,
    modeParticipates: result.participates,
    stockingCoefficients: result.coefficients,
    monthlySales: result.monthlySales,
    dailySales: result.dailySales,
    exclusive: result.exclusive,
    excluded: result.excluded,
    strategy: result.strategy,
    modeId: result.modeId,
    manualBehavior: result.manualBehavior,
    manualCoefficients: result.manualCoefficients,
  }
}

// 配置预览/校验用：用当前数据实跑一遍，给出每个模式的命中数。
export function summarizeEvaluation(items, config, options = {}) {
  const evaluator = createEvaluator(config, options)
  const counts = new Map()
  const flowCounts = new Map()
  const exclusiveCounts = new Map()

  for (const item of items) {
    const result = evaluator.evaluate(item)
    counts.set(result.modeKey, (counts.get(result.modeKey) ?? 0) + 1)
    const bucket = result.exclusive ? exclusiveCounts : flowCounts
    bucket.set(result.modeKey, (bucket.get(result.modeKey) ?? 0) + 1)
  }

  return { counts, flowCounts, exclusiveCounts, total: items.length }
}

// 数据里最后一个有销量的月份：作为「近 N 个月」的基准月。
export function findBaselineMonth(rows) {
  let baseline = 0
  for (const row of rows ?? []) {
    const counts = row?.monthSales
    if (!Array.isArray(counts)) continue
    for (let index = counts.length - 1; index >= 0; index -= 1) {
      if (Number(counts[index]) > 0) {
        baseline = Math.max(baseline, index + 1)
        break
      }
    }
  }
  return baseline
}
