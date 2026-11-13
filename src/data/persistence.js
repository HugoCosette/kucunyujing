import { gzipSync, strToU8 } from 'fflate'
import { hashText } from './textHash.js'
import {
  META_KEY_WORKSPACE,
  deleteSnapshot as removeSnapshot,
  estimateStorage as readStorageEstimate,
  isIndexedDbAvailable,
  isPersistentStorage,
  listSnapshots,
  readMeta,
  readSnapshot,
  requestPersistentStorage,
  writeMeta,
  writeSnapshot,
} from './repo.js'
import {
  buildSnapshotText,
  collectPlanLayer,
  gunzipText,
  parseSnapshotText,
} from './serialize.js'
import { primeInventoryState } from '@/stores/inventory'

// 持久化的业务口径：事实层（导入数据）生成快照，计划层（需安排 / 采购清单）按 skuId 单独存，
// 两者加载时重新挂接，互不覆盖。写入一律先落 IndexedDB，不做任何 localStorage 兜底。
export const MAX_SNAPSHOTS = 5

// 内存镜像：workspace 记录（当前快照 + 计划层），启动时从 IndexedDB 读回来。
const workspace = {
  activeSnapshotId: null,
  plans: {},
  purchaseList: [],
  undoHistory: {},
  updatedAt: null,
}

let lastError = null
let workspaceTimer = 0
let planStore = null
let ready = false

function normalizeWorkspaceRecord(record) {
  const source = record && typeof record === 'object' ? record : {}
  const plans = {}
  for (const [skuId, planned] of Object.entries(source.plans ?? {})) {
    const value = Number(planned)
    if (String(skuId).trim() && Number.isFinite(value) && value > 0) plans[skuId] = value
  }
  return {
    activeSnapshotId: source.activeSnapshotId ?? null,
    plans,
    purchaseList: Array.isArray(source.purchaseList)
      ? source.purchaseList
          .map((entry) => ({
            skuId: String(entry?.skuId ?? '').trim(),
            product: String(entry?.product ?? ''),
            color: String(entry?.color ?? ''),
            planned: Number(entry?.planned) || 0,
          }))
          .filter((entry) => entry.skuId)
      : [],
    undoHistory:
      source.undoHistory && typeof source.undoHistory === 'object' ? { ...source.undoHistory } : {},
    updatedAt: source.updatedAt ?? null,
  }
}

export function getWorkspace() {
  return {
    activeSnapshotId: workspace.activeSnapshotId,
    plans: workspace.plans,
    purchaseList: workspace.purchaseList,
    undoHistory: workspace.undoHistory,
    updatedAt: workspace.updatedAt,
  }
}

export function getLastStorageError() {
  return lastError ? String(lastError.message ?? lastError) : ''
}

export function setWorkspaceRecord(record) {
  const next = normalizeWorkspaceRecord(record)
  workspace.activeSnapshotId = next.activeSnapshotId
  workspace.plans = next.plans
  workspace.purchaseList = next.purchaseList
  workspace.undoHistory = next.undoHistory
  workspace.updatedAt = next.updatedAt
  ready = true
  return getWorkspace()
}

export async function flushWorkspace() {
  if (workspaceTimer) {
    clearTimeout(workspaceTimer)
    workspaceTimer = 0
  }
  if (!isIndexedDbAvailable()) return false
  try {
    await writeMeta(META_KEY_WORKSPACE, {
      activeSnapshotId: workspace.activeSnapshotId,
      plans: workspace.plans,
      purchaseList: workspace.purchaseList,
      undoHistory: workspace.undoHistory,
      updatedAt: new Date().toISOString(),
    })
    return true
  } catch (error) {
    lastError = error
    console.warn('保存需安排与采购清单失败', error)
    return false
  }
}

// 需安排的四个写入口（批量补货 / 行内采纳 / 撤销 / 下单页撤销）统一调这里：
// 只序列化「需安排 + 采购清单 + 撤销快照」，几千条以内，不需要进 Worker。
export function schedulePlanPersist(store) {
  if (store) planStore = store
  if (!planStore || !isIndexedDbAvailable()) return
  const layer = collectPlanLayer(planStore, workspace.plans)
  workspace.plans = layer.plans
  workspace.purchaseList = layer.purchaseList
  workspace.undoHistory = layer.undoHistory
  if (workspaceTimer) clearTimeout(workspaceTimer)
  workspaceTimer = window.setTimeout(() => {
    workspaceTimer = 0
    void flushWorkspace()
  }, 400)
}

// ---------------------------------------------------------------------------
// 事实层快照：序列化在主线程、压缩在 Worker，写完裁掉第 6 份。
// ---------------------------------------------------------------------------

let worker = null
let workerSeq = 0
const pendingCompress = new Map()

function ensureWorker() {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null
  try {
    worker = new Worker(new URL('../workers/persistWorker.js', import.meta.url), {
      type: 'module',
    })
  } catch (error) {
    console.warn('压缩 Worker 创建失败，改为同步压缩', error)
    return null
  }
  worker.onmessage = (event) => {
    const { id, ok, buffer, hash, message } = event.data ?? {}
    const entry = pendingCompress.get(id)
    if (!entry) return
    pendingCompress.delete(id)
    if (ok) entry.resolve({ bytes: new Uint8Array(buffer), hash })
    else entry.reject(new Error(message ?? '压缩失败'))
  }
  worker.onerror = (event) => {
    for (const [id, entry] of pendingCompress) {
      pendingCompress.delete(id)
      entry.reject(new Error(event.message || '压缩失败'))
    }
    worker?.terminate()
    worker = null
  }
  return worker
}

function compressText(text) {
  const instance = ensureWorker()
  if (!instance) {
    const bytes = gzipSync(strToU8(text), { level: 6 })
    return Promise.resolve({ bytes, hash: hashText(text) })
  }
  const id = `gz-${(workerSeq += 1)}`
  return new Promise((resolve, reject) => {
    pendingCompress.set(id, { resolve, reject })
    instance.postMessage({ id, text })
  })
}

function newSnapshotId() {
  return `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

let factJob = null
let factTimer = 0
let factBusy = false
let factResolvers = []

// 导入：新建一份快照；手动添加 SKU：更新当前快照。两者都走这里，避免页面各自拼口径。
// 返回 Promise<snapshotId | null>：null 表示没存住（浏览器禁用了 IndexedDB / 写入失败），调用方要提示用户。
export function persistFactLayer(
  inventoryStore,
  { createSnapshot = true, source = 'import', meta = {} } = {},
) {
  if (!isIndexedDbAvailable()) return Promise.resolve(null)
  planStore = inventoryStore
  factJob = { store: inventoryStore, createSnapshot, source, meta }
  if (factTimer) clearTimeout(factTimer)
  // 让「导入成功」的提示先渲染出来，再做 40 MB 的序列化与压缩。
  factTimer = window.setTimeout(() => {
    factTimer = 0
    void runFactJob()
  }, 120)
  return new Promise((resolve) => factResolvers.push(resolve))
}

async function runFactJob() {
  if (factBusy || !factJob) return
  factBusy = true
  const job = factJob
  factJob = null
  let snapshotId = null
  try {
    const text = buildSnapshotText(job.store, job.meta)
    const { bytes, hash } = await compressText(text)
    const now = new Date().toISOString()

    let id = job.createSnapshot ? null : workspace.activeSnapshotId
    let createdAt = now
    if (!id) {
      // 同一份文件重复导入：不新建快照，只更新时间，避免 5 个名额被同一份数据占满。
      const existing = (await listSnapshots()).find((entry) => entry.hash === hash)
      if (existing) {
        id = existing.id
        createdAt = existing.createdAt ?? now
      }
    }
    if (!id) id = newSnapshotId()

    const skuIds = new Set()
    for (const item of job.store.inventoryItems) {
      const skuId = String(item.skuId ?? '').trim()
      if (skuId) skuIds.add(skuId)
    }

    await writeSnapshot({
      id,
      hash,
      createdAt,
      updatedAt: now,
      source: job.source,
      itemCount: job.store.inventoryItems.length,
      skuCount: skuIds.size,
      saleSkuCount: job.store.salesSheet?.bySku?.size ?? 0,
      size: bytes.byteLength,
      bytes,
    })

    workspace.activeSnapshotId = id
    await flushWorkspace()
    await pruneSnapshots()
    lastError = null
    snapshotId = id
    return snapshotId
  } catch (error) {
    lastError = error
    console.error('保存导入数据失败', error)
    return null
  } finally {
    factBusy = false
    const waiters = factResolvers
    factResolvers = []
    for (const resolve of waiters) resolve(snapshotId)
    if (factJob) void runFactJob()
  }
}

async function pruneSnapshots() {
  const entries = await listSnapshots()
  const keep = new Set(entries.slice(0, MAX_SNAPSHOTS).map((entry) => entry.id))
  if (workspace.activeSnapshotId) keep.add(workspace.activeSnapshotId)
  for (const entry of entries) {
    if (!keep.has(entry.id)) await removeSnapshot(entry.id)
  }
}

// ---------------------------------------------------------------------------
// 启动水合 / 快照切换 / 存储概览
// ---------------------------------------------------------------------------

export async function hydrateFromStorage() {
  if (!isIndexedDbAvailable()) return { supported: false, restored: false }
  ready = true
  const record = normalizeWorkspaceRecord(await readMeta(META_KEY_WORKSPACE))
  workspace.activeSnapshotId = record.activeSnapshotId
  workspace.plans = record.plans
  workspace.purchaseList = record.purchaseList
  workspace.undoHistory = record.undoHistory
  workspace.updatedAt = record.updatedAt

  const noSnapshot = { supported: true, restored: false }
  if (!record.activeSnapshotId) {
    // 没有导入过快照（例如只在演示数据上采纳过需安排）：事实层用种子数据，计划层照样要挂回来。
    if (Object.keys(record.plans).length) primeInventoryState({ planLayer: getWorkspace() })
    return noSnapshot
  }

  const snapshot = await readSnapshot(record.activeSnapshotId)
  if (!snapshot?.bytes) {
    if (Object.keys(record.plans).length) primeInventoryState({ planLayer: getWorkspace() })
    return noSnapshot
  }

  let payload = null
  try {
    payload = parseSnapshotText(gunzipText(snapshot.bytes))
  } catch (error) {
    lastError = error
    console.error('快照解压失败，仍用种子数据启动', error)
    if (Object.keys(record.plans).length) primeInventoryState({ planLayer: getWorkspace() })
    return { supported: true, restored: false, error }
  }

  // 在挂载前把状态放好，store 创建时直接用它，不会先渲染一遍种子数据。
  // 需安排 / 采购清单交给 store 按 skuId 挂回行上（行 id 会随快照变化，不能存 id）。
  primeInventoryState({
    inventoryItems: payload.items,
    salesSheet: payload.salesSheet,
    planLayer: getWorkspace(),
  })
  return {
    supported: true,
    restored: true,
    snapshotId: record.activeSnapshotId,
    itemCount: payload.items.length,
  }
}

export async function switchSnapshot(snapshotId) {
  const record = await readSnapshot(snapshotId)
  if (!record) throw new Error('快照不存在或已被清理')
  workspace.activeSnapshotId = snapshotId
  await flushWorkspace()
  return record
}

export async function deleteSnapshot(snapshotId) {
  if (snapshotId === workspace.activeSnapshotId) {
    throw new Error('当前正在使用的快照不能删除')
  }
  await removeSnapshot(snapshotId)
}

export async function getStorageSummary() {
  const supported = isIndexedDbAvailable()
  const snapshots = supported ? await listSnapshots() : []
  return {
    supported,
    ready,
    persistent: await isPersistentStorage(),
    snapshots,
    activeSnapshotId: workspace.activeSnapshotId,
    storage: supported ? await readStorageEstimate() : null,
    error: getLastStorageError(),
  }
}

export function requestPersistence() {
  return requestPersistentStorage()
}

// 页面隐藏时把还没落盘的需安排刷一次，避免「刚点采纳就关浏览器」。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (workspaceTimer) void flushWorkspace()
  })
}
