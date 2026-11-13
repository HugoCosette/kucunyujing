import { gunzipSync, strFromU8 } from 'fflate'

// 事实层（导入的库存 + 销售表）与计划层（需安排 / 采购清单 / 撤销快照）之间的序列化口径。
// 三层数据绝不互相覆盖：快照只留事实，需安排一律按 skuId 单独存、加载时重新挂回行上。

export const PAYLOAD_VERSION = 1

// 快照里不保存 planned：回滚到旧导入时不能把本周的备货决定一起回滚掉。
const ITEM_ARRAY_FIELDS = ['monthSales', 'monthCounts']

function plainItem(item) {
  const copy = { ...item, planned: null }
  // 数组字段是 Vue 的响应式代理，展开成普通数组后才好压缩与还原。
  for (const field of ITEM_ARRAY_FIELDS) {
    const value = copy[field]
    if (Array.isArray(value)) copy[field] = [...value]
  }
  return copy
}

function plainNumberArray(value) {
  return Array.isArray(value) ? value.map((entry) => (Number.isFinite(entry) ? entry : null)) : []
}

export function serializeSalesSheet(sheet) {
  if (!sheet) return null
  return {
    fileName: sheet.fileName ?? '',
    sheetName: sheet.sheetName ?? '',
    months: plainNumberArray(sheet.months),
    metricFields: Array.isArray(sheet.metricFields) ? [...sheet.metricFields] : [],
    baselineMonth: Number.isFinite(sheet.baselineMonth) ? sheet.baselineMonth : null,
    // Map 直接 JSON.stringify 会变成 {}，必须转成二维数组。
    bySku: sheet.bySku instanceof Map ? [...sheet.bySku.entries()] : [],
  }
}

export function reviveSalesSheet(raw) {
  if (!raw) return null
  return {
    fileName: raw.fileName ?? '',
    sheetName: raw.sheetName ?? '',
    months: Array.isArray(raw.months) ? [...raw.months] : [],
    metricFields: Array.isArray(raw.metricFields) ? [...raw.metricFields] : [],
    baselineMonth: Number.isFinite(raw.baselineMonth) ? raw.baselineMonth : null,
    bySku: new Map(Array.isArray(raw.bySku) ? raw.bySku : []),
  }
}

// 快照正文：事实层整份 JSON 文本，压缩交给 Worker。
// 注意：正文里不放时间戳，否则同一份文件重复导入会算出不同的内容哈希，5 个名额会被同一份数据占满。
export function buildSnapshotText(store, meta = {}) {
  const payload = {
    version: PAYLOAD_VERSION,
    meta: {
      inventoryFileName: meta.inventoryFileName ?? '',
      salesFileName: meta.salesFileName ?? '',
    },
    items: store.inventoryItems.map(plainItem),
    sales: serializeSalesSheet(store.salesSheet),
  }
  return JSON.stringify(payload)
}

export function parseSnapshotText(text) {
  const payload = JSON.parse(text)
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    salesSheet: reviveSalesSheet(payload.sales),
    meta: payload.meta ?? {},
  }
}

export function gunzipText(bytes) {
  return strFromU8(gunzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
}

function skuIdOf(item) {
  return String(item?.skuId ?? '').trim()
}

// 计划层：需安排以 skuId 为键（导入后行 id 会重排，用 id 会错位）。
// 已有但当前快照里没有的 SKU 保留在 plans 里，等它重新出现时自动挂回。
export function collectPlanLayer(store, previousPlans = {}) {
  const plans = { ...previousPlans }
  const skuIdById = new Map()

  for (const item of store.inventoryItems) {
    const skuId = skuIdOf(item)
    if (skuId) skuIdById.set(item.id, skuId)
    const planned = Number(item.planned)
    if (!skuId) continue
    if (Number.isFinite(planned) && planned > 0) plans[skuId] = planned
    else delete plans[skuId]
  }

  const purchaseList = []
  for (const entry of store.purchaseList) {
    const skuId = String(entry.skuId ?? '').trim() || skuIdById.get(entry.id) || ''
    if (!skuId) continue
    purchaseList.push({
      skuId,
      product: entry.product ?? '',
      color: entry.color ?? '',
      planned: Number(entry.planned) || 0,
    })
  }

  const undoHistory = {}
  for (const [id, undo] of Object.entries(store.plannedUndoHistory ?? {})) {
    const skuId = skuIdById.get(Number(id))
    if (!skuId || !undo) continue
    undoHistory[skuId] = {
      previousPlanned: Number.isFinite(undo.previousPlanned) ? undo.previousPlanned : null,
      previousPurchasePlanned: undo.previousPurchaseItem
        ? Number(undo.previousPurchaseItem.planned) || 0
        : null,
    }
  }

  return { plans, purchaseList, undoHistory }
}

// 把计划层按 skuId 挂回事实层；挂不上的（快照里已没有这个 SKU）跳过，plans 里仍然保留。
export function applyPlanLayer(items, layer = {}) {
  const itemBySkuId = new Map()
  for (const item of items) {
    item.planned = null
    const skuId = skuIdOf(item)
    if (skuId) itemBySkuId.set(skuId, item)
  }

  let unmatched = 0
  for (const [skuId, planned] of Object.entries(layer.plans ?? {})) {
    const item = itemBySkuId.get(skuId)
    if (!item) {
      unmatched += 1
      continue
    }
    item.planned = planned
  }

  const purchaseList = []
  for (const entry of layer.purchaseList ?? []) {
    const item = itemBySkuId.get(String(entry.skuId ?? '').trim())
    if (!item) continue
    purchaseList.push({
      id: item.id,
      skuId: item.skuId,
      product: item.product,
      color: item.color,
      planned: Number(entry.planned) || 0,
    })
  }

  const plannedUndoHistory = {}
  for (const [skuId, undo] of Object.entries(layer.undoHistory ?? {})) {
    const item = itemBySkuId.get(skuId)
    if (!item || !undo) continue
    plannedUndoHistory[item.id] = {
      previousPlanned: Number.isFinite(undo.previousPlanned) ? undo.previousPlanned : null,
      previousPurchaseItem:
        undo.previousPurchasePlanned === null || undo.previousPurchasePlanned === undefined
          ? null
          : {
              id: item.id,
              skuId: item.skuId,
              product: item.product,
              color: item.color,
              planned: Number(undo.previousPurchasePlanned) || 0,
            },
    }
  }

  return { purchaseList, plannedUndoHistory, unmatched }
}
