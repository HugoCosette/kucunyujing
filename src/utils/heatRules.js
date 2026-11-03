import { HEAT_TYPES } from '@/data/heatRules'

function matchesFactor(item, factor) {
  const actual = Number(item[factor.field])
  const threshold = Number(factor.value)
  if (!Number.isFinite(actual) || !Number.isFinite(threshold)) return false

  return factor.operator === 'lte' ? actual <= threshold : actual >= threshold
}

export function matchesHeatConfig(item, factors) {
  return factors.length > 0 && factors.every((factor) => matchesFactor(item, factor))
}

// 确认口径：满足“热销”全部条件即为热销，其余一律常规。
export function resolveHeatType(item, heatConfig) {
  const hotFactors = heatConfig?.[HEAT_TYPES[0]] ?? []
  return matchesHeatConfig(item, hotFactors) ? HEAT_TYPES[0] : HEAT_TYPES[1]
}

export function applyHeatConfigToItems(items, heatConfig) {
  for (const item of items) {
    item.stockingType = resolveHeatType(item, heatConfig)
  }
}
