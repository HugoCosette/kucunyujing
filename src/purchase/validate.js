// 下单设置的归一化：染厂清单、分单人员表、树形分类、SKU 可选染厂、SKU 分类覆盖、缸规则。
// 这里只保证结构稳定与去重，不做业务校验，页面可以放心地把任意脏数据丢进来。

import { VAT_RULE_NONE, normalizeVatRules } from './vat.js'

export const SETTINGS_VERSION = 3
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

  // 分单人员表：下单时可选的员工总名单。v1 设置没有这个字段，用各分类已维护的人员补齐。
  const assignees = []
  const seenPeople = new Set()
  const addPerson = (value) => {
    const person = typeof value === 'string' ? text(value) : text(value?.name)
    if (!person || seenPeople.has(person)) return
    seenPeople.add(person)
    assignees.push(person)
  }
  for (const person of asArray(source.assignees)) addPerson(person)
  if (!Array.isArray(source.assignees)) {
    for (const entry of treeCategories) {
      for (const person of entry.assignees) addPerson(person)
    }
  }
  // 分类里的人员只能来自分单人员表：名单外的名字下单时选不到，直接清掉。
  for (const entry of treeCategories) {
    entry.assignees = entry.assignees.filter((person) => seenPeople.has(person))
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

  // 缸规则：v1 / v2 设置没有这部分，归一化时补上默认两条规则，升级后即可直接使用。
  const vatRules = normalizeVatRules(source.vatRules)
  const vatRuleIds = new Set(vatRules.map((rule) => rule.id))
  const defaultVatRuleId = vatRuleIds.has(text(source.defaultVatRuleId))
    ? text(source.defaultVatRuleId)
    : vatRules[0]?.id ?? ''

  const vatBindings = (rawBindings) => {
    const result = {}
    for (const [product, ruleId] of Object.entries(asObject(rawBindings))) {
      const key = text(product)
      const value = text(ruleId)
      if (!key) continue
      if (value === VAT_RULE_NONE || vatRuleIds.has(value)) result[key] = value
    }
    return result
  }

  return {
    version: SETTINGS_VERSION,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    dyeFactories,
    assignees,
    treeCategories,
    skuFactories,
    skuCategoryOverrides,
    vatRules,
    defaultVatRuleId,
    spuVatRules: vatBindings(source.spuVatRules),
    skuVatRules: vatBindings(source.skuVatRules),
  }
}

function normalizeOrderEntry(entry, index, keepBlankEntries) {
  if (!entry || typeof entry !== 'object') return null

  const factoryId = text(entry.factoryId)
  const factoryName = text(entry.factoryName)
  const assignee = text(entry.assignee)
  const note = text(entry.note)
  const quantity = toNumber(entry.quantity ?? 0)
  // 完全空白的占位行（没选染厂、没人、没数量、没备注）：落盘时丢弃；
  // 运行时可保留，供「添加分订单」先建行再填写。
  const isBlank = !factoryId && !factoryName && !assignee && !(quantity > 0) && !note
  if (isBlank && !keepBlankEntries) return null

  return {
    id: text(entry.id) || `so-${index + 1}`,
    factoryId,
    factoryName,
    assignee,
    quantity: quantity > 0 ? quantity : 0,
    // 缸快照：下单时的缸数与每缸公斤，导出与对账要能还原当时按什么缸规下的单。
    vatCount: toNumber(entry.vatCount) > 0 ? toNumber(entry.vatCount) : null,
    kgPerVat: toNumber(entry.kgPerVat) > 0 ? toNumber(entry.kgPerVat) : null,
    note,
  }
}

export function normalizeOrders(raw, { keepBlankEntries = false } = {}) {
  const source = asObject(raw)
  const orders = {}

  for (const [skuId, entries] of Object.entries(asObject(source.orders))) {
    const key = text(skuId)
    if (!key) continue
    const normalized = []
    for (const entry of asArray(entries)) {
      const orderEntry = normalizeOrderEntry(entry, normalized.length, keepBlankEntries)
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
