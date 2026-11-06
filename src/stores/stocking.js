import { computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  loadConfig,
  loadManualSkus,
  resetConfig,
  saveConfig,
  saveManualSkus,
} from '@/stocking'

// 备货模式配置全应用只有一份：主面板与示例面板的配置页共用，改任一处效果一致。
// 手动清单同理：它记录「人对商品的长期决定」，独立成文件，跨导入与刷新都有效。
export const useStockingConfigStore = defineStore('stocking-config', () => {
  const config = shallowRef(loadConfig())
  const manual = shallowRef(loadManualSkus(config.value))

  // 评估器消费的形态：skuId → { modeId, coefficients }
  const manualOverrides = computed(() => new Map(Object.entries(manual.value.items ?? {})))

  // 保存后写回源文件（开发态）或本地缓存（构建产物），并同步到全局单例。
  async function apply(nextConfig) {
    const saved = await saveConfig(nextConfig)
    config.value = saved.config
    return saved
  }

  async function restoreDefaults() {
    const saved = await resetConfig()
    config.value = saved.config
    return saved
  }

  async function applyManual(nextManual) {
    const saved = await saveManualSkus(nextManual, config.value)
    manual.value = saved.manual
    return saved
  }

  async function setManualEntry(skuId, entry) {
    const key = String(skuId ?? '').trim()
    if (!key) return { manual: manual.value, written: false }

    const items = { ...manual.value.items }
    if (!entry) delete items[key]
    else items[key] = entry
    return applyManual({ ...manual.value, items })
  }

  async function removeManualEntries(skuIds) {
    const keys = new Set((skuIds ?? []).map((id) => String(id ?? '').trim()))
    if (keys.size === 0) return { manual: manual.value, written: false }

    const items = Object.fromEntries(
      Object.entries(manual.value.items).filter(([skuId]) => !keys.has(skuId)),
    )
    return applyManual({ ...manual.value, items })
  }

  return {
    config,
    manual,
    manualOverrides,
    apply,
    restoreDefaults,
    applyManual,
    setManualEntry,
    removeManualEntries,
  }
})
