function matchesFactor(item, factor) {
  const actual = Number(item[factor.field])
  const threshold = Number(factor.value)
  if (!Number.isFinite(actual) || !Number.isFinite(threshold)) return false

  return factor.operator === 'lte' ? actual <= threshold : actual >= threshold
}

export function matchesHeatSpec(item, spec) {
  const factors = spec?.factors ?? []
  return factors.length > 0 && factors.every((factor) => matchesFactor(item, factor))
}

// 按规格顺序取第一个全部条件命中的规格；都不命中时兜底到最后一个规格。
export function resolveHeatLabel(item, specs) {
  if (!specs?.length) return ''
  const matched = specs.find((spec) => matchesHeatSpec(item, spec))
  return (matched ?? specs[specs.length - 1]).label
}

export function applyHeatSpecsToItems(items, specs) {
  for (const item of items) {
    item.stockingType = resolveHeatLabel(item, specs)
  }
}
