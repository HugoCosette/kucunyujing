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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function createDefaultCoefficients() {
  return clone(NORMAL_COEFFICIENTS)
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

// 内置默认配置：一个命中热销条件的「模式1」+ 无条件兜底的「默认模式」。
// 这是「恢复默认」的唯一依据，与 src/stocking/config.json 的初始内容保持一致。
export function createDefaultConfig() {
  return {
    version: 1,
    updatedAt: DEFAULT_CONFIG_UPDATED_AT,
    rules: [
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
  }
}
