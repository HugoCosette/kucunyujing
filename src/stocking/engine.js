import { GRADES, UNGRADED, getFieldMeta } from './fields.js'
import { getAutoModes, getManualModes, normalizeConfig } from './validate.js'

function matchesFactor(item, factor) {
  const meta = getFieldMeta(factor.field)
  if (!meta) return false

  if (meta.kind === 'number') {
    const actual = Number(item[factor.field])
    if (!Number.isFinite(actual)) return false
    // 空值表示该侧不限制：min 空等于 0，max 空等于正无穷。
    if (factor.min !== null && factor.min !== undefined && actual < factor.min) return false
    if (factor.max !== null && factor.max !== undefined && actual > factor.max) return false
    return true
  }

  const actual = String(item[factor.field] ?? '').trim()
  if (!actual) return false
  return actual === factor.value
}

function matchesRule(item, rule) {
  return rule.factors.length > 0 && rule.factors.every((factor) => matchesFactor(item, factor))
}

// 取满足的最高等级；未达 C 阈值、缺值或未配置阈值一律记 Z。
function gradeOf(value, thresholds) {
  for (const grade of GRADES) {
    const threshold = thresholds[grade]
    if (Number.isFinite(threshold) && value >= threshold) return grade
  }
  return UNGRADED
}

function computeGrades(item, rule) {
  const grades = {}
  for (const [field, thresholds] of Object.entries(rule.grades)) {
    const value = Number(item[field])
    grades[field] = Number.isFinite(value) ? gradeOf(value, thresholds) : UNGRADED
  }
  return grades
}

function countGrades(grades) {
  const counts = Object.fromEntries(GRADES.map((grade) => [grade, 0]))
  counts[UNGRADED] = 0
  for (const grade of Object.values(grades)) {
    if (grade in counts) counts[grade] += 1
  }
  return counts
}

function conditionMatches(condition, counts) {
  const count = counts[condition.grade] ?? 0
  if (condition.operator === 'lte') return count <= condition.count
  if (condition.operator === 'eq') return count === condition.count
  return count >= condition.count
}

function resolveTier(rule, counts) {
  for (const tier of rule.tiers) {
    if (tier.isDefault) continue
    if (tier.conditions.every((condition) => conditionMatches(condition, counts))) return tier
  }
  return rule.tiers.find((tier) => tier.isDefault) ?? rule.tiers[rule.tiers.length - 1] ?? null
}

function summarizeGrades(rule, grades) {
  return Object.keys(rule.grades)
    .map((field) => grades[field] ?? UNGRADED)
    .join('')
}

// 逐因子的等级明细：详情弹窗按配置里的因子顺序一格一格展示（有几个因子就几格）。
function summarizeGradeDetails(rule, grades, item) {
  return Object.keys(rule.grades).map((field) => ({
    field,
    label: getFieldMeta(field)?.label ?? field,
    grade: grades[field] ?? UNGRADED,
    value: item[field] ?? null,
  }))
}

function evaluateUnmatched(tierName = '') {
  return {
    ruleId: '',
    ruleName: '',
    tierId: '',
    tierName,
    grades: {},
    gradeSummary: '',
    gradeDetails: [],
    conflict: false,
    coefficients: null,
    strategy: 'auto',
    modeId: '',
    modeName: '',
    manualBehavior: '',
    slow: false,
    manualCoefficients: null,
  }
}

function toOverrideMap(overrides) {
  if (overrides instanceof Map) return overrides
  if (overrides && typeof overrides === 'object') return new Map(Object.entries(overrides))
  return new Map()
}

// 手动策略的结果：不跑模式匹配、不算评分因子，直接给出模式与系数。
function evaluateManual(item, mode, override) {
  const behavior = mode.behavior === 'slow' ? 'slow' : 'custom'
  const coefficients =
    behavior === 'custom' ? override.coefficients ?? mode.defaultCoefficients ?? null : null
  const category = String(item?.category ?? '').trim()

  return {
    ruleId: mode.id,
    ruleName: mode.name,
    tierId: '',
    tierName: '',
    grades: {},
    gradeSummary: '',
    gradeDetails: [],
    conflict: false,
    // 手动模式只有一个 SKU 一个色彩，直接按当前色彩挂上系数。
    coefficients: coefficients && category ? { [category]: coefficients } : null,
    strategy: 'manual',
    modeId: mode.id,
    modeName: mode.name,
    manualBehavior: behavior,
    slow: behavior === 'slow',
    manualCoefficients: coefficients,
  }
}

// 建一次评估器跑全部 SKU：模式无顺序语义，命中多条视为冲突，运行时取靠前一条给出确定结果。
// options.manualOverrides 为手动清单（skuId → { modeId, coefficients }），命中则短路，不参与自动判定。
export function createEvaluator(config, options = {}) {
  const normalized = normalizeConfig(config)
  const manualModesById = new Map(
    getManualModes(normalized).map((mode) => [mode.id, mode]),
  )
  const autoModes = getAutoModes(normalized)
  const candidateRules = autoModes.filter(
    (rule) => !rule.isDefault && rule.factors.length > 0,
  )
  const defaultRule =
    autoModes.find((rule) => rule.isDefault) ?? autoModes[autoModes.length - 1] ?? null
  const overrides = toOverrideMap(options.manualOverrides)

  function evaluate(item) {
    const skuId = String(item?.skuId ?? '').trim()
    const override = skuId ? overrides.get(skuId) : null
    if (override?.modeId) {
      const mode = manualModesById.get(override.modeId)
      if (mode) return evaluateManual(item, mode, override)
    }

    let matchedRule = null
    let conflict = false

    for (const rule of candidateRules) {
      if (!matchesRule(item, rule)) continue
      if (matchedRule) {
        conflict = true
        break
      }
      matchedRule = rule
    }

    const rule = matchedRule ?? defaultRule
    if (!rule) return evaluateUnmatched()

    const grades = computeGrades(item, rule)
    const tier = resolveTier(rule, countGrades(grades))

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      tierId: tier?.id ?? '',
      tierName: tier?.name ?? '',
      grades,
      gradeSummary: summarizeGrades(rule, grades),
      gradeDetails: summarizeGradeDetails(rule, grades, item),
      conflict,
      // 系数直接跟随命中的档位返回，视图不再按 id 二次查找。
      coefficients: tier?.coefficients ?? null,
      strategy: 'auto',
      modeId: rule.id,
      modeName: rule.name,
      manualBehavior: '',
      slow: false,
      manualCoefficients: null,
    }
  }

  return { evaluate, rules: autoModes, config: normalized }
}

// 计算时取值用：先抄一份再评估，绝不写回 store 里的原始行。
// 模式与评分档只在渲染时现算，配置一改所有视图立刻一致，不会残留已删除模式的旧名称。
// 系数由评估结果直接带出，避免“再按 id 查一次”时两次归一化不一致导致整条模式取不到系数。
export function evaluateItem(item, evaluator) {
  const result = evaluator.evaluate(item)
  return {
    ...item,
    ruleId: result.ruleId,
    ruleName: result.ruleName,
    tierId: result.tierId,
    tierName: result.tierName,
    gradeSummary: result.gradeSummary,
    gradeDetails: result.gradeDetails,
    ruleConflict: result.conflict,
    stockingCoefficients: result.coefficients,
    strategy: result.strategy,
    modeId: result.modeId,
    modeName: result.modeName,
    manualBehavior: result.manualBehavior,
    strategySlow: result.slow,
    manualCoefficients: result.manualCoefficients,
  }
}

// 配置预览/校验用：用当前数据实跑一遍，给出模式与档位的分布及冲突清单。
export function summarizeEvaluation(items, config, options = {}) {
  const evaluator = createEvaluator(config, options)
  const ruleCounts = new Map()
  const tierCounts = new Map()
  const conflicts = []
  let conflictCount = 0

  for (const item of items) {
    const result = evaluator.evaluate(item)
    ruleCounts.set(result.ruleName, (ruleCounts.get(result.ruleName) ?? 0) + 1)
    const tierKey = `${result.ruleName}\u0000${result.tierName}`
    tierCounts.set(tierKey, (tierCounts.get(tierKey) ?? 0) + 1)

    if (!result.conflict) continue
    conflictCount += 1
    if (conflicts.length < 5) {
      conflicts.push({
        skuId: item.skuId ?? '',
        product: item.product ?? '',
        color: item.color ?? '',
        ruleName: result.ruleName,
      })
    }
  }

  return { ruleCounts, tierCounts, conflictSamples: conflicts, conflictCount }
}
