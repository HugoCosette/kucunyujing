import { shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { loadConfig, resetConfig, saveConfig } from '@/stocking'

// 备货规则配置全应用只有一份：主面板与示例面板的配置页共用，改任一处效果一致。
export const useStockingConfigStore = defineStore('stocking-config', () => {
  const config = shallowRef(loadConfig())

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

  return { config, apply, restoreDefaults }
})
