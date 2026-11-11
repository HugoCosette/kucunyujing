import fileSettings from './settings.json'
import fileOrders from './orders.json'
import { normalizeOrders, normalizeSettings } from './validate.js'

// 与 src/stocking 同一套持久化策略：JSON 源文件是唯一真相，开发态写回磁盘，
// 构建产物（GitHub Pages）写不了盘则退化为 localStorage。设置与下单数据分开存，
// 改设置不会冲掉已录入的分订单。

export const SETTINGS_FILE_NAME = 'purchaseSettings.json'
export const SETTINGS_SAVE_ENDPOINT = '/__purchase-settings/save'
export const SETTINGS_STORAGE_KEY = 'purchase-settings:v1'

export const ORDERS_FILE_NAME = 'purchaseOrders.json'
export const ORDERS_SAVE_ENDPOINT = '/__purchase-orders/save'
export const ORDERS_STORAGE_KEY = 'purchase-orders:v1'

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

function writeCache(storageKey, value) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
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

export async function saveOrders(orders) {
  const next = normalizeOrders({ ...orders, updatedAt: new Date().toISOString() })
  currentOrders = next
  writeCache(ORDERS_STORAGE_KEY, next)
  const written = await writeJsonFile(ORDERS_SAVE_ENDPOINT, next)
  return { orders: next, written }
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
