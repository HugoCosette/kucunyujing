import fileConfig from './config.json'
import { createDefaultConfig } from './defaults.js'
import { normalizeConfig } from './validate.js'

// 配置文件是唯一真相：开发态保存会直接写回磁盘，部署后的静态站点写不了盘则退化为本地缓存。
export const CONFIG_FILE_NAME = 'stockingConfig.json'
export const CONFIG_SAVE_ENDPOINT = '/__stocking-config/save'
export const CONFIG_STORAGE_KEY = 'stocking-config:v1'

let currentConfig = null

function readCache() {
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!raw) return null
    return normalizeConfig(JSON.parse(raw))
  } catch (error) {
    console.warn('Failed to read cached stocking config', error)
    return null
  }
}

function writeCache(config) {
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config))
  } catch (error) {
    console.warn('Failed to cache stocking config', error)
  }
}

function stampOf(config) {
  const stamp = Date.parse(config?.updatedAt ?? '')
  return Number.isFinite(stamp) ? stamp : 0
}

// 源文件与本地缓存都带 updatedAt：取更新的一份，保存后两者同步。
export function loadConfig() {
  if (currentConfig) return currentConfig

  const fileSnapshot = normalizeConfig(fileConfig)
  const cached = readCache()
  currentConfig =
    cached && stampOf(cached) > stampOf(fileSnapshot) ? cached : fileSnapshot
  return currentConfig
}

export function getConfig() {
  return loadConfig()
}

export function setConfigRuntime(config) {
  currentConfig = normalizeConfig(config)
  return currentConfig
}

async function writeConfigFile(config) {
  if (!import.meta.env.DEV) return false

  try {
    const response = await fetch(CONFIG_SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `${JSON.stringify(config, null, 2)}\n`,
    })
    return response.ok
  } catch (error) {
    console.warn('Failed to write stocking config file', error)
    return false
  }
}

// 保存：先更新运行时与本地缓存，开发态再写回 src/stocking/config.json。
export async function saveConfig(config) {
  const next = normalizeConfig({ ...config, updatedAt: new Date().toISOString() })
  currentConfig = next
  writeCache(next)
  const written = await writeConfigFile(next)
  return { config: next, written }
}

export async function resetConfig() {
  return saveConfig(createDefaultConfig())
}

export function exportConfigFile(config) {
  const target = normalizeConfig(config)
  const blob = new Blob([`${JSON.stringify(target, null, 2)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = CONFIG_FILE_NAME
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
