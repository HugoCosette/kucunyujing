import fileSettings from './settings.json'
import fileOrders from './orders.json'
import { normalizeOrders, normalizeSettings } from './validate.js'
import { DOC_KEY_ORDERS, writeDocument } from '@/data/repo.js'

// 与 src/stocking 同一套持久化策略：JSON 源文件是默认值，开发态设置写回磁盘，
// 构建产物里的设置走 localStorage；订单与草稿体积会涨到几十 MB，一律走 IndexedDB
// （localStorage 单源约 5 MB，装不下就会静默丢单）。

export const SETTINGS_FILE_NAME = 'purchaseSettings.json'
export const SETTINGS_SAVE_ENDPOINT = '/__purchase-settings/save'
export const SETTINGS_STORAGE_KEY = 'purchase-settings:v1'

export const ORDERS_FILE_NAME = 'purchaseOrders.json'
export const ORDERS_SAVE_ENDPOINT = '/__purchase-orders/save'
export const ORDERS_STORAGE_KEY = 'purchase-orders:v1'
// 订单只在小体量时留一份 localStorage 副本，超过就只认 IndexedDB。
const ORDERS_CACHE_LIMIT = 1024 * 1024

let currentSettings = null
let currentOrders = null

function readCache(storageKey, normalize) {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return null
    return normalize(JSON.parse(raw))
  } catch (error) {
    console.warn(`Failed to read cached ${storageKey}`, error)
    return null
  }
}

function writeCache(storageKey, value, { limit = 0 } = {}) {
  try {
    const text = JSON.stringify(value)
    // 超过上限的文档不写 localStorage：IndexedDB 才是它的存储介质。
    if (limit > 0 && text.length > limit) {
      window.localStorage.removeItem(storageKey)
      return
    }
    window.localStorage.setItem(storageKey, text)
  } catch (error) {
    console.warn(`Failed to cache ${storageKey}`, error)
  }
}

function stampOf(value) {
  const stamp = Date.parse(value?.updatedAt ?? '')
  return Number.isFinite(stamp) ? stamp : 0
}

async function writeJsonFile(endpoint, value) {
  if (!import.meta.env.DEV) return false

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `${JSON.stringify(value, null, 2)}\n`,
    })
    return response.ok
  } catch (error) {
    console.warn(`Failed to write ${endpoint}`, error)
    return false
  }
}

function downloadJson(fileName, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function loadSettings() {
  if (currentSettings) return currentSettings

  const fileSnapshot = normalizeSettings(fileSettings)
  const cached = readCache(SETTINGS_STORAGE_KEY, normalizeSettings)
  currentSettings = cached && stampOf(cached) > stampOf(fileSnapshot) ? cached : fileSnapshot
  return currentSettings
}

export function getSettings() {
  return loadSettings()
}

export function setSettingsRuntime(settings) {
  currentSettings = normalizeSettings(settings)
  return currentSettings
}

export function loadOrders() {
  if (currentOrders) return currentOrders

  const fileSnapshot = normalizeOrders(fileOrders)
  const cached = readCache(ORDERS_STORAGE_KEY, normalizeOrders)
  currentOrders = cached && stampOf(cached) > stampOf(fileSnapshot) ? cached : fileSnapshot
  return currentOrders
}

export function getOrders() {
  return loadOrders()
}

export function setOrdersRuntime(orders) {
  currentOrders = normalizeOrders(orders)
  return currentOrders
}

// 保存：先更新运行时与本地缓存，开发态再写回 src/purchase/settings.json。
export async function saveSettings(settings) {
  const next = normalizeSettings({ ...settings, updatedAt: new Date().toISOString() })
  currentSettings = next
  writeCache(SETTINGS_STORAGE_KEY, next)
  const written = await writeJsonFile(SETTINGS_SAVE_ENDPOINT, next)
  return { settings: next, written }
}

// 保存：先更新运行时，再落 IndexedDB（唯一真相），开发态顺手写回 src/purchase/orders.json。
// persisted=false 表示本机数据没存住（例如隐私模式禁用 IndexedDB），调用方要提示用户。
export async function saveOrders(orders) {
  const next = normalizeOrders({ ...orders, updatedAt: new Date().toISOString() })
  currentOrders = next
  writeCache(ORDERS_STORAGE_KEY, next, { limit: ORDERS_CACHE_LIMIT })
  const persisted = await persistOrdersDocument(next)
  const written = await writeJsonFile(ORDERS_SAVE_ENDPOINT, next)
  return { orders: next, written, persisted }
}

async function persistOrdersDocument(orders) {
  try {
    await writeDocument(DOC_KEY_ORDERS, orders)
    return true
  } catch (error) {
    console.warn('Failed to persist purchase orders', error)
    return false
  }
}

export function exportSettingsFile(settings) {
  downloadJson(SETTINGS_FILE_NAME, normalizeSettings(settings))
}

export function importSettingsFile(textContent) {
  return normalizeSettings(JSON.parse(textContent))
}

export function exportOrdersFile(orders) {
  downloadJson(ORDERS_FILE_NAME, normalizeOrders(orders))
}
