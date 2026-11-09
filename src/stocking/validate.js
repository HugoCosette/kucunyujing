import {
  ALL_GRADES,
  GRADES,
  getFieldLabel,
  getFieldMeta,
  operatorsFor,
} from './fields.js'
import { createDefaultRule, createDefaultTier, createDefaultManualMode, BUILTIN_MANUAL_MODES, BUILTIN_STRATEGIES } from './defaults.js'

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

  if (meta.kind === 'number') {
    // 范围式因子：min / max 留空表示该侧不限制。
    // 兼容旧的 { operator, value }：gte→min、lte→max、eq→min=max。
    let min = toNumber(factor.min)
    let max = toNumber(factor.max)
    const legacyValue = toNumber(factor.value)
    if (min === null && max === null && legacyValue !== null) {
      if (factor.operator === 'lte') max = legacyValue
      else if (factor.operator === 'eq') {
        min = legacyValue
        max = legacyValue
      } else min = legacyValue
    }
    if (min !== null && max !== null && min > max) {
      const swapped = min
      min = max
      max = swapped
    }
    return { field: meta.field, min, max }
  }

  const value = String(factor.value ?? '').trim()
  if (!value) return null
  if (meta.kind === 'enum' && !meta.options.includes(value)) return null
  return { field: meta.field, value }
}

// 同一字段只保留一条范围条件：后一条与已存在条件合并（取更窄的区间）。
function normalizeFactors(factors) {
  const result = []
  const indexByField = new Map()

  for (const factor of Array.isArray(factors) ? factors : []) {
    const next = normalizeFactor(factor)
    if (!next) continue

    const existingIndex = indexByField.get(next.field)
    if (existingIndex === undefined) {
      indexByField.set(next.field, result.length)
      result.push(next)
      continue
    }

    const existing = result[existingIndex]
    if ('min' in existing && 'min' in next) {
      // 区间合并
      const mins = [existing.min, next.min].filter((value) => value !== null)
      const maxs = [existing.max, next.max].filter((value) => value !== null)
      result[existingIndex] = {
        field: existing.field,
        min: mins.length ? Math.max(...mins) : null,
        max: maxs.length ? Math.min(...maxs) : null,
      }
    } else if (existing.value !== next.value) {
      // 文本/枚举字段出现两个不同等值条件时，后一条视为冲突，丢弃
      continue
    }
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

function normalizeManualMode(mode, index) {
  const source = isPlainObject(mode) ? mode : {}
  const behavior = source.behavior === 'slow' ? 'slow' : 'custom'
  const id = String(source.id ?? '').trim() || nextId(`manual-${behavior}`)
  const result = {
    id,
    name: String(source.name ?? '').trim() || (behavior === 'slow' ? '滞销模式' : '自定模式'),
    behavior,
    description: String(source.description ?? ''),
  }
  if (behavior === 'custom') {
    const source2 = isPlainObject(source.defaultCoefficients) ? source.defaultCoefficients : {}
    result.defaultCoefficients = {
      redLine: toNumber(source2.redLine),
      normal: toNumber(source2.normal),
      peak: toNumber(source2.peak),
    }
  }
  return result
}

// 手动策略：两种内置行为（custom / slow）必须各存在一个，其余为用户自定义的模式。
function normalizeManualModes(modes) {
  const list = (Array.isArray(modes) ? modes : []).map((mode, index) =>
    normalizeManualMode(mode, index),
  )
  const result = [...list]
  for (const builtin of BUILTIN_MANUAL_MODES) {
    if (result.some((mode) => mode.behavior === builtin.behavior)) continue
    result.push(
      createDefaultManualMode({ ...builtin, defaultCoefficients: builtin.defaultCoefficients }),
    )
  }
  return result
}

function normalizeStrategy(strategy, fallback) {
  const source = isPlainObject(strategy) ? strategy : {}
  const behavior = source.behavior === 'manual' ? 'manual' : 'auto'
  const base = behavior === 'manual' ? BUILTIN_STRATEGIES[1] : BUILTIN_STRATEGIES[0]
  return {
    id: String(source.id ?? '').trim() || base.id,
    name: String(source.name ?? '').trim() || base.name,
    behavior,
    modes:
      behavior === 'manual'
        ? normalizeManualModes(source.modes)
        : normalizeAutoModes(source.modes ?? fallback ?? []),
  }
}

function normalizeAutoModes(modes) {
  const rules = (Array.isArray(modes) ? modes : []).map((rule, index) =>
    normalizeRule(rule, index),
  )
  const normalRules = rules.filter((rule) => !rule.isDefault)
  const defaultRule =
    rules.find((rule) => rule.isDefault) ?? createDefaultRule({ id: 'rule-default' })

  return [
    ...normalRules,
    {
      ...defaultRule,
      isDefault: true,
      tiers: normalizeTiers(defaultRule.tiers, defaultRule.id),
    },
  ]
}

// 归一化：补全结构、丢弃非法字段、保证默认模式与默认档固定末位。
// 兼容 v1（只有 rules）：自动迁移成「自动策略」里的模式，结果统一为 v2。
export function normalizeConfig(config) {
  const source = isPlainObject(config) ? config : {}
  const legacyRules = Array.isArray(source.rules) ? source.rules : null
  const rawStrategies = Array.isArray(source.strategies) ? source.strategies : []

  const autoSource =
    rawStrategies.find((strategy) => strategy?.behavior !== 'manual') ?? null
  const manualSource =
    rawStrategies.find((strategy) => strategy?.behavior === 'manual') ?? null

  return {
    version: 2,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    strategies: [
      normalizeStrategy(autoSource, legacyRules ?? []),
      normalizeStrategy(manualSource, []),
    ],
  }
}

export function getAutoStrategy(config) {
  const normalized = normalizeConfig(config)
  return normalized.strategies.find((strategy) => strategy.behavior === 'auto') ?? null
}

export function getManualStrategy(config) {
  const normalized = normalizeConfig(config)
  return normalized.strategies.find((strategy) => strategy.behavior === 'manual') ?? null
}

// 自动策略下的模式列表（v1 的 rules）。
export function getAutoModes(config) {
  return getAutoStrategy(config)?.modes ?? []
}

// 手动策略下的模式列表。
export function getManualModes(config) {
  return getManualStrategy(config)?.modes ?? []
}

export function findManualMode(config, modeId) {
  return getManualModes(config).find((mode) => mode.id === modeId) ?? null
}

// —— 配置方案（Profile）——
// config.json 从 v2 的单份配置升级为「多方案文件」：同一时刻只有 activeProfileId 生效。
// 引擎、校验、页面拿到的仍然是单份 v2 配置，多方案的复杂度只留在这一层。
export const PROFILE_FILE_VERSION = 3

function uniqueName(base, used) {
  let name = base
  let index = 2
  while (used.has(name)) {
    name = `${base}（${index}）`
    index += 1
  }
  used.add(name)
  return name
}

export function normalizeProfile(profile, index = 0) {
  const source = isPlainObject(profile) ? profile : {}
  const configSource = isPlainObject(source.config) ? source.config : source
  return {
    id: String(source.id ?? '').trim() || `profile-${index + 1}`,
    name: String(source.name ?? '').trim() || `配置方案${index + 1}`,
    config: normalizeConfig(configSource),
  }
}

// 兼容三种来源：v3 多方案文件、v2 单份配置、v1 只有 rules 的旧配置。
export function normalizeProfileFile(file) {
  const source = isPlainObject(file) ? file : {}
  const rawProfiles = Array.isArray(source.profiles)
    ? source.profiles.filter(isPlainObject)
    : []

  const profiles = rawProfiles.length
    ? rawProfiles.map((profile, index) => normalizeProfile(profile, index))
    : [normalizeProfile({ id: 'production', name: '生产配置', config: source }, 0)]

  const usedIds = new Set()
  const usedNames = new Set()
  const normalizedProfiles = profiles.map((profile, index) => {
    let id = profile.id
    let suffix = index + 1
    while (usedIds.has(id)) {
      id = `${profile.id}-${suffix}`
      suffix += 1
    }
    usedIds.add(id)
    return { ...profile, id, name: uniqueName(profile.name, usedNames) }
  })

  const requestedActive = String(source.activeProfileId ?? '')
  const activeProfileId = usedIds.has(requestedActive)
    ? requestedActive
    : normalizedProfiles[0].id

  return {
    version: PROFILE_FILE_VERSION,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    activeProfileId,
    profiles: normalizedProfiles,
  }
}

export function getActiveProfile(file) {
  const normalized = normalizeProfileFile(file)
  return (
    normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) ??
    normalized.profiles[0]
  )
}

function validateGrades(rule, errors, warnings) {
  const entries = Object.entries(rule.grades)
  if (entries.length === 0) {
    warnings.push({ message: `${rule.name}：未启用评分因子，所有 SKU 记为 Z` })
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
      if (factor.min !== null && factor.min !== undefined) {
        bound.min = Math.max(bound.min, factor.min)
      }
      if (factor.max !== null && factor.max !== undefined) {
        bound.max = Math.min(bound.max, factor.max)
      }
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
  const autoModes = normalized.strategies.find((s) => s.behavior === 'auto')?.modes ?? []
  const manualModes = normalized.strategies.find((s) => s.behavior === 'manual')?.modes ?? []

  autoModes.forEach((rule) => {
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

  const manualNames = new Set()
  manualModes.forEach((mode) => {
    if (!mode.name) {
      errors.push({ message: '手动模式名称不能为空' })
    } else if (manualNames.has(mode.name) || names.has(mode.name)) {
      errors.push({ message: `手动模式名称「${mode.name}」重复` })
    }
    manualNames.add(mode.name)

    if (mode.behavior === 'custom') {
      const values = [
        mode.defaultCoefficients?.redLine,
        mode.defaultCoefficients?.normal,
        mode.defaultCoefficients?.peak,
      ]
      if (!values.every((value) => Number.isFinite(value))) {
        errors.push({ message: `${mode.name}：默认系数请填写完整` })
      } else if (values.some((value) => value < 0)) {
        errors.push({ message: `${mode.name}：默认系数不能为负数` })
      } else if (!(values[0] <= values[1] && values[1] <= values[2])) {
        errors.push({ message: `${mode.name}：默认系数需满足 红线 ≤ 正常 ≤ 峰值` })
      }
    }
  })

  detectRuleOverlap(autoModes).forEach(({ a, b }) => {
    warnings.push({
      message: `模式「${a}」与「${b}」的因子区间可能重叠，同一 SKU 会命中多条模式，请收窄条件`,
    })
  })

  return { ok: errors.length === 0, errors, warnings }
}
