import { QUANTITY_FIELDS } from './quantityFields.js'

export const HEAT_TYPES = ['热销', '常规']

export const HEAT_OPERATORS = [
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
]

export function getHeatFieldLabel(field) {
  return QUANTITY_FIELDS.find((entry) => entry.field === field)?.label ?? field
}

// 默认阈值按现有种子数据的分布挑选，约 42 个 SKU 命中热销、其余归常规。
export function createDefaultHeatConfig() {
  return {
    热销: [
      { field: 'producing', operator: 'gte', value: 500 },
      { field: 'weeklyUsage', operator: 'gte', value: 700 },
    ],
    常规: [
      { field: 'producing', operator: 'gte', value: 0 },
      { field: 'weeklyUsage', operator: 'gte', value: 0 },
    ],
  }
}

export function cloneHeatConfig(config) {
  return Object.fromEntries(
    HEAT_TYPES.map((type) => [
      type,
      (config?.[type] ?? []).map((factor) => ({ ...factor })),
    ]),
  )
}
