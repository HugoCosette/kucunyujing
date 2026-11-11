import fileProfiles from './config.json'
import { DEMO_PROFILE_DISABLED } from './demoProfile.js'
import { createDefaultConfig } from './defaults.js'
import { getActiveProfile, normalizeConfig, normalizeProfileFile } from './validate.js'

// 配置文件是唯一真相：开发态保存会直接写回磁盘，部署后的静态站点写不了盘则退化为本地缓存。
// 文件内有多套「配置方案」，同一时刻只有 activeProfileId 生效。
export const CONFIG_FILE_NAME = 'stockingConfig.json'
export const CONFIG_SAVE_ENDPOINT = '/__stocking-config/save'
export const CONFIG_STORAGE_KEY = 'stocking-config:v4'

let currentProfiles = null

// 演示配置已封禁：无论来自源文件还是缓存，都从方案列表里剔除。
function withoutDisabledProfiles(profiles) {
  if (!DEMO_PROFILE_DISABLED) return profiles
  const kept = profiles.profiles.filter((profile) => profile.id !== 'demo')
  if (!kept.length) return profiles
  const activeProfileId = kept.some((profile) => profile.id === profiles.activeProfileId)
    ? profiles.activeProfileId
    : kept[0].id
  return { ...profiles, profiles: kept, activeProfileId }
}

function readCache() {
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!raw) return null
    return withoutDisabledProfiles(normalizeProfileFile(JSON.parse(raw)))
  } catch (error) {
    console.warn('Failed to read cached stocking config', error)
    return null
  }
}

function writeCache(profiles) {
  try {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(profiles))
  } catch (error) {
    console.warn('Failed to cache stocking config', error)
  }
}

function stampOf(profiles) {
  const stamp = Date.parse(profiles?.updatedAt ?? '')
  return Number.isFinite(stamp) ? stamp : 0
}

// 源文件与本地缓存都带 updatedAt：取更新的一份，保存后两者同步。
export function loadProfiles() {
  if (currentProfiles) return currentProfiles

  const fileSnapshot = withoutDisabledProfiles(normalizeProfileFile(fileProfiles))
  const cached = readCache()
  currentProfiles =
    cached && stampOf(cached) > stampOf(fileSnapshot) ? cached : fileSnapshot
  return currentProfiles
}

export function getProfiles() {
  return loadProfiles()
}

// 当前激活方案的单份配置：引擎、校验与页面只消费这个形态。
export function getConfig() {
  return getActiveProfile(loadProfiles()).config
}

export function loadConfig() {
  return getConfig()
}

export function setProfilesRuntime(profiles) {
  currentProfiles = normalizeProfileFile(profiles)
  return currentProfiles
}

// 兼容旧调用：覆盖当前激活方案。
export function setConfigRuntime(config) {
  const profiles = loadProfiles()
  const active = getActiveProfile(profiles)
  currentProfiles = normalizeProfileFile({
    ...profiles,
    profiles: profiles.profiles.map((profile) =>
      profile.id === active.id ? { ...profile, config: normalizeConfig(config) } : profile,
    ),
  })
  return getConfig()
}

async function writeProfilesFile(profiles) {
  if (!import.meta.env.DEV) return false

  try {
    const response = await fetch(CONFIG_SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `${JSON.stringify(profiles, null, 2)}\n`,
    })
    return response.ok
  } catch (error) {
    console.warn('Failed to write stocking config file', error)
    return false
  }
}

// 保存：先更新运行时与本地缓存，开发态再写回 src/stocking/config.json。
export async function saveProfiles(profiles) {
  const next = withoutDisabledProfiles(
    normalizeProfileFile({ ...profiles, updatedAt: new Date().toISOString() }),
  )
  currentProfiles = next
  writeCache(next)
  const written = await writeProfilesFile(next)
  return { profiles: next, config: getActiveProfile(next).config, written }
}

// 兼容旧调用：把单份配置写进当前激活方案。
export async function saveConfig(config) {
  const profiles = loadProfiles()
  const active = getActiveProfile(profiles)
  return saveProfiles({
    ...profiles,
    profiles: profiles.profiles.map((profile) =>
      profile.id === active.id
        ? {
            ...profile,
            config: normalizeConfig({ ...config, updatedAt: new Date().toISOString() }),
          }
        : profile,
    ),
  })
}

export async function activateProfile(profileId) {
  const profiles = loadProfiles()
  if (!profiles.profiles.some((profile) => profile.id === profileId)) {
    return { profiles, config: getActiveProfile(profiles).config, written: false }
  }
  return saveProfiles({ ...profiles, activeProfileId: profileId })
}

// 恢复默认只作用于当前激活方案，其他方案保持不变。
export async function resetConfig() {
  const profiles = loadProfiles()
  const active = getActiveProfile(profiles)
  return saveProfiles({
    ...profiles,
    profiles: profiles.profiles.map((profile) =>
      profile.id === active.id ? { ...profile, config: createDefaultConfig() } : profile,
    ),
  })
}

export function exportConfigFile(profiles) {
  const target = normalizeProfileFile(profiles)
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

// 导入：只认 v4 多方案文件，v1/v2/v3 旧配置一律按默认重建。
export function importConfigFile(text) {
  return withoutDisabledProfiles(normalizeProfileFile(JSON.parse(text)))
}
