import { ref } from 'vue'
import { defineStore } from 'pinia'
import { initialInventoryItems } from '@/data/inventoryItems'
import { stockingRules } from '@/data/stockingRules'
import { createDefaultHeatConfig } from '@/data/heatRules'
import { DEFAULT_PANEL_KEY, inventoryPanels } from '@/data/panels'
import { applyHeatConfigToItems } from '@/utils/heatRules'

function cloneStockingCoefficients() {
  return JSON.parse(JSON.stringify(stockingRules))
}

function createInventoryState(panelKey) {
  const inventoryItems = ref(initialInventoryItems.map((item) => ({ ...item })))
  const purchaseList = ref([])
  const plannedUndoHistory = ref({})
  const heatConfig = ref(createDefaultHeatConfig())
  const stockingCoefficients = ref(cloneStockingCoefficients())

  // 主面板的热度不再取自种子数据，统一按热度配置的默认规则计算；
  // 示例面板保留原热度，仅作对照演示。
  if (panelKey === DEFAULT_PANEL_KEY) {
    applyHeatConfigToItems(inventoryItems.value, heatConfig.value)
  }

  return { inventoryItems, purchaseList, plannedUndoHistory, heatConfig, stockingCoefficients }
}

// 每个面板一份独立状态：main 为主面板，example 为示例面板。
// ⚠️ 示例数据：example 的库存、采购清单与撤销记录仅作对照演示，勿改示例数据。
const inventoryStoreDefinitions = Object.fromEntries(
  inventoryPanels.map((panel) => [
    panel.key,
    defineStore(`inventory-${panel.key}`, () => createInventoryState(panel.key)),
  ]),
)

export function useInventoryStore(panelKey = DEFAULT_PANEL_KEY) {
  const definition =
    inventoryStoreDefinitions[panelKey] ?? inventoryStoreDefinitions[DEFAULT_PANEL_KEY]
  return definition()
}
