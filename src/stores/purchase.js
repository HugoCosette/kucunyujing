import { computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'
import {
  buildOrderIndex,
  loadOrders,
  loadSettings,
  normalizeOrders,
  orderSummaryOf,
  quantityModeOf,
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
    quantityMode: order.quantityMode,
    vatCount: order.vatCount,
    kgPerVat: order.kgPerVat,
    factoryId: order.factoryId,
    factoryName: order.factoryName,
    assignee: order.assignee,
    note: order.note,
  }
}

// 下单模块全应用单例：设置（染厂 / 分类-人员 / SKU 可选染厂）与分订单各存一份。
// 分订单以「唯一标识」为键：主面板重新导入后行 id 会重排，只有唯一标识稳定。
export const usePurchaseStore = defineStore('purchase', () => {
  const settings = shallowRef(loadSettings())
  const orders = shallowRef(loadOrders())

  const factories = computed(() => settings.value.dyeFactories)
  const activeFactories = computed(() =>
    settings.value.dyeFactories.filter((factory) => factory.enabled !== false),
  )
  const treeCategories = computed(() => settings.value.treeCategories)

  // 「备货」列与预计库存都只读这个索引：按唯一标识汇总 active 订单（作废的不算）。
  const orderIndex = computed(() => buildOrderIndex(orders.value.orders))

  let ordersSaveTimer = 0
  // 只提示一次：保存失败说明浏览器禁用了 IndexedDB，反复弹窗没有意义。
  let orderSaveFailureNotified = false

  function reportOrderSaveFailure() {
    if (orderSaveFailureNotified) return
    orderSaveFailureNotified = true
    ElMessage.error('分订单没能存到本机（浏览器可能禁用了 IndexedDB），关闭页面会丢失')
  }

  // 分订单编辑的是「草稿」：主面板完全感知不到，确认下单后才进 orders 流水。
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

  // 录入是连续的（改数量、选染厂），写盘防抖 400ms；离开页面时 flush 一次。
  // 运行态保留还没填写的空白行（否则刚点「添加分订单」的行会被归一化丢掉），
  // 落盘时 saveOrders 按默认口径丢弃空白行。
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

  // 下单页编辑的是草稿（drafts），确认下单后才成为订单。
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

  // 确认下单：草稿 → 订单（只追加，不物理删除），同一批共用 batchId。
  // targets: [{ skuId, product, color, entries? }]；返回实际生成的订单与跳过原因。
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
        const quantityMode = quantityModeOf(entry)
        const orderQuantity = quantityMode === 'kg' ? Math.round(quantity) : quantity
        const vatCount = Number(entry?.vatCount)
        const kgPerVat = Number(entry?.kgPerVat)
        // 缺染厂或没有公斤数：不能成为订单，记下来给页面提示。
        if (
          !(orderQuantity > 0) ||
          !(String(entry?.factoryId ?? '').trim() || String(entry?.factoryName ?? '').trim()) ||
          (quantityMode === 'vat' && (!(vatCount >= 1) || !(kgPerVat > 0)))
        ) {
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
          quantity: orderQuantity,
          quantityMode,
          vatCount: quantityMode === 'vat' ? Math.round(vatCount) : null,
          kgPerVat: quantityMode === 'vat' ? kgPerVat : null,
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
      else skipped.push({ skuId, reason: '没有可提交的分订单（缺染厂或公斤数）' })
    }

    if (!created.length) return { batchId, at, items: [], skipped }
    commitOrders({ ...orders.value, drafts, orders: [...orders.value.orders, ...created] })
    return { batchId, at, items: created, skipped }
  }

  // 撤销整张分订单：保留流水（status=cancelled），返回被撤公斤数，调用处据此回补需安排。
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

  // 下单历史的物理删除：整张订单连同 receipts / revisions 一起移除。
  function removeOrder(orderId) {
    const target = orders.value.orders.find((order) => order.id === orderId)
    if (!target) return null
    commitOrders({
      ...orders.value,
      orders: orders.value.orders.filter((order) => order.id !== orderId),
    })
    return target
  }

  // 批次删除按 batchId 删除全部分订单，不受历史页当前筛选结果影响。
  function removeBatchOrders(batchId) {
    const key = String(batchId ?? '').trim()
    if (!key) return []
    const removed = orders.value.orders.filter(
      (order) => (String(order.batchId ?? '').trim() || String(order.id ?? '').trim()) === key,
    )
    if (!removed.length) return []
    const removedIds = new Set(removed.map((order) => order.id))
    commitOrders({
      ...orders.value,
      orders: orders.value.orders.filter((order) => !removedIds.has(order.id)),
    })
    return removed
  }

  // 到货是追加一条实收记录，不覆盖 receivedQty；receivedQty 由 receipts 求和派生。
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

  // 撤回一条到货：数量退回待收（receivedQty 由 receipts 派生），记录留在列表里灰显，
  // 谁在什么时候撤的都能追溯；要彻底清掉请用 removeReceipt。
  function voidReceipt(orderId, receiptId) {
    const at = nowIso()
    let updated = null
    const nextOrders = orders.value.orders.map((order) => {
      if (order.id !== orderId || order.status !== ORDER_STATUS.ACTIVE) return order
      let hit = false
      const receipts = order.receipts.map((receipt) => {
        if (receipt.id !== receiptId || receipt.voidedAt) return receipt
        hit = true
        return { ...receipt, voidedAt: at }
      })
      if (!hit) return order
      updated = { ...order, receipts, updatedAt: at }
      return updated
    })
    if (!updated) return null
    commitOrders({ ...orders.value, orders: nextOrders })
    return updated
  }

  // 恢复一条被撤回的到货：撤回操作本身可撤销，清掉 voidedAt 后数量重新计入已到货（待收相应减少）。
  // 下单量事后被改小、恢复会超过下单量时拒绝，避免出现「已到货 > 下单量」。
  function restoreReceipt(orderId, receiptId) {
    const at = nowIso()
    let updated = null
    const nextOrders = orders.value.orders.map((order) => {
      if (order.id !== orderId || order.status !== ORDER_STATUS.ACTIVE) return order
      const target = order.receipts.find((receipt) => receipt.id === receiptId)
      if (!target || !target.voidedAt) return order
      const received = order.receipts.reduce(
        (sum, receipt) => sum + (receipt.voidedAt ? 0 : Number(receipt.qty) || 0),
        0,
      )
      if (received + target.qty > (Number(order.quantity) || 0) + 1e-9) return order
      updated = {
        ...order,
        receipts: order.receipts.map((receipt) =>
          receipt.id === receiptId ? { ...receipt, voidedAt: null, restoredAt: at } : receipt,
        ),
        updatedAt: at,
      }
      return updated
    })
    if (!updated) return null
    commitOrders({ ...orders.value, orders: nextOrders })
    return updated
  }

  // 删除一条到货：连记录一起抹掉不留痕（录错数据时用），数量同样退回待收。
  function removeReceipt(orderId, receiptId) {
    const at = nowIso()
    let updated = null
    const nextOrders = orders.value.orders.map((order) => {
      if (order.id !== orderId || order.status !== ORDER_STATUS.ACTIVE) return order
      if (!order.receipts.some((receipt) => receipt.id === receiptId)) return order
      updated = {
        ...order,
        receipts: order.receipts.filter((receipt) => receipt.id !== receiptId),
        updatedAt: at,
      }
      return updated
    })
    if (!updated) return null
    commitOrders({ ...orders.value, orders: nextOrders })
    return updated
  }

  // 修改已提交订单：允许原地改，但每次落一条 revisions 留痕。
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

  // 设置页用草稿编辑，点「确定」才走这里落盘。
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
    removeOrder,
    removeBatchOrders,
    receiveOrder,
    voidReceipt,
    restoreReceipt,
    removeReceipt,
    updateOrder,
    flushOrders,
    applySettings,
  }
})
