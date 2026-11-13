// IndexedDB 底层封装：只负责打开库与增删改查，业务口径在 indexedDbRepo.js / persistence.js。
// 不引入第三方库（idb / Dexie），保持零依赖。
const DB_NAME = 'kucun-persist'
const DB_VERSION = 1

export const STORE_META = 'meta'
export const STORE_SNAPSHOTS = 'snapshots'
export const STORE_DOCUMENTS = 'documents'

let dbPromise = null

export function isIndexedDbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null
}

function ensureStores(db) {
  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: 'key' })
  }
  if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
    const snapshots = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' })
    snapshots.createIndex('byCreatedAt', 'createdAt')
  }
  // 订单 / 设置这类「整份文档」一次写入：结构简单，也不会被拆成上万条碎记录。
  if (!db.objectStoreNames.contains(STORE_DOCUMENTS)) {
    db.createObjectStore(STORE_DOCUMENTS, { keyPath: 'key' })
  }
}

export function openDb() {
  if (!isIndexedDbAvailable()) return Promise.reject(new Error('当前环境不支持 IndexedDB'))
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => ensureStores(request.result)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'))
  }).catch((error) => {
    // 打开失败时清掉缓存，下一次调用还能重试。
    dbPromise = null
    throw error
  })

  return dbPromise
}

// 用一个事务包住一次读写：action 返回 IDBRequest 时取它的 result，否则返回 undefined。
async function run(storeName, mode, action) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    let request = null
    try {
      request = action(store)
    } catch (error) {
      reject(error)
      return
    }
    transaction.oncomplete = () => resolve(request ? request.result : undefined)
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务被中止'))
  })
}

export function dbGet(storeName, key) {
  return run(storeName, 'readonly', (store) => store.get(key))
}

export function dbGetAll(storeName) {
  return run(storeName, 'readonly', (store) => store.getAll())
}

export function dbPut(storeName, value) {
  return run(storeName, 'readwrite', (store) => store.put(value))
}

export function dbDelete(storeName, key) {
  return run(storeName, 'readwrite', (store) => store.delete(key))
}

export function dbClear(storeName) {
  return run(storeName, 'readwrite', (store) => store.clear())
}
