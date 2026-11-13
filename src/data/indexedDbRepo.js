import {
  STORE_DOCUMENTS,
  STORE_META,
  STORE_SNAPSHOTS,
  dbClear,
  dbDelete,
  dbGet,
  dbPut,
  isIndexedDbAvailable,
} from './db.js'

// 阶段一（本机 IndexedDB）的实现。对外只暴露「文档 / 快照 / 元信息」三类读写，
// 页面与 store 一律通过 repo.js 调用，换成阶段二的 HTTP 实现时调用方不用改。

export const META_KEY_WORKSPACE = 'workspace'
export const META_KEY_SNAPSHOT_INDEX = 'snapshots'

// 订单与草稿体积最大，单独成一份文档；设置类（下单设置 / 备货方案 / 手动清单 / 屏蔽清单）
// 仍是小体量，继续走 localStorage，只在「导出全部数据」时一起打包。
export const DOC_KEY_ORDERS = 'purchaseOrders'

export { isIndexedDbAvailable }

export async function readMeta(key) {
  const record = await dbGet(STORE_META, key)
  return record?.value ?? null
}

export async function writeMeta(key, value) {
  await dbPut(STORE_META, { key, value, updatedAt: new Date().toISOString() })
  return value
}

export async function readDocument(key) {
  const record = await dbGet(STORE_DOCUMENTS, key)
  return record?.value ?? null
}

export async function writeDocument(key, value) {
  await dbPut(STORE_DOCUMENTS, { key, value, updatedAt: new Date().toISOString() })
  return value
}

function byCreatedAtDesc(left, right) {
  return String(right?.createdAt ?? '').localeCompare(String(left?.createdAt ?? ''))
}

// 快照列表只读元信息索引，不把 5 份几 MB 的快照正文全读进来。
export async function listSnapshots() {
  const index = await readMeta(META_KEY_SNAPSHOT_INDEX)
  return Array.isArray(index) ? [...index].sort(byCreatedAtDesc) : []
}

export function readSnapshot(id) {
  return id ? dbGet(STORE_SNAPSHOTS, id) : Promise.resolve(null)
}

export async function writeSnapshot(record) {
  await dbPut(STORE_SNAPSHOTS, record)
  const index = (await listSnapshots()).filter((entry) => entry.id !== record.id)
  index.push({
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hash: record.hash,
    itemCount: record.itemCount ?? 0,
    skuCount: record.skuCount ?? 0,
    saleSkuCount: record.saleSkuCount ?? 0,
    size: record.size ?? 0,
    source: record.source ?? 'import',
  })
  await writeMeta(META_KEY_SNAPSHOT_INDEX, index.sort(byCreatedAtDesc))
  return record
}

export async function deleteSnapshot(id) {
  await dbDelete(STORE_SNAPSHOTS, id)
  const index = (await listSnapshots()).filter((entry) => entry.id !== id)
  await writeMeta(META_KEY_SNAPSHOT_INDEX, index)
}

export async function clearAll() {
  await dbClear(STORE_META)
  await dbClear(STORE_SNAPSHOTS)
  await dbClear(STORE_DOCUMENTS)
}

// 存储占用：浏览器按 origin 计算，含快照与订单文档。
export async function estimateStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  } catch {
    return null
  }
}

// 是否已获得持久化配额（拿到后浏览器不会因为磁盘紧张随意清理本 origin 的数据）。
export async function isPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return false
  try {
    return await navigator.storage.persisted()
  } catch {
    return false
  }
}

// 申请持久化配额：不申请时，磁盘紧张时浏览器可能直接清掉本 origin 的数据。
export async function requestPersistentStorage() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
