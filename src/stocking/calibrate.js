import { getFieldLabel, getFieldMeta } from './fields.js'

// 按当前导入数据生成评分阈值：S≈前 10%、A≈前 30%、B≈前 60%，C 固定为 0。
// 阈值永远不超过样本最大值，否则该等级永远评不上。
export const CALIBRATION_QUANTILES = { S: 0.9, A: 0.7, B: 0.4 }

function quantileOf(sorted, q) {
  if (!sorted.length) return 0
  const position = (sorted.length - 1) * q
  const base = Math.floor(position)
  const rest = position - base
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base]
}

function stepOf(value, integerOnly) {
  if (integerOnly) return 1
  if (value >= 100) return 10
  if (value >= 10) return 1
  if (value >= 1) return 0.5
  return 0.01
}

function roundThreshold(value, integerOnly) {
  if (!Number.isFinite(value)) return 0
  if (integerOnly) return Math.max(1, Math.round(value))
  if (value >= 100) return Math.round(value / 10) * 10
  if (value >= 10) return Math.round(value)
  if (value >= 1) return Math.round(value * 2) / 2
  return Math.round(value * 100) / 100
}

// 全为整数且跨度足够时按整数取整，避免出现「8.5 以上是 A」这种永远评不上的空档。
function detectIntegerOnly(values) {
  const max = values[values.length - 1] ?? 0
  return max >= 3 && values.every((value) => Number.isInteger(value))
}

function buildThresholds(values, integerOnly) {
  const max = values[values.length - 1]
  let S = Math.min(roundThreshold(quantileOf(values, CALIBRATION_QUANTILES.S), integerOnly), max)
  let A = Math.min(
    roundThreshold(quantileOf(values, CALIBRATION_QUANTILES.A), integerOnly),
    S - stepOf(S, integerOnly),
  )
  let B = Math.min(
    roundThreshold(quantileOf(values, CALIBRATION_QUANTILES.B), integerOnly),
    A - stepOf(A, integerOnly),
  )

  if (integerOnly) {
    if (A < 1) A = 1
    if (B < 1) B = 1
    if (!(S > A)) S = A + 1
    if (!(A > B)) A = B + 1
  } else {
    if (A <= 0) A = Math.max(0.01, S - stepOf(S, integerOnly))
    if (B <= 0) B = Math.max(0.01, A - stepOf(A, integerOnly))
  }

  return { S, A, B, C: 0 }
}

function distributionOf(items, field, thresholds) {
  const counts = { S: 0, A: 0, B: 0, C: 0, Z: 0 }
  for (const item of items ?? []) {
    const value = Number(item?.[field])
    if (!Number.isFinite(value)) {
      counts.Z += 1
      continue
    }
    if (value >= thresholds.S) counts.S += 1
    else if (value >= thresholds.A) counts.A += 1
    else if (value >= thresholds.B) counts.B += 1
    else if (value >= thresholds.C) counts.C += 1
    else counts.Z += 1
  }
  return counts
}

// 只校准数值因子；没有有效样本（整列为 0 或空）的因子返回 thresholds: null，交由界面提示。
export function calibrateGrades(items, fields, currentGrades = {}) {
  const list = Array.isArray(fields) ? fields : []

  return list.map((field) => {
    const meta = getFieldMeta(field)
    const values = []
    for (const item of items ?? []) {
      const value = Number(item?.[field])
      if (Number.isFinite(value) && value > 0) values.push(value)
    }
    values.sort((first, second) => first - second)

    const thresholds =
      meta?.kind === 'number' && values.length
        ? buildThresholds(values, detectIntegerOnly(values))
        : null

    return {
      field,
      label: getFieldLabel(field),
      sampleCount: values.length,
      current: currentGrades?.[field] ?? null,
      thresholds,
      distribution: thresholds ? distributionOf(items, field, thresholds) : null,
    }
  })
}

// —— 评分档：按 S 的个数命名 ——
// 3 个 S 叫 3S、2 个叫 2S、1 个叫 1S，末位固定默认档；档条件按「S ≥ 个数」从大到小排列，
// 由 engine 的「取第一个命中档」保证 3S 先于 2S、2S 先于 1S。
export const TIER_S_LEVELS = [
  { count: 3, multiplier: 1.5 },
  { count: 2, multiplier: 1.25 },
  { count: 1, multiplier: 1 },
]

const FALLBACK_COEFFICIENTS = {
  黑白: { redLine: 2, normal: 4, peak: 6 },
  彩色: { redLine: 2, normal: 4, peak: 6 },
}

function roundHalf(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value * 2) / 2)
}

// 以默认档系数为基准按倍数放大；四舍五入到 0.5 后仍保证 红线 ≤ 正常 ≤ 峰值。
function scaleCoefficients(base, multiplier) {
  const result = {}
  for (const category of ['黑白', '彩色']) {
    const source = base?.[category] ?? {}
    let redLine = roundHalf((source.redLine ?? 0) * multiplier)
    let normal = roundHalf((source.normal ?? 0) * multiplier)
    let peak = roundHalf((source.peak ?? 0) * multiplier)
    normal = Math.max(normal, redLine)
    peak = Math.max(peak, normal)
    result[category] = { redLine, normal, peak }
  }
  return result
}

// 重建出 3S / 2S / 1S / 默认档。已有的同名档保留原 id 与系数，缺失的档按默认档系数放大补齐。
// 评分因子不足 3 个时只生成到对应个数（1 个因子只有 1S）。
export function buildGradeTiers(fields, options = {}) {
  const factorCount = Array.isArray(fields) ? fields.length : 0
  const existingTiers = Array.isArray(options.tiers) ? options.tiers : []
  const existingDefault = existingTiers.find((tier) => tier?.isDefault)
  const base = options.baseCoefficients ?? existingDefault?.coefficients ?? FALLBACK_COEFFICIENTS
  const prefix = options.ruleId ?? 'tier'

  const tiers = []
  for (const level of TIER_S_LEVELS) {
    if (level.count > factorCount) continue
    const name = `${level.count}S`
    const existing = existingTiers.find((tier) => !tier?.isDefault && tier?.name === name)
    tiers.push({
      id: existing?.id ?? `${prefix}-tier-${level.count}s`,
      name,
      isDefault: false,
      conditions: [{ grade: 'S', operator: 'gte', count: level.count }],
      coefficients:
        existing?.coefficients ?? scaleCoefficients(base, level.multiplier),
    })
  }

  tiers.push({
    id: existingDefault?.id ?? `${prefix}-tier-default`,
    name: existingDefault?.name ?? '默认档',
    isDefault: true,
    conditions: [],
    coefficients: existingDefault?.coefficients ?? base,
  })

  return tiers
}
