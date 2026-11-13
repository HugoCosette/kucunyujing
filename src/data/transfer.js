import {
  DOC_KEY_ORDERS,
  clearAll,
  isIndexedDbAvailable,
  readDocument,
  readSnapshot,
  writeDocument,
  writeSnapshot,
} from './repo.js'
import { flushWorkspace, getWorkspace, setWorkspaceRecord } from './persistence.js'
import { getSettings, saveSettings } from '@/purchase/persistence.js'
import { getConfig, getProfiles, saveProfiles } from '@/stocking/persistence.js'
import { loadManualSkus, saveManualSkus } from '@/stocking/manual.js'
import { loadHiddenSkus, saveHiddenSkus } from '@/stocking/hidden.js'

// 手动备份兜底：IndexedDB 只活在这一台电脑的这一个浏览器里，
// 清站点数据 / 换电脑前必须能导出成一份文件，再导入回来完整还原。
const APP_TAG = 'kucunyujing'
const TRANSFER_VERSION = 1

// 老版本用的是 localStorage：清空时一并清掉，避免「清完刷新又冒出来」。
const LEGACY_STORAGE_KEYS = [
  'purchase-settings:v1',
  'purchase-orders:v1',
  'stocking-config:v4',
  'stocking-manual:v1',
  'stocking-hidden:v1',
]

function toBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function fromBase64(text) {
  const binary = atob(String(text ?? ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function downloadJson(fileName, value) {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportAllData() {
  const workspace = getWorkspace()
  const snapshot = workspace.activeSnapshotId ? await readSnapshot(workspace.activeSnapshotId) : null
  const payload = {
    app: APP_TAG,
    version: TRANSFER_VERSION,
    exportedAt: new Date().toISOString(),
    workspace,
    snapshot: snapshot ? { ...snapshot, bytes: toBase64(snapshot.bytes ?? new Uint8Array()) } : null,
    orders: await readDocument(DOC_KEY_ORDERS),
    purchaseSettings: getSettings(),
    stockingProfiles: getProfiles(),
    manualSkus: loadManualSkus(getConfig()),
    hiddenSkus: loadHiddenSkus(),
  }
  downloadJson(`库存系统-全量数据-${stamp()}.json`, payload)
  return payload
}

export async function importAllData(text) {
  const payload = JSON.parse(text)
  if (payload?.app !== APP_TAG) throw new Error('不是本系统导出的数据文件')

  // 顺序要保证：方案文件 → 下单设置 → 手动清单（手动清单要按配置校验模式 id）。
  if (payload.stockingProfiles) await saveProfiles(payload.stockingProfiles)
  if (payload.purchaseSettings) await saveSettings(payload.purchaseSettings)
  if (payload.manualSkus) await saveManualSkus(payload.manualSkus, getConfig())
  if (payload.hiddenSkus) await saveHiddenSkus(payload.hiddenSkus)
  if (payload.orders) await writeDocument(DOC_KEY_ORDERS, payload.orders)
  if (payload.snapshot?.id) {
    await writeSnapshot({ ...payload.snapshot, bytes: fromBase64(payload.snapshot.bytes) })
  }
  if (payload.workspace) {
    setWorkspaceRecord(payload.workspace)
    await flushWorkspace()
  }
  return true
}

export async function clearLocalData() {
  if (isIndexedDbAvailable()) await clearAll()
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略即可。
    }
  }
}
