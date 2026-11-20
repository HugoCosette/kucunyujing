import ratesUrl from '../../tools/cleaning/cache/rates.json?url'
import metaUrl from '../../tools/cleaning/cache/meta.json?url'
import productMasterUrl from '../../tools/cleaning/cache/productMaster.json?url'

// 出码率 / 产品资料是清洗口径的「稳定字典」：跟着 tools/cleaning/cache/ 随代码走。
// 导入分表时没选这两个文件就用缓存；?url 让它们作为独立资源按需加载，不会内联进主 bundle。
export const CLEANING_CACHE_ROLE_IDS = ['产品资料', 'rates']

let cachePromise = null

async function fetchJson(url, label) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`清洗缓存「${label}」读取失败（${response.status}）`)
  return response.json()
}

/** 读取缓存：{ rates: [{品名, 出码率}], productMaster: [{品名, 颜色, 单位, 树形分类}], meta } */
export function loadCleaningCache() {
  if (!cachePromise) {
    cachePromise = Promise.all([
      fetchJson(ratesUrl, '出码率'),
      fetchJson(productMasterUrl, '产品资料'),
      fetchJson(metaUrl, '元信息').catch(() => null),
    ])
      .then(([rates, productMaster, meta]) => ({ rates, productMaster, meta }))
      .catch((error) => {
        cachePromise = null
        throw error
      })
  }
  return cachePromise
}

export function isCachedRole(roleId) {
  return CLEANING_CACHE_ROLE_IDS.includes(roleId)
}
