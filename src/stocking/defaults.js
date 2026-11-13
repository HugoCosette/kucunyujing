import {
  CUSTOMER_EXCLUSIVE,
  CUSTOMER_FLOW,
  createDefaultSalesWeights,
} from './constants.js'
import { createDefaultScoring, BULK_SCORING_DEFAULTS } from './scoring.js'
import { createDefaultSpuGrades } from './spuGrades.js'

export const CONFIG_VERSION = 4
export const PROFILE_FILE_VERSION = 4
export const DEFAULT_PROFILE_ID = 'production'
export const DEFAULT_PROFILE_NAME = '生产配置'

const DEFAULT_CONFIG_UPDATED_AT = '2026-11-10T00:00:00.000Z'

function coefficients(white, color) {
  return { 黑白: { ...white }, 彩色: { ...color } }
}

// 策略层：自动策略装「5 个固定模式」，手动策略装「手动模式」。
export const BUILTIN_STRATEGIES = [
  { id: 'auto', name: '自动策略', behavior: 'auto' },
  { id: 'manual', name: '手动策略', behavior: 'manual' },
]

// 手动策略下内置的两种模式：行为由代码提供，名称与参数可由使用者调整。
export const BUILTIN_MANUAL_MODES = [
  {
    id: 'manual-custom',
    name: '自定系数模式',
    behavior: 'custom',
    description: '由人工为该 SKU 指定红线 / 正常 / 峰值系数（单位：公斤）',
    defaultCoefficients: { redLine: 20, normal: 40, peak: 60 },
  },
  {
    id: 'manual-order',
    name: '订单货模式',
    behavior: 'order',
    description: '按客户订单填量：不计预警、不做评分，需安排填多少就下多少',
  },
]

// 行为的默认名称与列标签：改名只会改到实例上，新建的模式仍取这里的默认值。
export const MANUAL_BEHAVIOR_NAMES = {
  custom: '自定系数模式',
  order: '订单货模式',
}

export const MANUAL_BEHAVIOR_LABELS = {
  custom: '自定系数',
  order: '订单货',
}

export const MANUAL_BEHAVIORS = [
  { value: 'custom', label: '自定系数', hint: '给每个 SKU 单独指定系数' },
  { value: 'order', label: '订单货', hint: '按客户订单填量，不参与预警与评分' },
]

export function normalizeManualBehavior(value) {
  return value === 'order' ? 'order' : 'custom'
}

// 自动策略的 5 个模式（顺序即判定优先级）。
// 判定只看「月均条数」，按顺序命中第一条「区间包含该值」的模式：
// 热销 30~不限 → 常规 10~30 → 按量 3~10 → 尾货 0.01~3 → 滞销 0~0.01。
// 区间端点留空表示不限（下限按 0、上限按正无穷）。
export function createDefaultAutoModes() {
  return [
    {
      key: 'hot',
      name: '热销',
      range: { from: 30, to: null },
      metric: 'days',
      participates: true,
      splitByCustomer: true,
      coefficients: {
        [CUSTOMER_FLOW]: coefficients(
          { redLine: 20, normal: 40, peak: 60 },
          { redLine: 15, normal: 30, peak: 45 },
        ),
        [CUSTOMER_EXCLUSIVE]: null,
      },
    },
    {
      key: 'normal',
      name: '常规',
      range: { from: 10, to: 30 },
      metric: 'days',
      participates: true,
      splitByCustomer: true,
      coefficients: {
        [CUSTOMER_FLOW]: coefficients(
          { redLine: 15, normal: 30, peak: 45 },
          { redLine: 10, normal: 20, peak: 30 },
        ),
        [CUSTOMER_EXCLUSIVE]: null,
      },
    },
    {
      key: 'bulk',
      name: '按量',
      range: { from: 3, to: 10 },
      metric: 'stock',
      participates: true,
      splitByCustomer: true,
      // 按量弹窗的 2 项健康度判定区间：进销比 40% ~ 60% 正常、累计客户 5 ~ 10 个中风险。
      healthScoring: {
        ratio: { ...BULK_SCORING_DEFAULTS.ratio },
        customers: { ...BULK_SCORING_DEFAULTS.customers },
      },
      coefficients: {
        [CUSTOMER_FLOW]: coefficients(
          { redLine: 40, normal: 80, peak: 200 },
          { redLine: 40, normal: 80, peak: 120 },
        ),
        [CUSTOMER_EXCLUSIVE]: null,
      },
    },
    {
      key: 'tail',
      name: '尾货',
      range: { from: 0.01, to: 3 },
      metric: 'none',
      participates: false,
      splitByCustomer: false,
      coefficients: null,
    },
    {
      key: 'slow',
      name: '滞销',
      range: { from: 0, to: 0.01 },
      metric: 'none',
      participates: false,
      splitByCustomer: false,
      coefficients: null,
    },
  ]
}

export function createDefaultManualMode(overrides = {}) {
  const source = overrides ?? {}
  const behavior = normalizeManualBehavior(source.behavior)
  const mode = {
    id: String(source.id ?? `manual-${behavior}-${Date.now().toString(36)}`),
    name: source.name ?? MANUAL_BEHAVIOR_NAMES[behavior] ?? MANUAL_BEHAVIOR_NAMES.custom,
    behavior,
    description: source.description ?? '',
  }
  if (behavior === 'custom') {
    mode.defaultCoefficients = source.defaultCoefficients ?? {
      redLine: 20,
      normal: 40,
      peak: 60,
    }
  }
  return mode
}

// 内置默认配置：自动策略（5 个模式）+ 手动策略（自定系数 / 订单货）。
// 这是「恢复默认」的唯一依据，与 src/stocking/config.json 的初始内容保持一致。
export function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    updatedAt: DEFAULT_CONFIG_UPDATED_AT,
    salesWindow: { weights: createDefaultSalesWeights() },
    scoring: createDefaultScoring(),
    spuGrades: createDefaultSpuGrades(),
    strategies: [
      { ...BUILTIN_STRATEGIES[0], modes: createDefaultAutoModes() },
      {
        ...BUILTIN_STRATEGIES[1],
        modes: BUILTIN_MANUAL_MODES.map((mode) => createDefaultManualMode(mode)),
      },
    ],
  }
}

// 多方案文件的默认内容：只含「生产配置」一个方案。
export function createDefaultProfileFile() {
  return {
    version: PROFILE_FILE_VERSION,
    updatedAt: DEFAULT_CONFIG_UPDATED_AT,
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: DEFAULT_PROFILE_NAME,
        config: createDefaultConfig(),
      },
    ],
  }
}
