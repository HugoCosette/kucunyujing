import { computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  loadOrders,
  loadSettings,
  normalizeOrders,
  saveOrders,
  saveSettings,
  summarizeOrders,
} from '@/purchase'

// 下单模块全应用单例：设置（染厂 / 分类-人员 / SKU 可选染厂）与分订单各存一份。
// 分订单以「唯一标识」为键：主面板重新导入后 purchaseList 的 id 会重排，只有唯一标识稳定。
export const usePurchaseStore = defineStore('purchase', () => {
  const settings = shallowRef(loadSettings())
  const orders = shallowRef(loadOrders())

  const factories = computed(() => settings.value.dyeFactories)
  const activeFactories = computed(() =>
    settings.value.dyeFactories.filter((factory) => factory.enabled !== false),
  )
  const treeCategories = computed(() => settings.value.treeCategories)

  let ordersSaveTimer = 0

  function orderEntries(skuId) {
    const key = String(skuId ?? '').trim()
    return key ? orders.value.orders[key] ?? [] : []
  }

  function orderSummary(skuId) {
    return summarizeOrders(orderEntries(skuId))
  }

  function orderTotal(skuId) {
    return orderSummary(skuId).total
  }

  // 录入是连续的（改数量、选染厂），写盘防抖 400ms；离开页面时 flush 一次。
  // 运行态保留还没填写的空白行（否则刚点「添加分订单」的行会被归一化丢掉），
  // 落盘时 saveOrders 按默认口径丢弃空白行。
  function commitOrders(next) {
    orders.value = normalizeOrders(next, { keepBlankEntries: true })
    if (ordersSaveTimer) clearTimeout(ordersSaveTimer)
    ordersSaveTimer = window.setTimeout(() => {
      ordersSaveTimer = 0
      void saveOrders(orders.value)
    }, 400)
  }

  async function flushOrders() {
    if (!ordersSaveTimer) return
    clearTimeout(ordersSaveTimer)
    ordersSaveTimer = 0
    await saveOrders(orders.value)
  }

  function setOrderEntries(skuId, entries) {
    const key = String(skuId ?? '').trim()
    if (!key) return

    const next = { ...orders.value, orders: { ...orders.value.orders } }
    if (Array.isArray(entries) && entries.length) next.orders[key] = entries
    else delete next.orders[key]
    commitOrders(next)
  }

  function clearOrderEntries(skuId) {
    setOrderEntries(skuId, [])
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
    orderEntries,
    orderSummary,
    orderTotal,
    setOrderEntries,
    clearOrderEntries,
    flushOrders,
    applySettings,
  }
})
