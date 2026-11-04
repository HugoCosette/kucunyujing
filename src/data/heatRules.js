import { HEAT_FACTOR_FIELDS } from './quantityFields.js'
import { stockingRules } from './stockingRules.js'

export const HEAT_TYPES = ['热销', '常规']
export const HEAT_CATEGORIES = ['黑白', '彩色']

export const HEAT_OPERATORS = [
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
]

export const COEFFICIENT_FIELDS = [
  { key: 'redLine', label: '红线' },
  { key: 'normal', label: '正常' },
  { key: 'peak', label: '峰值' },
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function getHeatFieldLabel(field) {
  return HEAT_FACTOR_FIELDS.find((entry) => entry.field === field)?.label ?? field
}

// 默认规格：热销A 优先匹配，未命中时兜底到 常规A；系数沿用原有规则表。
// 阈值按动销指标量级取整，可在配置信息页调整。
export function createDefaultHeatSpecs() {
  return [
    {
      id: 'heat-hot-a',
      type: '热销',
      label: '热销A',
      factors: [
        { field: 'monthlyAvgCount', operator: 'gte', value: 2000 },
        { field: 'activeCustomers', operator: 'gte', value: 5 },
      ],
      coefficients: clone(stockingRules['热销']),
    },
    {
      id: 'heat-regular-a',
      type: '常规',
      label: '常规A',
      factors: [{ field: 'monthlyAvgCount', operator: 'gte', value: 0 }],
      coefficients: clone(stockingRules['常规']),
    },
  ]
}

export function cloneHeatSpecs(specs) {
  return clone(specs ?? [])
}

// 按类型自动取下一个字母：热销B、热销C…… / 常规B、常规C……
export function nextHeatLabel(specs, type) {
  const usedLabels = new Set((specs ?? []).map((spec) => spec.label))
  for (let index = 0; index < 26; index += 1) {
    const label = `${type}${String.fromCharCode(65 + index)}`
    if (!usedLabels.has(label)) return label
  }
  return `${type}Z`
}

export function createHeatSpec(specs, type) {
  const sameType = (specs ?? []).filter((spec) => spec.type === type)
  const source = sameType[sameType.length - 1] ?? specs?.[specs.length - 1]
  const coefficients = source
    ? clone(source.coefficients)
    : Object.fromEntries(
        HEAT_CATEGORIES.map((category) => [
          category,
          { redLine: 0, normal: 0, peak: 0 },
        ]),
      )

  return {
    id: `heat-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    label: nextHeatLabel(specs, type),
    factors: source ? clone(source.factors) : [],
    coefficients,
  }
}

// 备货计算仍按规格名称查系数。
export function toCoefficientMap(specs) {
  return Object.fromEntries(
    (specs ?? []).map((spec) => [spec.label, spec.coefficients]),
  )
}
