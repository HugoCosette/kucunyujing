import { ref } from 'vue'
import { defineStore } from 'pinia'
import { initialInventoryItems } from '@/data/inventoryItems'
import { DEFAULT_PANEL_KEY, inventoryPanels } from '@/data/panels'

function createInventoryState() {
  const inventoryItems = ref(initialInventoryItems.map((item) => ({ ...item })))
  const purchaseList = ref([])
  const plannedUndoHistory = ref({})

  return { inventoryItems, purchaseList, plannedUndoHistory }
}

// 每个面板一份独立状态：main 为主面板，example 为示例面板。
// ⚠️ 示例数据：example 的库存、采购清单与撤销记录仅作对照演示，勿改示例数据。
const inventoryStoreDefinitions = Object.fromEntries(
  inventoryPanels.map((panel) => [
    panel.key,
    defineStore(`inventory-${panel.key}`, createInventoryState),
  ]),
)

export function useInventoryStore(panelKey = DEFAULT_PANEL_KEY) {
  const definition =
    inventoryStoreDefinitions[panelKey] ?? inventoryStoreDefinitions[DEFAULT_PANEL_KEY]
  return definition()
}
