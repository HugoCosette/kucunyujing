// 下单设置的归一化：染厂清单、分单人员表、树形分类、SKU 可选染厂、SKU 分类覆盖、缸规则。
// 这里只保证结构稳定与去重，不做业务校验，页面可以放心地把任意脏数据丢进来。

import { VAT_RULE_NONE, normalizeVatRules } from './vat.js'

export const SETTINGS_VERSION = 3
export const ORDERS_VERSION = 2

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

function normalizeDraftEntry(entry, index, keepBlankEntries) {
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
    // 缸数只存整数（公斤可以不整缸，此时 vatCount 为空、只留每缸公斤）。
    vatCount: toNumber(entry.vatCount) >= 1 ? Math.round(toNumber(entry.vatCount)) : null,
    kgPerVat: toNumber(entry.kgPerVat) > 0 ? toNumber(entry.kgPerVat) : null,
    note,
  }
}

// 订单状态只两种：有效 / 作废。到货进度由 receipts 求和派生，不另设状态。
export const ORDER_STATUS = { ACTIVE: 'active', CANCELLED: 'cancelled' }

function monthOf(iso) {
  const stamp = text(iso)
  return /^\d{4}-\d{2}/.test(stamp) ? stamp.slice(0, 7) : ''
}

function normalizeReceipt(receipt, index) {
  if (!receipt || typeof receipt !== 'object') return null
  const qty = toNumber(receipt.qty ?? receipt.quantity)
  if (!(qty > 0)) return null
  return {
    id: text(receipt.id) || `rc-${index + 1}`,
    at: text(receipt.at) || new Date().toISOString(),
    qty,
    by: text(receipt.by),
    // 撤回留痕：有 voidedAt 的记录留在列表里灰显，但不计入已到货（数量退回待收）。
    voidedAt: text(receipt.voidedAt) || null,
  }
}

// 一张分订单 = SKU × 染厂的一行流水，只追加、不物理删除。
// receivedQty 一律由 receipts 求和派生，不信任外部传入的旧值。
function normalizeOrder(order, index) {
  if (!order || typeof order !== 'object') return null

  const skuId = text(order.skuId)
  const factoryId = text(order.factoryId)
  const factoryName = text(order.factoryName)
  const assignee = text(order.assignee)
  const note = text(order.note)
  const quantity = toNumber(order.quantity ?? 0)
  const isBlank = !skuId || (!factoryId && !factoryName && !assignee && !(quantity > 0) && !note)
  if (isBlank) return null

  const receipts = asArray(order.receipts)
    .map((receipt, receiptIndex) => normalizeReceipt(receipt, receiptIndex))
    .filter(Boolean)
  const submittedAt = text(order.submittedAt) || text(order.createdAt) || new Date().toISOString()

  return {
    id: text(order.id) || `so-${index + 1}`,
    batchId: text(order.batchId),
    skuId,
    product: text(order.product),
    color: text(order.color),
    factoryId,
    factoryName,
    assignee,
    quantity: quantity > 0 ? quantity : 0,
    vatCount: toNumber(order.vatCount) >= 1 ? Math.round(toNumber(order.vatCount)) : null,
    kgPerVat: toNumber(order.kgPerVat) > 0 ? toNumber(order.kgPerVat) : null,
    note,
    status:
      text(order.status) === ORDER_STATUS.CANCELLED ? ORDER_STATUS.CANCELLED : ORDER_STATUS.ACTIVE,
    submittedAt,
    updatedAt: text(order.updatedAt) || submittedAt,
    month: text(order.month) || monthOf(submittedAt),
    receivedQty: receipts.reduce((sum, receipt) => sum + (receipt.voidedAt ? 0 : receipt.qty), 0),
    receipts,
    revisions: asArray(order.revisions).filter(
      (revision) => revision && typeof revision === 'object',
    ),
    cancelledAt: text(order.cancelledAt) || null,
  }
}

function normalizeDrafts(raw, keepBlankEntries) {
  const drafts = {}
  for (const [skuId, entries] of Object.entries(asObject(raw))) {
    const key = text(skuId)
    if (!key) continue
    const normalized = []
    for (const entry of asArray(entries)) {
      const draftEntry = normalizeDraftEntry(entry, normalized.length, keepBlankEntries)
      if (draftEntry) normalized.push(draftEntry)
    }
    if (normalized.length) drafts[key] = normalized
  }
  return drafts
}

// v1 的 orders 是按 SKU 覆盖的 map，逐条迁成 active 订单：老数据都是已经发给染厂的单，按已下单处理。
function migrateLegacyOrders(source, updatedAt) {
  const orders = []
  for (const [skuId, entries] of Object.entries(asObject(source.orders))) {
    const key = text(skuId)
    if (!key) continue
    for (const entry of asArray(entries)) {
      const draftEntry = normalizeDraftEntry(entry, orders.length, false)
      if (!draftEntry) continue
      orders.push({
        ...draftEntry,
        id: `so-legacy-${orders.length + 1}`,
        batchId: `legacy-${updatedAt}`,
        skuId: key,
        product: text(entry.product),
        color: text(entry.color),
        status: ORDER_STATUS.ACTIVE,
        submittedAt: updatedAt,
        updatedAt,
        month: monthOf(updatedAt),
        receivedQty: 0,
        receipts: [],
        revisions: [],
        cancelledAt: null,
      })
    }
  }
  return orders
}

export function normalizeOrders(raw, { keepBlankEntries = false } = {}) {
  const source = asObject(raw)
  const updatedAt =
    typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString()

  const drafts = normalizeDrafts(source.drafts, keepBlankEntries)
  // v2 的 orders 是流水数组；v1 是 map，读一次即迁移成 active 订单。
  const orders = Array.isArray(source.orders)
    ? source.orders.map((order, index) => normalizeOrder(order, index)).filter(Boolean)
    : migrateLegacyOrders(source, updatedAt)

  return {
    version: ORDERS_VERSION,
    updatedAt,
    drafts,
    orders,
  }
}
