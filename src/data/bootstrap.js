import { isIndexedDbAvailable } from './db.js'
import { DOC_KEY_ORDERS, readDocument, writeDocument } from './repo.js'
import { hydrateFromStorage } from './persistence.js'
import { getOrders, setOrdersRuntime } from '@/purchase/persistence.js'

// 启动顺序：先把本机数据读回内存，再挂载应用 —— 这样首屏就是「上次的库存 + 需安排 + 订单」，
// 不需要再导入一次；本机没有数据时保持原有行为（演示种子数据）。

function stampOf(document) {
  const stamp = Date.parse(document?.updatedAt ?? '')
  return Number.isFinite(stamp) ? stamp : 0
}

// 老版本把订单写在 localStorage：第一次打开时搬进 IndexedDB，之后只认 IndexedDB。
async function resolveOrdersDocument() {
  const stored = await readDocument(DOC_KEY_ORDERS)
  const legacy = getOrders()
  if (!stored) {
    if (Array.isArray(legacy?.orders) && legacy.orders.length) {
      await writeDocument(DOC_KEY_ORDERS, legacy)
    }
    return legacy
  }
  if (stampOf(legacy) > stampOf(stored)) {
    await writeDocument(DOC_KEY_ORDERS, legacy)
    return legacy
  }
  return stored
}

export async function bootstrapPersistence() {
  if (!isIndexedDbAvailable()) return { supported: false, restored: false }
  try {
    const orders = await resolveOrdersDocument()
    if (orders) setOrdersRuntime(orders)
    return { supported: true, ...(await hydrateFromStorage()) }
  } catch (error) {
    console.warn('读取本机持久化数据失败，先用默认数据启动', error)
    return { supported: true, restored: false, error }
  }
}
