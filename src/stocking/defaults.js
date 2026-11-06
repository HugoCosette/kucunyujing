import { createThresholds } from './fields.js'

const HOT_COEFFICIENTS = {
  黑白: { redLine: 3, normal: 5, peak: 8 },
  彩色: { redLine: 2, normal: 4, peak: 6 },
}

const NORMAL_COEFFICIENTS = {
  黑白: { redLine: 2, normal: 4, peak: 6 },
  彩色: { redLine: 2, normal: 4, peak: 6 },
}

const DEFAULT_CONFIG_UPDATED_AT = '2026-11-04T00:00:00.000Z'

// 手动策略下内置的两种模式：行为由代码提供，名称与参数可由使用者调整。
export const BUILTIN_MANUAL_MODES = [
  {
    id: 'manual-custom',
    name: '自定模式',
    behavior: 'custom',
    description: '由人工为该 SKU 指定红线 / 正常 / 峰值系数',
    defaultCoefficients: { redLine: 2, normal: 4, peak: 6 },
  },
  {
    id: 'manual-slow',
    name: '滞销模式',
    behavior: 'slow',
    description: '不参与备货：不计预警、不进紧急补货、不给建议值',
  },
]

// 策略层：自动策略装「模式 → 评分档」，手动策略装「手动模式」。
export const BUILTIN_STRATEGIES = [
  { id: 'auto', name: '自动策略', behavior: 'auto' },
  { id: 'manual', name: '手动策略', behavior: 'manual' },
]

export const MANUAL_BEHAVIORS = [
  { value: 'custom', label: '自定系数', hint: '给每个 SKU 单独指定系数' },
  { value: 'slow', label: '滞销', hint: '不参与备货排名与预警' },
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function createDefaultCoefficients() {
  return clone(NORMAL_COEFFICIENTS)
}

export function createDefaultManualMode(overrides = {}) {
  const source = overrides ?? {}
  const behavior = source.behavior === 'slow' ? 'slow' : 'custom'
  const mode = {
    id: source.id ?? `manual-${behavior}-${Date.now().toString(36)}`,
    name: source.name ?? (behavior === 'slow' ? '滞销模式' : '自定模式'),
    behavior,
    description: source.description ?? '',
  }
  if (behavior === 'custom') {
    mode.defaultCoefficients = source.defaultCoefficients ?? clone(NORMAL_COEFFICIENTS['黑白'])
  }
  return mode
}

export function createDefaultTier(overrides = {}) {
  return {
    id: overrides.id ?? 'tier-default',
    name: overrides.name ?? '默认档',
    isDefault: overrides.isDefault ?? true,
    conditions: overrides.conditions ?? [],
    coefficients: overrides.coefficients ?? createDefaultCoefficients(),
  }
}

export function createDefaultRule(overrides = {}) {
  const source = overrides ?? {}
  const id = source.id ?? 'rule-default'
  return {
    id,
    name: source.name ?? '默认模式',
    isDefault: source.isDefault ?? true,
    factors: source.factors ?? [],
    grades: source.grades ?? { monthlyAvgCount: createThresholds('monthlyAvgCount') },
    tiers: source.tiers ?? [createDefaultTier({ id: `${id}-tier-default` })],
  }
}

// 内置默认配置：自动策略（模式1 + 无条件兜底的默认模式）+ 手动策略（自定模式 / 滞销模式）。
// 这是「恢复默认」的唯一依据，与 src/stocking/config.json 的初始内容保持一致。
export function createDefaultConfig() {
  return {
    version: 2,
    updatedAt: DEFAULT_CONFIG_UPDATED_AT,
    strategies: [
      {
        ...BUILTIN_STRATEGIES[0],
        modes: [
          {
            id: 'rule-1',
            name: '模式1',
            isDefault: false,
            factors: [
              { field: 'monthlyAvgCount', operator: 'gte', value: 200 },
              { field: 'totalOrders', operator: 'gte', value: 10 },
            ],
            grades: {
              monthlyAvgCount: createThresholds('monthlyAvgCount'),
              totalOrders: createThresholds('totalOrders'),
            },
            tiers: [
              {
                id: 'rule-1-tier-hot-a',
                name: '热销A',
                isDefault: false,
                conditions: [{ grade: 'S', operator: 'gte', count: 2 }],
                coefficients: clone(HOT_COEFFICIENTS),
              },
              {
                id: 'rule-1-tier-default',
                name: '默认档',
                isDefault: true,
                conditions: [],
                coefficients: clone(NORMAL_COEFFICIENTS),
              },
            ],
          },
          {
            id: 'rule-default',
            name: '默认模式',
            isDefault: true,
            factors: [],
            grades: { monthlyAvgCount: createThresholds('monthlyAvgCount') },
            tiers: [
              {
                id: 'rule-default-tier-default',
                name: '默认档',
                isDefault: true,
                conditions: [],
                coefficients: clone(NORMAL_COEFFICIENTS),
              },
            ],
          },
        ],
      },
      {
        ...BUILTIN_STRATEGIES[1],
        modes: clone(BUILTIN_MANUAL_MODES),
      },
    ],
  }
}
