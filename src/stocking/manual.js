import fileManual from './manualSkus.json'
import { normalizeConfig } from './validate.js'

// 手动清单：唯一标识 → { modeId, coefficients }。
// 它描述"人对商品的长期决定"，所以独立成文件，跨导入、跨刷新都有效。
export const MANUAL_FILE_NAME = 'manualSkus.json'
export const MANUAL_SAVE_ENDPOINT = '/__stocking-manual/save'
export const MANUAL_STORAGE_KEY = 'stocking-manual:v1'

let currentManual = null

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeEntry(entry, config) {
  if (!entry || typeof entry !== 'object') return null
  const modeId = String(entry.modeId ?? '').trim()
  if (!modeId) return null

  const modes = normalizeConfig(config).strategies.find((s) => s.behavior === 'manual')?.modes ?? []
  const mode = modes.find((item) => item.id === modeId)
  if (!mode) return null

  // 订单货不使用系数：只记模式归属，切换模式后不会残留上一次的系数。
  if (mode.behavior === 'order') return { modeId }

  const source = entry.coefficients ?? mode.defaultCoefficients ?? {}
  const coefficients = {
    redLine: toNumber(source.redLine),
    normal: toNumber(source.normal),
    peak: toNumber(source.peak),
  }
  return { modeId, coefficients }
}

// 归一化：丢弃无法识别的模式、补全结构，保证 items 一定是普通对象。
export function normalizeManualSkus(manual, config) {
  const source = manual && typeof manual === 'object' ? manual : {}
  const items = {}
  const rawItems = source.items && typeof source.items === 'object' ? source.items : {}

  for (const [skuId, entry] of Object.entries(rawItems)) {
    const key = String(skuId ?? '').trim()
    if (!key) continue
    const normalized = normalizeEntry(entry, config)
    if (normalized) items[key] = normalized
  }

  return {
    version: 1,
    updatedAt:
      typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    items,
  }
}

function readCache() {
  try {
    const raw = window.localStorage.getItem(MANUAL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return { ...parsed, updatedAt: parsed?.updatedAt }
  } catch (error) {
    console.warn('Failed to read cached manual skus', error)
    return null
  }
}

function writeCache(manual) {
  try {
    window.localStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify(manual))
  } catch (error) {
    console.warn('Failed to cache manual skus', error)
  }
}

function stampOf(manual) {
  const stamp = Date.parse(manual?.updatedAt ?? '')
  return Number.isFinite(stamp) ? stamp : 0
}

export function loadManualSkus(config) {
  if (currentManual) return currentManual

  const fileSnapshot = normalizeManualSkus(fileManual, config)
  const cached = readCache()
  currentManual =
    cached && stampOf(cached) > stampOf(fileSnapshot)
      ? normalizeManualSkus(cached, config)
      : fileSnapshot
  return currentManual
}

async function writeManualFile(manual) {
  if (!import.meta.env.DEV) return false

  try {
    const response = await fetch(MANUAL_SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `${JSON.stringify(manual, null, 2)}\n`,
    })
    return response.ok
  } catch (error) {
    console.warn('Failed to write manual skus file', error)
    return false
  }
}

// 保存：先更新运行时与本地缓存，开发态再写回 src/stocking/manualSkus.json。
export async function saveManualSkus(manual, config) {
  const next = normalizeManualSkus(
    { ...manual, updatedAt: new Date().toISOString() },
    config,
  )
  currentManual = next
  writeCache(next)
  const written = await writeManualFile(next)
  return { manual: next, written }
}

export function setManualRuntime(manual, config) {
  currentManual = normalizeManualSkus(manual, config)
  return currentManual
}

export function exportManualFile(manual, config) {
  const target = normalizeManualSkus(manual, config)
  const blob = new Blob([`${JSON.stringify(target, null, 2)}\n`], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = MANUAL_FILE_NAME
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// 导入后统计：清单里有、当前数据里已经不存在的唯一标识（悬空记录）。
export function findDanglingSkuIds(manual, items) {
  const existing = new Set(
    (items ?? []).map((item) => String(item?.skuId ?? '').trim()).filter(Boolean),
  )
  return Object.keys(manual?.items ?? {}).filter((skuId) => !existing.has(skuId))
}
