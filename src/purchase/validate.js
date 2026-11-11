// 下单设置的归一化：染厂清单、树形分类与分单人员、SKU 可选染厂、SKU 分类覆盖。
// 这里只保证结构稳定与去重，不做业务校验，页面可以放心地把任意脏数据丢进来。

export const SETTINGS_VERSION = 1
export const ORDERS_VERSION = 1

function text(value) {
  return String(value ?? '').trim()
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

// id 必须唯一：重命名工厂时 id 保持不变，SKU 与分订单的引用才不会断。
function uniqueId(base, used) {
  let id = base
  let index = 2
  while (used.has(id)) {
    id = `${base}-${index}`
    index += 1
  }
  used.add(id)
  return id
}

export function normalizeSettings(raw) {
  const source = asObject(raw)

  const usedFactoryIds = new Set()
  const seenFactoryNames = new Set()
  const dyeFactories = []
  for (const entry of asArray(source.dyeFactories)) {
    const name = text(entry?.name)
    if (!name || seenFactoryNames.has(name)) continue
    seenFactoryNames.add(name)
    const baseId = text(entry?.id) || `df-${dyeFactories.length + 1}`
    dyeFactories.push({
      id: uniqueId(baseId, usedFactoryIds),
      name,
      enabled: entry?.enabled !== false,
    })
  }

  const seenCategories = new Set()
  const treeCategories = []
  for (const entry of asArray(source.treeCategories)) {
    const name = text(entry?.name)
    if (!name || seenCategories.has(name)) continue
    seenCategories.add(name)

    const seenAssignees = new Set()
    const assignees = []
    for (const person of asArray(entry?.assignees)) {
      const personName = typeof person === 'string' ? text(person) : text(person?.name)
      if (!personName || seenAssignees.has(personName)) continue
      seenAssignees.add(personName)
      assignees.push(personName)
    }
    treeCategories.push({ name, assignees })
  }

  const factoryIds = new Set(dyeFactories.map((factory) => factory.id))
  const skuFactories = {}
  for (const [skuId, ids] of Object.entries(asObject(source.skuFactories))) {
    const key = text(skuId)
    if (!key) continue
    const picked = [...new Set(asArray(ids).map(text))].filter((id) => factoryIds.has(id))
    if (picked.length) skuFactories[key] = picked
  }

  const skuCategoryOverrides = {}
  for (const [skuId, category] of Object.entries(asObject(source.skuCategoryOverrides))) {
    const key = text(skuId)
    const value = text(category)
    if (key && value) skuCategoryOverrides[key] = value
  }

  return {
    version: SETTINGS_VERSION,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    dyeFactories,
    treeCategories,
    skuFactories,
    skuCategoryOverrides,
  }
}

function normalizeOrderEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null

  const factoryId = text(entry.factoryId)
  const factoryName = text(entry.factoryName)
  const assignee = text(entry.assignee)
  const note = text(entry.note)
  const quantity = toNumber(entry.quantity ?? 0)
  // 完全空白的占位行（没选染厂、没人、没数量、没备注）直接丢弃。
  if (!factoryId && !factoryName && !assignee && !(quantity > 0) && !note) return null

  return {
    id: text(entry.id) || `so-${index + 1}`,
    factoryId,
    factoryName,
    assignee,
    quantity: quantity > 0 ? quantity : 0,
    note,
  }
}

export function normalizeOrders(raw) {
  const source = asObject(raw)
  const orders = {}

  for (const [skuId, entries] of Object.entries(asObject(source.orders))) {
    const key = text(skuId)
    if (!key) continue
    const normalized = []
    for (const entry of asArray(entries)) {
      const orderEntry = normalizeOrderEntry(entry, normalized.length)
      if (orderEntry) normalized.push(orderEntry)
    }
    if (normalized.length) orders[key] = normalized
  }

  return {
    version: ORDERS_VERSION,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    orders,
  }
}
