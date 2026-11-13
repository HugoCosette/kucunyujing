import { computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import {
  buildOrderIndex,
  loadOrders,
  loadSettings,
  normalizeOrders,
  orderSummaryOf,
  saveOrders,
  saveSettings,
} from '@/purchase'

const ORDER_STATUS = { ACTIVE: 'active', CANCELLED: 'cancelled' }

function nowIso() {
  return new Date().toISOString()
}

function snapshotOf(order) {
  return {
    quantity: order.quantity,
    vatCount: order.vatCount,
    kgPerVat: order.kgPerVat,
    factoryId: order.factoryId,
    factoryName: order.factoryName,
    assignee: order.assignee,
    note: order.note,
  }
}

// 涓嬪崟妯″潡鍏ㄥ簲鐢ㄥ崟渚嬶細璁剧疆锛堟煋鍘?/ 鍒嗙被-浜哄憳 / SKU 鍙€夋煋鍘傦級涓庡垎璁㈠崟鍚勫瓨涓€浠姐€?
// 鍒嗚鍗曚互銆屽敮涓€鏍囪瘑銆嶄负閿細涓婚潰鏉块噸鏂板鍏ュ悗 purchaseList 鐨?id 浼氶噸鎺掞紝鍙湁鍞竴鏍囪瘑绋冲畾銆?
export const usePurchaseStore = defineStore('purchase', () => {
  const settings = shallowRef(loadSettings())
  const orders = shallowRef(loadOrders())

  const factories = computed(() => settings.value.dyeFactories)
  const activeFactories = computed(() =>
    settings.value.dyeFactories.filter((factory) => factory.enabled !== false),
  )
  const treeCategories = computed(() => settings.value.treeCategories)

  // 銆屽璐с€嶅垪涓庨璁″簱瀛橀兘鍙杩欎釜绱㈠紩锛氭寜鍞竴鏍囪瘑姹囨€?active 璁㈠崟锛堜綔搴熺殑涓嶇畻锛夈€?
  const orderIndex = computed(() => buildOrderIndex(orders.value.orders))

  let ordersSaveTimer = 0
  // 只提示一次：保存失败说明浏览器禁用了 IndexedDB，反复弹窗没有意义。
  let orderSaveFailureNotified = false

  function reportOrderSaveFailure() {
    if (orderSaveFailureNotified) return
    orderSaveFailureNotified = true
    ElMessage.error('分订单没能存到本机（浏览器可能禁用了 IndexedDB），关闭页面会丢失')
  }

  // 鍒嗚鍗曠紪杈戠殑鏄€岃崏绋裤€嶏細涓婚潰鏉垮畬鍏ㄦ劅鐭ヤ笉鍒帮紝纭涓嬪崟鍚庢墠杩?orders 娴佹按銆?
  function orderEntries(skuId) {
    const key = String(skuId ?? '').trim()
    return key ? orders.value.drafts[key] ?? [] : []
  }

  function orderSummary(skuId) {
    const entry = orderSummaryOf(orderIndex.value, skuId)
    return {
      total: entry.ordered,
      counted: entry.count,
      count: entry.count,
      vats: entry.vats,
      received: entry.received,
      pending: entry.pending,
      orders: entry.orders,
    }
  }

  function orderTotal(skuId) {
    return orderSummary(skuId).total
  }

  // 褰曞叆鏄繛缁殑锛堟敼鏁伴噺銆侀€夋煋鍘傦級锛屽啓鐩橀槻鎶?400ms锛涚寮€椤甸潰鏃?flush 涓€娆°€?
  // 杩愯鎬佷繚鐣欒繕娌″～鍐欑殑绌虹櫧琛岋紙鍚﹀垯鍒氱偣銆屾坊鍔犲垎璁㈠崟銆嶇殑琛屼細琚綊涓€鍖栦涪鎺夛級锛?
  // 钀界洏鏃?saveOrders 鎸夐粯璁ゅ彛寰勪涪寮冪┖鐧借銆?
  function commitOrders(next) {
    orders.value = normalizeOrders({ ...next, updatedAt: nowIso() }, { keepBlankEntries: true })
    if (ordersSaveTimer) clearTimeout(ordersSaveTimer)
    ordersSaveTimer = window.setTimeout(() => {
      ordersSaveTimer = 0
      void saveOrders(orders.value).then((result) => {
        if (result?.persisted === false) reportOrderSaveFailure()
      })
    }, 400)
  }

  async function flushOrders() {
    if (!ordersSaveTimer) return
    clearTimeout(ordersSaveTimer)
    ordersSaveTimer = 0
    const result = await saveOrders(orders.value)
    if (result?.persisted === false) reportOrderSaveFailure()
    return result
  }

  // 涓嬪崟椤电紪杈戠殑鏄崏绋匡紙drafts锛夛紝纭涓嬪崟鍚庢墠鎴愪负璁㈠崟銆?
  function setOrderEntries(skuId, entries) {
    const key = String(skuId ?? '').trim()
    if (!key) return

    const drafts = { ...orders.value.drafts }
    if (Array.isArray(entries) && entries.length) drafts[key] = entries
    else delete drafts[key]
    commitOrders({ ...orders.value, drafts })
  }

  function clearOrderEntries(skuId) {
    setOrderEntries(skuId, [])
  }

  // 纭涓嬪崟锛氳崏绋?鈫?璁㈠崟锛堝彧杩藉姞锛屼笉鐗╃悊鍒犻櫎锛夛紝鍚屼竴鎵瑰叡鐢?batchId銆?
  // targets: [{ skuId, product, color, entries? }]锛涜繑鍥炲疄闄呯敓鎴愮殑璁㈠崟涓庤烦杩囧師鍥犮€?
  function submitOrders(targets) {
    const at = nowIso()
    const seed = Date.now().toString(36)
    const batchId = `bt-${seed}`
    const drafts = { ...orders.value.drafts }
    const created = []
    const skipped = []

    for (const target of targets ?? []) {
      const skuId = String(target?.skuId ?? '').trim()
      if (!skuId) continue

      const source = Array.isArray(target?.entries) ? target.entries : drafts[skuId] ?? []
      let accepted = 0
      for (const entry of source) {
        const quantity = Number(entry?.quantity)
        // 缂烘煋鍘傛垨娌℃湁鍏枻鏁帮細涓嶈兘鎴愪负璁㈠崟锛岃涓嬫潵缁欓〉闈㈡彁绀恒€?
        if (!(quantity > 0) || !(String(entry?.factoryId ?? '').trim() || String(entry?.factoryName ?? '').trim())) {
          continue
        }
        created.push({
          id: `so-${seed}-${created.length + 1}`,
          batchId,
          skuId,
          product: String(target?.product ?? '').trim(),
          color: String(target?.color ?? '').trim(),
          factoryId: String(entry.factoryId ?? '').trim(),
          factoryName: String(entry.factoryName ?? '').trim(),
          assignee: String(entry.assignee ?? '').trim(),
          quantity,
          vatCount: Number(entry.vatCount) >= 1 ? Math.round(Number(entry.vatCount)) : null,
          kgPerVat: Number(entry.kgPerVat) > 0 ? Number(entry.kgPerVat) : null,
          note: String(entry.note ?? '').trim(),
          status: ORDER_STATUS.ACTIVE,
          submittedAt: at,
          updatedAt: at,
          month: at.slice(0, 7),
          receivedQty: 0,
          receipts: [],
          revisions: [],
          cancelledAt: null,
        })
        accepted += 1
      }

      if (accepted) delete drafts[skuId]
      else skipped.push({ skuId, reason: '娌℃湁鍙彁浜ょ殑鍒嗚鍗曪紙缂烘煋鍘傛垨鍏枻鏁帮級' })
    }

    if (!created.length) return { batchId, at, items: [], skipped }
    commitOrders({ ...orders.value, drafts, orders: [...orders.value.orders, ...created] })
    return { batchId, at, items: created, skipped }
  }

  // 鎾ら攢鏁村紶鍒嗚鍗曪細淇濈暀娴佹按锛坰tatus=cancelled锛夛紝杩斿洖琚挙鍏枻鏁帮紝璋冪敤澶勬嵁姝ゅ洖琛ラ渶瀹夋帓銆?
  function cancelOrder(orderId) {
    const at = nowIso()
    let cancelled = null
    const nextOrders = orders.value.orders.map((order) => {
      if (order.id !== orderId || order.status !== ORDER_STATUS.ACTIVE) return order
      cancelled = order
      return { ...order, status: ORDER_STATUS.CANCELLED, cancelledAt: at, updatedAt: at }
    })
    if (!cancelled) return null
    commitOrders({ ...orders.value, orders: nextOrders })
    return { order: cancelled, quantity: cancelled.quantity }
  }

  // 鍒拌揣鏄拷鍔犱竴鏉″疄鏀惰褰曪紝涓嶈鐩?receivedQty锛況eceivedQty 鐢?receipts 姹傚拰娲剧敓銆?
  function receiveOrder(orderId, qty, by = '') {
    const amount = Number(qty)
    if (!Number.isFinite(amount) || amount <= 0) return null

    const at = nowIso()
    let updated = null
    const nextOrders = orders.value.orders.map((order) => {
      if (order.id !== orderId || order.status !== ORDER_STATUS.ACTIVE) return order
      updated = order
      return {
        ...order,
        receipts: [
          ...order.receipts,
          { id: `rc-${Date.now().toString(36)}-${order.receipts.length + 1}`, at, qty: amount, by: String(by ?? '').trim() },
        ],
        updatedAt: at,
      }
    })
    if (!updated) return null
    commitOrders({ ...orders.value, orders: nextOrders })
    return { order: updated, qty: amount }
  }

  function removeLastReceipt(orderId) {
    const at = nowIso()
    let updated = null
    const nextOrders = orders.value.orders.map((order) => {
      if (order.id !== orderId || order.receipts.length === 0) return order
      updated = order
      return { ...order, receipts: order.receipts.slice(0, -1), updatedAt: at }
    })
    if (!updated) return null
    commitOrders({ ...orders.value, orders: nextOrders })
    return updated
  }

  // 淇敼宸叉彁浜よ鍗曪細鍏佽鍘熷湴鏀癸紝浣嗘瘡娆¤惤涓€鏉?revisions 鐣欑棔銆?
  function updateOrder(orderId, patch, operator = '') {
    const at = nowIso()
    let updated = null
    const nextOrders = orders.value.orders.map((order) => {
      if (order.id !== orderId || order.status !== ORDER_STATUS.ACTIVE) return order
      const next = { ...order, ...patch, updatedAt: at }
      updated = next
      return {
        ...next,
        revisions: [
          ...order.revisions,
          { at, by: String(operator ?? '').trim(), before: snapshotOf(order), after: snapshotOf(next) },
        ],
      }
    })
    if (!updated) return null
    commitOrders({ ...orders.value, orders: nextOrders })
    return updated
  }

  // 璁剧疆椤电敤鑽夌缂栬緫锛岀偣銆岀‘瀹氥€嶆墠璧拌繖閲岃惤鐩樸€?
  async function applySettings(nextSettings) {
    const saved = await saveSettings(nextSettings)
    settings.value = saved.settings
    return saved
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void flushOrders()
    })
  }

  return {
    settings,
    orders,
    factories,
    activeFactories,
    treeCategories,
    orderIndex,
    orderEntries,
    orderSummary,
    orderTotal,
    setOrderEntries,
    clearOrderEntries,
    submitOrders,
    cancelOrder,
    receiveOrder,
    removeLastReceipt,
    updateOrder,
    flushOrders,
    applySettings,
  }
})
