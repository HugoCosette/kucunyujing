import {
  CATEGORIES,
  CUSTOMER_EXCLUSIVE,
  CUSTOMER_FLOW,
  MODE_KEYS,
  SALES_WINDOW_DEFAULTS,
  SALES_WINDOW_MAX_MONTHS,
  createDefaultSalesWeights,
} from './constants.js'
import {
  BUILTIN_MANUAL_MODES,
  BUILTIN_STRATEGIES,
  CONFIG_VERSION,
  MANUAL_BEHAVIOR_NAMES,
  PROFILE_FILE_VERSION,
  createDefaultAutoModes,
  createDefaultConfig,
  createDefaultManualMode,
  normalizeManualBehavior,
} from './defaults.js'
import { normalizeScoring, validateScoring, normalizeBulkScoring, validateBulkScoring } from './scoring.js'
import { normalizeSpuGrades, validateSpuGrades } from './spuGrades.js'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

// 区间端点：缺字段按默认，显式留空（null / 空串）表示不限。
function toBound(value, fallback) {
  if (value === undefined) return fallback
  if (value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

let autoIdSeed = 0
function nextId(prefix) {
  autoIdSeed += 1
  return `${prefix}-${Date.now().toString(36)}-${autoIdSeed}`
}

function normalizeCategoryCoefficients(source) {
  if (!isPlainObject(source)) return null
  const result = {}
  for (const category of CATEGORIES) {
    const entry = isPlainObject(source[category]) ? source[category] : {}
    result[category] = {
      redLine: toNumber(entry.redLine),
      normal: toNumber(entry.normal),
      peak: toNumber(entry.peak),
    }
  }
  return result
}

// 系数按客户类别分组：分流模式有「流通品 / 专属品」，其余只有「流通品」。
// 兼容旧的扁平写法 { 黑白, 彩色 }。
function normalizeModeCoefficients(source, splitByCustomer) {
  const kinds = splitByCustomer ? [CUSTOMER_FLOW, CUSTOMER_EXCLUSIVE] : [CUSTOMER_FLOW]
  const flat =
    isPlainObject(source) && !source[CUSTOMER_FLOW] && !source[CUSTOMER_EXCLUSIVE]
      ? source
      : null
  const result = {}
  for (const kind of kinds) {
    result[kind] = normalizeCategoryCoefficients(flat ?? source?.[kind])
  }
  return result
}

// 模式区间：老配置只有 minMonthlyAvg 时按「≥ 阈值」迁移成 [阈值, 不限]。
function normalizeModeRange(input, fallback) {
  if (isPlainObject(input.range)) {
    return {
      from: toBound(input.range.from, fallback.range.from),
      to: toBound(input.range.to, fallback.range.to),
    }
  }
  const legacy = toNumber(input.minMonthlyAvg, null)
  return legacy === null ? { ...fallback.range } : { from: legacy, to: null }
}

function normalizeMode(source, fallback) {
  const input = isPlainObject(source) ? source : {}
  const splitByCustomer = input.splitByCustomer ?? fallback.splitByCustomer
  const participates = input.participates ?? fallback.participates
  return {
    key: fallback.key,
    name: String(input.name ?? '').trim() || fallback.name,
    range: normalizeModeRange(input, fallback),
    metric: participates ? fallback.metric : 'none',
    participates: Boolean(participates),
    splitByCustomer: Boolean(splitByCustomer),
    coefficients: participates
      ? normalizeModeCoefficients(input.coefficients ?? fallback.coefficients, splitByCustomer)
      : null,
    // 按量模式的弹窗专属健康度区间（进销比 / 累计客户数），其它模式没有这一段。
    ...(fallback.key === 'bulk'
      ? { healthScoring: normalizeBulkScoring(input.healthScoring) }
      : {}),
  }
}

function normalizeAutoModes(modes) {
  const source = Array.isArray(modes) ? modes : []
  const byKey = new Map()
  for (const mode of source) {
    const key = String(mode?.key ?? '').trim()
    if (MODE_KEYS.includes(key) && !byKey.has(key)) byKey.set(key, mode)
  }
  // 固定 5 条、固定顺序：缺失的模式按内置默认补齐。
  return createDefaultAutoModes().map((fallback) =>
    normalizeMode(byKey.get(fallback.key), fallback),
  )
}

function normalizeManualMode(mode, index) {
  const source = isPlainObject(mode) ? mode : {}
  const behavior = normalizeManualBehavior(source.behavior)
  const id = String(source.id ?? '').trim() || nextId(`manual-${behavior}`)
  const rawName = String(source.name ?? '').trim()
  const fallbackName = MANUAL_BEHAVIOR_NAMES[behavior] ?? MANUAL_BEHAVIOR_NAMES.custom
  // 旧版内置名跟随改名（「自定模式」→「自定系数模式」）；其它自定义名称原样保留。
  const legacyName = behavior === 'custom' ? '自定模式' : ''
  const name = rawName === legacyName ? fallbackName : rawName || fallbackName
  const result = {
    id,
    name,
    behavior,
    description: String(source.description ?? ''),
  }
  if (behavior === 'custom') {
    const raw = isPlainObject(source.defaultCoefficients) ? source.defaultCoefficients : {}
    result.defaultCoefficients = {
      redLine: toNumber(raw.redLine),
      normal: toNumber(raw.normal),
      peak: toNumber(raw.peak),
    }
  }
  return result
}

// 手动策略：两种内置行为（custom / order）各保留一个，其余为用户自定义的模式。
// 已下线的手动行为（exclude / 旧名 slow）在加载旧方案时整条丢弃。
const REMOVED_MANUAL_BEHAVIORS = new Set(['exclude', 'slow'])

function normalizeManualModes(modes) {
  const list = (Array.isArray(modes) ? modes : [])
    .filter(
      (mode) =>
        !(isPlainObject(mode) && REMOVED_MANUAL_BEHAVIORS.has(String(mode.behavior ?? ''))),
    )
    .map((mode, index) => normalizeManualMode(mode, index))
  const result = [...list]
  for (const builtin of BUILTIN_MANUAL_MODES) {
    if (result.some((mode) => mode.behavior === builtin.behavior)) continue
    result.push(createDefaultManualMode(builtin))
  }
  return result
}

function normalizeStrategy(strategy, fallback, normalizeModes) {
  const source = isPlainObject(strategy) ? strategy : {}
  return {
    id: String(source.id ?? '').trim() || fallback.id,
    name: String(source.name ?? '').trim() || fallback.name,
    behavior: fallback.behavior,
    modes: normalizeModes(source.modes),
  }
}

// 销量加权：列表里的每一条 = 「最近 N 个月的月均 × 权重」，权重之和为 1。
// 旧版写死的 { m1, m3, m12 } 在这里一次性迁移成三条，其他读法一律当空列表处理。
function normalizeSalesWeights(weights) {
  const legacy = !Array.isArray(weights) && isPlainObject(weights) ? weights : null
  const source = Array.isArray(weights)
    ? weights
    : legacy
      ? [
          { months: 1, weight: toNumber(legacy.m1, SALES_WINDOW_DEFAULTS[0].weight) },
          { months: 3, weight: toNumber(legacy.m3, SALES_WINDOW_DEFAULTS[1].weight) },
          { months: 12, weight: toNumber(legacy.m12, SALES_WINDOW_DEFAULTS[2].weight) },
        ]
      : []

  const entries = []
  for (const entry of source) {
    const months = toNumber(entry?.months, null)
    if (months === null || months < 1) continue
    entries.push({
      months: Math.min(Math.trunc(months), SALES_WINDOW_MAX_MONTHS),
      weight: Math.max(toNumber(entry?.weight, 0), 0),
    })
  }
  return entries.length > 0 ? entries : createDefaultSalesWeights()
}

// 归一化：补全结构、丢弃非法字段、固定 5 个模式及其顺序。
// 旧版本（v1/v2/v3）配置整份抛弃，直接回到内置默认。
export function normalizeConfig(config) {
  if (!isPlainObject(config) || Number(config.version) !== CONFIG_VERSION) {
    return createDefaultConfig()
  }

  const strategies = Array.isArray(config.strategies) ? config.strategies : []
  const autoSource = strategies.find((strategy) => strategy?.behavior !== 'manual') ?? null
  const manualSource = strategies.find((strategy) => strategy?.behavior === 'manual') ?? null

  return {
    version: CONFIG_VERSION,
    updatedAt:
      typeof config.updatedAt === 'string' ? config.updatedAt : new Date().toISOString(),
    salesWindow: { weights: normalizeSalesWeights(config.salesWindow?.weights) },
    scoring: normalizeScoring(config.scoring),
    spuGrades: normalizeSpuGrades(config.spuGrades),
    strategies: [
      normalizeStrategy(autoSource, BUILTIN_STRATEGIES[0], normalizeAutoModes),
      normalizeStrategy(manualSource, BUILTIN_STRATEGIES[1], normalizeManualModes),
    ],
  }
}

export function getAutoStrategy(config) {
  return normalizeConfig(config).strategies.find((strategy) => strategy.behavior === 'auto') ?? null
}

export function getManualStrategy(config) {
  return (
    normalizeConfig(config).strategies.find((strategy) => strategy.behavior === 'manual') ?? null
  )
}

// 自动策略下的 5 个模式（顺序即判定优先级）。
export function getAutoModes(config) {
  return getAutoStrategy(config)?.modes ?? []
}

export function getManualModes(config) {
  return getManualStrategy(config)?.modes ?? []
}

export function findManualMode(config, modeId) {
  return getManualModes(config).find((mode) => mode.id === modeId) ?? null
}

export function getSalesWeights(config) {
  return normalizeConfig(config).salesWindow.weights
}

// —— 配置方案（Profile）——
// config.json 是「多方案文件」：同一时刻只有 activeProfileId 生效。
export { PROFILE_FILE_VERSION }

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

// 多方案文件：只认 v4；旧文件整体按默认重建。
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

function validateCoefficients(mode, kind, errors) {
  const group = mode.coefficients?.[kind]
  if (!group) {
    if (kind === CUSTOMER_FLOW) {
      errors.push({ message: `${mode.name}：${kind}的系数未配置` })
    }
    return
  }

  for (const category of CATEGORIES) {
    const entry = group[category] ?? {}
    const values = [entry.redLine, entry.normal, entry.peak]
    if (!values.every(Number.isFinite)) {
      errors.push({ message: `${mode.name} · ${kind} · ${category}：红线 / 正常 / 峰值系数必须填写` })
      continue
    }
    if (values.some((value) => value < 0)) {
      errors.push({ message: `${mode.name} · ${kind} · ${category}：系数不能为负数` })
      continue
    }
    if (!(values[0] <= values[1] && values[1] <= values[2])) {
      errors.push({ message: `${mode.name} · ${kind} · ${category}：系数需满足 红线 ≤ 正常 ≤ 峰值` })
    }
  }
}

export function validateConfig(config) {
  const normalized = normalizeConfig(config)
  const errors = []
  const warnings = []
  const autoModes = getAutoModes(normalized)
  const manualModes = getManualModes(normalized)
  const weights = normalized.salesWindow.weights

  const names = new Set()
  autoModes.forEach((mode) => {
    if (!mode.name) {
      errors.push({ message: '模式名称不能为空' })
    } else if (names.has(mode.name)) {
      errors.push({ message: `模式名称「${mode.name}」重复` })
    }
    names.add(mode.name)

    if (mode.range.from !== null && mode.range.to !== null && mode.range.from > mode.range.to) {
      errors.push({
        message: `${mode.name}：月均条数区间下界不能大于上界（${mode.range.from} > ${mode.range.to}）`,
      })
    }
    if (mode.key === 'bulk') errors.push(...validateBulkScoring(mode.healthScoring))

    if (!mode.participates) return
    if (mode.metric === 'none') {
      warnings.push({ message: `${mode.name}：参与计算但未指定比较方式` })
    }
    if (mode.splitByCustomer) {
      validateCoefficients(mode, CUSTOMER_FLOW, errors)
      if (mode.coefficients?.[CUSTOMER_EXCLUSIVE]) {
        validateCoefficients(mode, CUSTOMER_EXCLUSIVE, errors)
      }
    } else {
      validateCoefficients(mode, CUSTOMER_FLOW, errors)
    }
  })

  const total = weights.reduce((sum, entry) => sum + entry.weight, 0)
  for (const entry of weights) {
    if (!Number.isInteger(entry.months) || entry.months < 1 || entry.months > SALES_WINDOW_MAX_MONTHS) {
      errors.push({ message: `销量权重的月数必须是 1–${SALES_WINDOW_MAX_MONTHS} 的整数` })
    }
    if (!Number.isFinite(entry.weight) || entry.weight < 0) {
      errors.push({ message: `销量权重「近 ${entry.months} 个月」必须是非负数字` })
    }
  }
  if (Number.isFinite(total) && Math.abs(total - 1) > 0.001) {
    errors.push({ message: `销量权重之和必须等于 100%，当前为 ${(total * 100).toFixed(1)}%` })
  }

  errors.push(...validateScoring(normalized.scoring))
  errors.push(...validateSpuGrades(normalized.spuGrades))

  const manualNames = new Set()
  manualModes.forEach((mode) => {
    if (!mode.name) {
      errors.push({ message: '手动模式名称不能为空' })
    } else if (manualNames.has(mode.name) || names.has(mode.name)) {
      errors.push({ message: `手动模式名称「${mode.name}」重复` })
    }
    manualNames.add(mode.name)

    if (mode.behavior !== 'custom') return
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
  })

  return { ok: errors.length === 0, errors, warnings }
}
