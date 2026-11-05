import { applyImportedInventory } from '@/utils/inventoryApply'

// 导入确认后的统一写回：总表整表替换主面板库存行，销售表的动销指标与 1-12 月数据写入 store。
// 手动导入（useSourceImport）与分表清洗导入（useSplitImport）共用这一段。
export function applySourceImport(inventoryStore, { inventory, sales }) {
  applyImportedInventory(inventoryStore, inventory.items, {
    salesBySku: sales.merge.bySku,
  })
  inventoryStore.salesSheet = {
    fileName: sales.fileName,
    sheetName: sales.sheetName,
    months: sales.months,
    metricFields: sales.metricFields,
    bySku: sales.merge.bySku,
  }
}
