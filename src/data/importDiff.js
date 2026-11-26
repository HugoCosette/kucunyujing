// 「SKU 数据变动」的唯一实现：每次导入前抓一份旧值，导入后逐字段比一次。
// 主面板是全量数据，看不出「今天到底变了什么」；这份 diff 只回答那一个问题。
//
// 只比事实字段（导入值 + 订单无关的那几列）：在仓库存 / 周销量 / 生产排单 / 生产入库 /
// 退货入库 / 欠货 / 周转入 / 公斤系数，外加品名与颜色（改名）。
// 派生值（理论库存、预计库存、预警灯、建议需安排）不写进 diff —— 它们跟着配置变，
// 存下来只会让历史可比性失真；要看这些直接看主面板。

import { DOC_KEY_IMPORT_DIFF, isIndexedDbAvailable, readDocument, writeDocument } from './repo.js'

export const IMPORT_DIFF_VERSION = 1
// 留最近几份就够回看：每份只存变动的行，20 万级数据滚动导入时也不至于占满空间。
export const MAX_IMPORT_DIFFS = 6

// 字段顺序就是弹窗里的展示顺序；unit 只影响文案，数值一律已换算成公斤 / 原单位。
export const IMPORT_DIFF_FIELDS = [
  { key: 'warehouseKg', label: '在仓库存', unit: '公斤' },
  { key: 'weeklySales', label: '周销量', unit: '公斤' },
  { key: 'producing', label: '生产排单', unit: '公斤' },
  { key: 'producedIn', label: '生产入库', unit: '公斤' },
  { key: 'returnedIn', label: '退货入库', unit: '公斤' },
  { key: 'backorder', label: '欠货', unit: '' },
  { key: 'turnoverIn', label: '周转入', unit: '' },
  { key: 'kgFactor', label: '公斤系数', unit: '' },
]

const FIELD_KEYS = IMPORT_DIFF_FIELDS.map((field) => field.key)
// 换算后的公斤数可能是 1234.5678，留给展示去取整，比较时按 0.005 抹掉浮点噪声。
const EPSILON = 0.005

let cache = null

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null
}

function warehouseKgOf(item) {
  const stock = numberOrNull(item?.warehouseStock)
  const factor = numberOrNull(item?.kgFactor)
  if (stock === null || factor === null) return null
  return numberOrNull(stock * factor)
}

function snapshotOf(item) {
  return {
    skuId: String(item?.skuId ?? '').trim(),
    product: String(item?.product ?? ''),
    color: String(item?.color ?? ''),
    warehouseKg: warehouseKgOf(item),
    weeklySales: numberOrNull(item?.weeklySales),
    producing: numberOrNull(item?.producing),
    producedIn: numberOrNull(item?.producedIn),
    returnedIn: numberOrNull(item?.returnedIn),
    backorder: numberOrNull(item?.backorder),
    turnoverIn: numberOrNull(item?.turnoverIn),
    kgFactor: numberOrNull(item?.kgFactor),
  }
}

function sameValue(left, right) {
  if (left === null && right === null) return true
  if (left === null || right === null) return false
  return Math.abs(left - right) < EPSILON
}

/**
 * 进导入前抓一份旧值（只留要比的字段）。用 Map<skuId, 快照>，导入后按唯一标识对齐。
 * @param {{skuId?: string}[]} items
 */
export function captureImportBaseline(items) {
  const baseline = new Map()
  for (const item of items ?? []) {
    const snapshot = snapshotOf(item)
    if (snapshot.skuId) baseline.set(snapshot.skuId, snapshot)
  }
  return baseline
}

/**
 * 新旧两批库存行逐字段比一次，返回可以直接渲染 / 导出的 diff。
 * @param {Map<string, object>} baseline captureImportBaseline 的结果
 * @param {object[]} items 导入后的库存行
 * @param {{at?: string, files?: {inventory?: string, sales?: string}}} [options]
 */
export function buildImportDiff(baseline, items, { at = new Date().toISOString(), files = {} } = {}) {
  const previous = baseline instanceof Map ? baseline : new Map()
  const fieldCounts = {}
  for (const key of FIELD_KEYS) fieldCounts[key] = 0

  const rows = []
  let unchanged = 0
  let renamed = 0
  const seen = new Set()

  for (const item of items ?? []) {
    const after = snapshotOf(item)
    if (!after.skuId) continue
    seen.add(after.skuId)
    const before = previous.get(after.skuId)

    if (!before) {
      rows.push({ ...after, kind: 'added', renamed: false, changes: [] })
      continue
    }

    const changes = []
    for (const field of IMPORT_DIFF_FIELDS) {
      const from = before[field.key] ?? null
      const to = after[field.key] ?? null
      if (sameValue(from, to)) continue
      changes.push({
        key: field.key,
        label: field.label,
        unit: field.unit,
        from,
        to,
        delta: from === null || to === null ? null : numberOrNull(to - from),
      })
      fieldCounts[field.key] += 1
    }

    const nameChanged = before.product !== after.product || before.color !== after.color
    if (!changes.length && !nameChanged) {
      unchanged += 1
      continue
    }
    if (nameChanged) renamed += 1
    rows.push({
      ...after,
      kind: 'changed',
      renamed: nameChanged,
      previousProduct: before.product,
      previousColor: before.color,
      changes,
    })
  }

  let removed = 0
  for (const [skuId, before] of previous) {
    if (seen.has(skuId)) continue
    removed += 1
    rows.push({ ...before, kind: 'removed', renamed: false, changes: [] })
  }

  const added = rows.filter((row) => row.kind === 'added').length
  const changed = rows.filter((row) => row.kind === 'changed').length

  return {
    version: IMPORT_DIFF_VERSION,
    at,
    files: { inventory: files.inventory ?? '', sales: files.sales ?? '' },
    summary: {
      total: seen.size,
      added,
      removed,
      changed,
      unchanged,
      renamed,
      changedRows: added + removed + changed,
      fieldCounts,
    },
    rows,
  }
}

/** 同步读内存里的最近几份（刚算完就打开弹窗时不用等 IndexedDB）。 */
export function peekImportDiffs() {
  return cache ?? []
}

/**
 * 落一份 diff：先更新内存（最新在前），再写文档。写失败不抛错 ——
 * 报表丢了不影响导入本身，下一次导入会重新算一份。
 */
export async function saveImportDiff(diff) {
  if (!diff) return cache ?? []
  cache = [diff, ...(cache ?? [])].slice(0, MAX_IMPORT_DIFFS)
  if (!isIndexedDbAvailable()) return cache
  try {
    await writeDocument(DOC_KEY_IMPORT_DIFF, { version: IMPORT_DIFF_VERSION, entries: cache })
  } catch (error) {
    console.warn('保存 SKU 数据变动失败', error)
  }
  return cache
}

/** 读最近几份变动记录；没有数据或读失败时返回空数组。 */
export async function loadImportDiffs() {
  if (Array.isArray(cache)) return cache
  if (!isIndexedDbAvailable()) {
    cache = []
    return cache
  }
  try {
    const record = await readDocument(DOC_KEY_IMPORT_DIFF)
    const entries = Array.isArray(record?.entries) ? record.entries : []
    cache = entries.filter((entry) => entry?.summary && Array.isArray(entry.rows))
    return cache
  } catch (error) {
    console.warn('读取 SKU 数据变动失败', error)
    cache = []
    return cache
  }
}
