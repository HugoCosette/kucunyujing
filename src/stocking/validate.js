import {
  ALL_GRADES,
  GRADES,
  getFieldLabel,
  getFieldMeta,
  operatorsFor,
} from './fields.js'
import { createDefaultRule, createDefaultTier } from './defaults.js'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

let autoIdSeed = 0
function nextId(prefix) {
  autoIdSeed += 1
  return `${prefix}-${Date.now().toString(36)}-${autoIdSeed}`
}

function normalizeFactor(factor) {
  const meta = getFieldMeta(factor?.field)
  if (!meta) return null

  const allowed = operatorsFor(meta.field).map((entry) => entry.value)
  const operator = allowed.includes(factor.operator) ? factor.operator : allowed[0]

  if (meta.kind === 'number') {
    const value = toNumber(factor.value)
    return value === null ? null : { field: meta.field, operator, value }
  }

  const value = String(factor.value ?? '').trim()
  if (!value) return null
  if (meta.kind === 'enum' && !meta.options.includes(value)) return null
  return { field: meta.field, operator: 'eq', value }
}

// 同一字段允许出现多条条件（≥100 + ≤199 表达区间），只去掉完全重复的条件。
function normalizeFactors(factors) {
  const result = []
  const seen = new Set()
  for (const factor of Array.isArray(factors) ? factors : []) {
    const next = normalizeFactor(factor)
    if (!next) continue
    const key = `${next.field}\u0000${next.operator}\u0000${next.value}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(next)
  }
  return result
}

function normalizeGrades(grades) {
  const result = {}
  if (!isPlainObject(grades)) return result
  for (const [field, thresholds] of Object.entries(grades)) {
    const meta = getFieldMeta(field)
    if (!meta || meta.kind !== 'number') continue
    const source = isPlainObject(thresholds) ? thresholds : {}
    result[field] = {
      S: toNumber(source.S),
      A: toNumber(source.A),
      B: toNumber(source.B),
      C: toNumber(source.C),
    }
  }
  return result
}

function normalizeConditions(conditions) {
  const result = []
  for (const condition of Array.isArray(conditions) ? conditions : []) {
    if (!ALL_GRADES.includes(condition?.grade)) continue
    result.push({
      grade: condition.grade,
      operator: ['gte', 'lte', 'eq'].includes(condition.operator)
        ? condition.operator
        : 'gte',
      count: Math.max(0, Math.trunc(toNumber(condition.count, 0) ?? 0)),
    })
  }
  return result
}

function normalizeCoefficients(coefficients) {
  const result = {}
  for (const category of ['黑白', '彩色']) {
    const source = isPlainObject(coefficients?.[category]) ? coefficients[category] : {}
    result[category] = {
      redLine: toNumber(source.redLine),
      normal: toNumber(source.normal),
      peak: toNumber(source.peak),
    }
  }
  return result
}

function normalizeTier(tier, ruleId, index) {
  const source = isPlainObject(tier) ? tier : {}
  return {
    id: String(source.id ?? '').trim() || nextId(`${ruleId}-tier`),
    name: String(source.name ?? '').trim() || `档位${index + 1}`,
    isDefault: Boolean(source.isDefault),
    conditions: normalizeConditions(source.conditions),
    coefficients: normalizeCoefficients(source.coefficients),
  }
}

// 每个模式必须且只能有一个默认档，且固定在末位。
function normalizeTiers(tiers, ruleId) {
  const list = (Array.isArray(tiers) ? tiers : []).map((tier, index) =>
    normalizeTier(tier, ruleId, index),
  )
  const normalTiers = list.filter((tier) => !tier.isDefault)
  const fallback =
    list.find((tier) => tier.isDefault) ??
    createDefaultTier({ id: `${ruleId}-tier-default` })
  return [...normalTiers, { ...fallback, isDefault: true }]
}

function normalizeRule(rule, index) {
  const source = isPlainObject(rule) ? rule : {}
  const id = String(source.id ?? '').trim() || nextId(`rule-${index + 1}`)
  return {
    id,
    name: String(source.name ?? '').trim() || `模式${index + 1}`,
    isDefault: Boolean(source.isDefault),
    factors: normalizeFactors(source.factors),
    grades: normalizeGrades(source.grades),
    tiers: normalizeTiers(source.tiers, id),
  }
}

// 归一化：补全结构、丢弃非法字段、保证默认模式与默认档固定末位。
export function normalizeConfig(config) {
  const source = isPlainObject(config) ? config : {}
  const rules = (Array.isArray(source.rules) ? source.rules : []).map((rule, index) =>
    normalizeRule(rule, index),
  )
  const normalRules = rules.filter((rule) => !rule.isDefault)
  const defaultRule =
    rules.find((rule) => rule.isDefault) ?? createDefaultRule({ id: 'rule-default' })

  return {
    version: toNumber(source.version, 1) ?? 1,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    rules: [
      ...normalRules,
      {
        ...defaultRule,
        isDefault: true,
        tiers: normalizeTiers(defaultRule.tiers, defaultRule.id),
      },
    ],
  }
}

function validateGrades(rule, errors, warnings) {
  const entries = Object.entries(rule.grades)
  if (entries.length === 0) {
    warnings.push({ message: `${rule.name}：未启用热度因子，所有 SKU 记为 Z` })
    return
  }

  for (const [field, thresholds] of entries) {
    const configured = GRADES.map((grade) => thresholds[grade]).filter(Number.isFinite)
    if (configured.length === 0) {
      warnings.push({
        message: `${rule.name} · ${getFieldLabel(field)}：未配置任何阈值，该因子记为 Z`,
      })
      continue
    }

    for (let index = 1; index < GRADES.length; index += 1) {
      const previous = thresholds[GRADES[index - 1]]
      const current = thresholds[GRADES[index]]
      if (Number.isFinite(previous) && Number.isFinite(current) && previous <= current) {
        errors.push({
          message: `${rule.name} · ${getFieldLabel(field)}：阈值需从 S 到 C 递减，当前 ${GRADES[index - 1]}≥${previous} 不大于 ${GRADES[index]}≥${current}`,
        })
      }
    }
  }
}

function validateTiers(rule, errors, warnings) {
  const names = new Set()
  const factorCount = Object.keys(rule.grades).length

  rule.tiers.forEach((tier) => {
    if (!tier.name) {
      errors.push({ message: `${rule.name}：档位名称不能为空` })
      return
    }
    if (names.has(tier.name)) {
      errors.push({ message: `${rule.name}：档位名称「${tier.name}」重复` })
    }
    names.add(tier.name)

    if (!tier.isDefault && tier.conditions.length === 0) {
      errors.push({
        message: `${rule.name} · ${tier.name}：未配置命中条件，该档永远不会命中`,
      })
    }

    for (const condition of tier.conditions) {
      if (condition.operator === 'gte' && factorCount > 0 && condition.count > factorCount) {
        warnings.push({
          message: `${rule.name} · ${tier.name}：条件「${condition.grade} ≥ ${condition.count}」超过已启用的 ${factorCount} 个因子，永远不会命中`,
        })
      }
    }

    for (const category of ['黑白', '彩色']) {
      const factors = tier.coefficients[category]
      const values = [factors.redLine, factors.normal, factors.peak]
      if (!values.every((value) => Number.isFinite(value))) {
        errors.push({
          message: `${rule.name} · ${tier.name} · ${category}：红线 / 正常 / 峰值系数必须填写`,
        })
        continue
      }
      if (values.some((value) => value < 0)) {
        errors.push({
          message: `${rule.name} · ${tier.name} · ${category}：系数不能为负数`,
        })
      }
      if (!(factors.redLine <= factors.normal && factors.normal <= factors.peak)) {
        errors.push({
          message: `${rule.name} · ${tier.name} · ${category}：系数需满足 红线 ≤ 正常 ≤ 峰值`,
        })
      }
    }
  })
}

function ruleBounds(rule) {
  const bounds = new Map()
  for (const factor of rule.factors) {
    const meta = getFieldMeta(factor.field)
    if (!meta) continue

    let bound = bounds.get(factor.field)
    if (!bound) {
      bound = { kind: meta.kind, min: -Infinity, max: Infinity, equals: null, values: null }
      bounds.set(factor.field, bound)
    }

    if (meta.kind === 'number') {
      if (factor.operator === 'gte') bound.min = Math.max(bound.min, factor.value)
      else if (factor.operator === 'lte') bound.max = Math.min(bound.max, factor.value)
      else bound.equals = factor.value
      continue
    }

    bound.values = bound.values
      ? bound.values.filter((value) => value === factor.value)
      : [factor.value]
  }
  return bounds
}

function boundsIntersect(left, right) {
  if (!left || !right) return true

  if (left.kind === 'number' && right.kind === 'number') {
    if (left.equals !== null && right.equals !== null) return left.equals === right.equals
    if (left.equals !== null) return left.equals >= right.min && left.equals <= right.max
    if (right.equals !== null) return right.equals >= left.min && right.equals <= left.max
    return Math.max(left.min, right.min) <= Math.min(left.max, right.max)
  }

  const leftValues = left.values ?? []
  const rightValues = right.values ?? []
  if (leftValues.length === 0 || rightValues.length === 0) return false
  return leftValues.some((value) => rightValues.includes(value))
}

// 模式设计要求互斥：任意两条模式的因子区间只要有交集就会提示，交由使用者收窄条件。
export function detectRuleOverlap(rules) {
  const candidates = rules.filter((rule) => !rule.isDefault && rule.factors.length > 0)
  const boundsList = candidates.map((rule) => ruleBounds(rule))
  const pairs = []

  for (let index = 0; index < candidates.length; index += 1) {
    for (let next = index + 1; next < candidates.length; next += 1) {
      const fields = new Set([...boundsList[index].keys(), ...boundsList[next].keys()])
      let overlaps = true
      for (const field of fields) {
        if (!boundsIntersect(boundsList[index].get(field), boundsList[next].get(field))) {
          overlaps = false
          break
        }
      }
      if (overlaps) {
        pairs.push({ a: candidates[index].name, b: candidates[next].name })
      }
    }
  }

  return pairs
}

export function validateConfig(config) {
  const normalized = normalizeConfig(config)
  const errors = []
  const warnings = []
  const names = new Set()

  normalized.rules.forEach((rule) => {
    if (!rule.name) {
      errors.push({ message: '模式名称不能为空' })
    } else if (names.has(rule.name)) {
      errors.push({ message: `模式名称「${rule.name}」重复` })
    }
    names.add(rule.name)

    if (!rule.isDefault && rule.factors.length === 0) {
      warnings.push({ message: `${rule.name}：未配置模式因子，该模式不参与匹配` })
    }

    validateGrades(rule, errors, warnings)
    validateTiers(rule, errors, warnings)
  })

  detectRuleOverlap(normalized.rules).forEach(({ a, b }) => {
    warnings.push({
      message: `模式「${a}」与「${b}」的因子区间可能重叠，同一 SKU 会命中多条模式，请收窄条件`,
    })
  })

  return { ok: errors.length === 0, errors, warnings }
}
