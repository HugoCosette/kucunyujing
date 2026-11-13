import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { initialInventoryItems } from '@/data/inventoryItems'

// 演示数据缺少唯一标识、总出库数量、动销指标与公斤系数：按周消耗折算一组稳定数值，
// 让模式判定在未导入 Excel 时同样可见；导入后一律以 Excel 为准。
// 演示数据按「公斤」计量（公斤系数 = 1），月度销量取 12 个月等值。
function withDemoSourceFields(item) {
  const monthlyAvgCount = item.monthlyAvgCount ?? Math.round(item.weeklyUsage * 4.3)
  const weeklySales = item.weeklySales ?? item.weeklyUsage
  return {
    ...item,
    skuId: item.skuId ?? `DEMO-${String(item.id).padStart(3, '0')}`,
    totalOutbound: item.totalOutbound ?? 0,
    monthlyAvgCount,
    totalOrders: item.totalOrders ?? Math.round(item.weeklyUsage * 12),
    activeMonths:
      item.activeMonths ?? (item.weeklyUsage >= 900 ? 12 : item.weeklyUsage >= 500 ? 9 : 6),
    activeCustomers:
      item.activeCustomers ?? Math.max(1, Math.round(item.weeklyUsage / 100)),
    kgFactor: item.kgFactor ?? 1,
    weeklySales,
    monthSales: item.monthSales ?? new Array(12).fill(monthlyAvgCount),
  }
}

function createInventoryState() {
  const inventoryItems = ref(initialInventoryItems.map(withDemoSourceFields))
  const purchaseList = ref([])
  const plannedUndoHistory = ref({})
  // 销售表：在“销售表”面板导入的 1-12 月条数与重量，按唯一标识叠加到主面板行上。
  // 数据可达数万 SKU，用 shallowRef 保存整体替换的对象，不做逐行深度响应式。
  const salesSheet = shallowRef(null)

  // 模式与系数在视图计算时按当前配置现算，store 只保存导入的原始数据。
  return { inventoryItems, purchaseList, plannedUndoHistory, salesSheet }
}

// 库存、采购清单、撤销记录与销售表都是全局唯一的一份运行状态。
export const useInventoryStore = defineStore('inventory', createInventoryState)
