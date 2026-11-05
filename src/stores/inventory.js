import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { initialInventoryItems } from '@/data/inventoryItems'
import { DEFAULT_PANEL_KEY, inventoryPanels } from '@/data/panels'

// 演示数据缺少唯一标识、总出库数量与动销指标：按周消耗折算一组稳定数值，
// 让规则判定与热度分档在未导入 Excel 时同样可见；导入后一律以 Excel 为准。
function withDemoSourceFields(item) {
  return {
    ...item,
    skuId: item.skuId ?? `DEMO-${String(item.id).padStart(3, '0')}`,
    totalOutbound: item.totalOutbound ?? 0,
    monthlyAvgCount: item.monthlyAvgCount ?? Math.round(item.weeklyUsage * 4.3),
    totalOrders: item.totalOrders ?? Math.round(item.weeklyUsage * 12),
    activeMonths:
      item.activeMonths ?? (item.weeklyUsage >= 900 ? 12 : item.weeklyUsage >= 500 ? 9 : 6),
    activeCustomers:
      item.activeCustomers ?? Math.max(1, Math.round(item.weeklyUsage / 100)),
  }
}

function createInventoryState() {
  const inventoryItems = ref(initialInventoryItems.map(withDemoSourceFields))
  const purchaseList = ref([])
  const plannedUndoHistory = ref({})
  // 销售表：在“销售表”面板导入的 1-12 月条数与重量，按唯一标识叠加到主面板行上。
  // 数据可达数万 SKU，用 shallowRef 保存整体替换的对象，不做逐行深度响应式。
  const salesSheet = shallowRef(null)

  // 规则 / 热度档 / 系数在视图计算时按当前配置现算，store 只保存导入的原始数据。
  return { inventoryItems, purchaseList, plannedUndoHistory, salesSheet }
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
