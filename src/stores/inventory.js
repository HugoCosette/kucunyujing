import { ref } from 'vue'
import { defineStore } from 'pinia'
import { initialInventoryItems } from '@/data/inventoryItems'
import { createDefaultHeatSpecs } from '@/data/heatRules'
import { DEFAULT_PANEL_KEY, inventoryPanels } from '@/data/panels'
import { applyHeatSpecsToItems } from '@/utils/heatRules'

// 演示数据没有动销指标，按周消耗折算出一组稳定数值，
// 让热度配置（月均条数 / 动销客户等）在未导入 Excel 时也能展示分档；导入后以 Excel 为准。
function withDemoSalesMetrics(item) {
  return {
    ...item,
    monthlyAvgCount: item.monthlyAvgCount ?? Math.round(item.weeklyUsage * 4.3),
    totalOrders: item.totalOrders ?? Math.round(item.weeklyUsage * 12),
    activeMonths:
      item.activeMonths ?? (item.weeklyUsage >= 900 ? 12 : item.weeklyUsage >= 500 ? 9 : 6),
    activeCustomers: item.activeCustomers ?? Math.max(1, Math.round(item.weeklyUsage / 100)),
  }
}

function createInventoryState(panelKey) {
  const inventoryItems = ref(initialInventoryItems.map(withDemoSalesMetrics))
  const purchaseList = ref([])
  const plannedUndoHistory = ref({})
  // 热度规格同时承载因子条件与备货系数，新增规格时两者一起扩展。
  const heatSpecs = ref(createDefaultHeatSpecs())
  // 导入 Excel 的原始表格（全部列 + 全部非空行），供全面板只读展示；未导入时为 null。
  const importedSheet = ref(null)

  // 主面板的热度不再取自种子数据，统一按默认规格计算；
  // 示例面板保留原热度，仅作对照演示。
  if (panelKey === DEFAULT_PANEL_KEY) {
    applyHeatSpecsToItems(inventoryItems.value, heatSpecs.value)
  }

  return { inventoryItems, purchaseList, plannedUndoHistory, heatSpecs, importedSheet }
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
