import fileHidden from './hiddenSkus.json'
import { normalizeProductName, normalizeSkuId } from '../utils/inventory.js'

// 屏蔽清单：主面板上的「删除」只把品名 / SKU 记到这里，源表数据一行不动。
// 和手动清单同一思路——它是"人对商品的长期决定"，独立成文件，跨导入、跨刷新保留。
// products 存品名（SPU），skus 以唯一标识（SKU）为键，值只是恢复时给人看的快照。
export const HIDDEN_SAVE_ENDPOINT = '/__stocking-hidden/save'
export const HIDDEN_STORAGE_KEY = 'stocking-hidden:v1'

let currentHidden = null

export function normalizeHiddenProduct(value) {
  return normalizeProductName(String(value ?? ''))
}

function normalizeProductList(products) {
  if (!Array.isArray(products)) return []
  const seen = new Set()
  const list = []
  for (const product of products) {
    const key = normalizeHiddenProduct(product)
    if (!key || seen.has(key)) continue
    seen.add(key)
    list.push(key)
  }
  return list
}

// 归一化：品名去空去重、唯一标识去空，坏条目直接丢弃，保证 products / skus 一定是普通结构。
export function normalizeHiddenSkus(source) {
  const input = source && typeof source === 'object' ? source : {}
  const rawSkus = input.skus && typeof input.skus === 'object' ? input.skus : {}
  const skus = {}

  for (const [skuId, entry] of Object.entries(rawSkus)) {
    const key = normalizeSkuId(skuId)
    if (!key) continue
    skus[key] = {
      product: normalizeHiddenProduct(entry?.product),
      color: String(entry?.color ?? '').trim(),
    }
  }

  return {
    version: 1,
    updatedAt:
      typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
    products: normalizeProductList(input.products),
    skus,
  }
}

function readCache() {
  try {
    const raw = window.localStorage.getItem(HIDDEN_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch (error) {
    console.warn('Failed to read cached hidden skus', error)
    return null
  }
}

function writeCache(hidden) {
  try {
    window.localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(hidden))
  } catch (error) {
    console.warn('Failed to cache hidden skus', error)
  }
}

function stampOf(hidden) {
  const stamp = Date.parse(hidden?.updatedAt ?? '')
  return Number.isFinite(stamp) ? stamp : 0
}

// 源文件与本地缓存都带 updatedAt：取更新的一份，保存后两者同步。
export function loadHiddenSkus() {
  if (currentHidden) return currentHidden

  const fileSnapshot = normalizeHiddenSkus(fileHidden)
  const cached = readCache()
  currentHidden =
    cached && stampOf(cached) > stampOf(fileSnapshot)
      ? normalizeHiddenSkus(cached)
      : fileSnapshot
  return currentHidden
}

async function writeHiddenFile(hidden) {
  if (!import.meta.env.DEV) return false

  try {
    const response = await fetch(HIDDEN_SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `${JSON.stringify(hidden, null, 2)}\n`,
    })
    return response.ok
  } catch (error) {
    console.warn('Failed to write hidden skus file', error)
    return false
  }
}

// 保存：先更新运行时与本地缓存，开发态再写回 src/stocking/hiddenSkus.json。
export async function saveHiddenSkus(hidden) {
  const next = normalizeHiddenSkus({
    ...hidden,
    updatedAt: new Date().toISOString(),
  })
  currentHidden = next
  writeCache(next)
  const written = await writeHiddenFile(next)
  return { hidden: next, written }
}

// 屏蔽数量按 SKU 计：整组屏蔽的品名按当前数据里该品名的 SKU 数展开，
// 不在当前数据里的记录至少算 1，避免「有记录但显示 0」。
export function countHiddenSkus(hidden, items) {
  const blockedProducts = new Set(hidden?.products ?? [])
  const blockedSkus = hidden?.skus ?? {}
  const list = Array.isArray(items) ? items : []
  const seenSkuIds = new Set()
  const currentProducts = new Set()
  let count = 0

  for (const item of list) {
    const product = String(item?.product ?? '')
    currentProducts.add(product)
    const skuId = String(item?.skuId ?? '').trim()
    if (!skuId) continue
    const blocked =
      blockedProducts.has(product) || Object.prototype.hasOwnProperty.call(blockedSkus, skuId)
    if (!blocked) continue
    seenSkuIds.add(skuId)
    count += 1
  }

  for (const skuId of Object.keys(blockedSkus)) {
    if (!seenSkuIds.has(skuId)) count += 1
  }
  for (const product of blockedProducts) {
    if (!currentProducts.has(product)) count += 1
  }

  return count
}

export function setHiddenRuntime(hidden) {
  currentHidden = normalizeHiddenSkus(hidden)
  return currentHidden
}
