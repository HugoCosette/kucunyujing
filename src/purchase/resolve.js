// 下单选项的解析口径：给定设置与 SKU，算出"这个 SKU 能选哪些染厂 / 哪些分单人员"。
// 页面只调用这里，不要在组件里各写一份回退规则。

export function enabledFactories(settings) {
  return (settings?.dyeFactories ?? []).filter((factory) => factory.enabled !== false)
}

// SKU 可选的染厂：单独配置过就只列那几个；没配置（或配的都被停用）时回退到全部启用的染厂。
export function factoriesForSku(settings, skuId) {
  const all = enabledFactories(settings)
  const ids = settings?.skuFactories?.[String(skuId ?? '').trim()]
  if (!Array.isArray(ids) || ids.length === 0) return all

  const picked = all.filter((factory) => ids.includes(factory.id))
  return picked.length ? picked : all
}

// 一个 SKU 只有一个树形分类：人工覆盖优先，其次用导入行自带的分类。
export function categoryForSku(settings, skuId, importedCategory) {
  const key = String(skuId ?? '').trim()
  const override = key ? settings?.skuCategoryOverrides?.[key] : ''
  if (override) return override
  return String(importedCategory ?? '').trim()
}

export function assigneesForCategory(settings, category) {
  const name = String(category ?? '').trim()
  if (!name) return []
  const entry = (settings?.treeCategories ?? []).find((item) => item.name === name)
  return entry?.assignees ?? []
}

// 分类没维护人员时退化为"全部人员"，避免下单被名单缺失卡住。
export function assigneesForSku(settings, skuId, importedCategory) {
  const names = assigneesForCategory(settings, categoryForSku(settings, skuId, importedCategory))
  if (names.length) return names
  return [...new Set((settings?.treeCategories ?? []).flatMap((item) => item.assignees))]
}

export function findFactoryById(settings, factoryId) {
  const id = String(factoryId ?? '').trim()
  return (settings?.dyeFactories ?? []).find((factory) => factory.id === id) ?? null
}

export function findFactoryByName(settings, name) {
  const target = String(name ?? '').trim()
  if (!target) return null
  return (settings?.dyeFactories ?? []).find((factory) => factory.name === target) ?? null
}

// 分订单合计：需安排是公斤，这里同口径累加。
export function summarizeOrders(entries) {
  let total = 0
  let counted = 0
  for (const entry of entries ?? []) {
    const quantity = Number(entry?.quantity)
    if (Number.isFinite(quantity) && quantity > 0) {
      total += quantity
      counted += 1
    }
  }
  return { total, counted }
}
