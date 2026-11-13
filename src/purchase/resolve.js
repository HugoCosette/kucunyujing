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

// 分单人员优先取该 SKU 树形分类里维护的人；分类没维护人员时回退到
// 「分单人员表」的全部人员，避免下单时下拉为空、无人可选。
export function assigneesForSku(settings, skuId, importedCategory) {
  const names = assigneesForCategory(settings, categoryForSku(settings, skuId, importedCategory))
  if (names.length) return names
  return [...(settings?.assignees ?? [])]
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

// 分订单合计：需安排是公斤，这里同口径累加；缸数单独合计，方便和染厂对缸。
export function summarizeOrders(entries) {
  let total = 0
  let counted = 0
  let vats = 0
  for (const entry of entries ?? []) {
    const quantity = Number(entry?.quantity)
    if (Number.isFinite(quantity) && quantity > 0) {
      total += quantity
      counted += 1
      const vatCount = Number(entry?.vatCount)
      if (Number.isFinite(vatCount) && vatCount > 0) vats += vatCount
    }
  }
  return { total, counted, vats }
}

const EMPTY_ORDER_ENTRY = Object.freeze({
  ordered: 0,
  received: 0,
  pending: 0,
  count: 0,
  vats: 0,
  orders: [],
})

// 订单聚合索引：按唯一标识汇总 active 订单。主面板「备货」列与预计库存都只读它，
// 作废（cancelled）的订单保留在流水里，但不参与任何统计。
export function buildOrderIndex(orders) {
  const index = new Map()

  for (const order of orders ?? []) {
    if (order?.status !== 'active') continue
    const key = String(order.skuId ?? '').trim()
    if (!key) continue

    const entry = index.get(key) ?? {
      ordered: 0,
      received: 0,
      pending: 0,
      count: 0,
      vats: 0,
      orders: [],
    }

    const quantity = Number(order.quantity)
    entry.ordered += Number.isFinite(quantity) && quantity > 0 ? quantity : 0
    const received = Number(order.receivedQty)
    entry.received += Number.isFinite(received) && received > 0 ? received : 0
    const vatCount = Number(order.vatCount)
    if (Number.isFinite(vatCount) && vatCount > 0) entry.vats += vatCount
    entry.count += 1
    entry.orders.push(order)
    index.set(key, entry)
  }

  for (const entry of index.values()) {
    entry.pending = Math.max(0, entry.ordered - entry.received)
  }
  return index
}

export function orderSummaryOf(index, skuId) {
  const key = String(skuId ?? '').trim()
  return (key && index?.get(key)) || EMPTY_ORDER_ENTRY
}
