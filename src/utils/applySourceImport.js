import { applyImportedInventory } from '@/utils/inventoryApply'
import { findBaselineMonth } from '@/stocking'
import { persistFactLayer } from '@/data/persistence'

// 导入确认后的统一写回：总表整表替换主面板库存行，销售表的动销指标、客户CR5率与 1-12 月数据写入 store。
// 手动导入（useSourceImport）与分表清洗导入（useSplitImport）共用这一段。
export function applySourceImport(inventoryStore, { inventory, sales }) {
  const items = applyImportedInventory(inventoryStore, inventory.items, {
    salesBySku: sales.merge.bySku,
  })
  inventoryStore.salesSheet = {
    fileName: sales.fileName,
    sheetName: sales.sheetName,
    months: sales.months,
    metricFields: sales.metricFields,
    bySku: sales.merge.bySku,
    // 「近 N 个月」的基准月：数据里最后一个有销量的月份。
    baselineMonth: findBaselineMonth(items),
  }

  // 导入的终点从「只写内存」改成「内存 + 快照」：刷新或重开浏览器后不用再导入一次。
  // 快照落库在后台进行，不阻塞确认按钮；需安排与采购清单按 skuId 单独存，不随快照回滚。
  // 返回 Promise<snapshotId|null>，null 表示没存住，调用方要提示用户刷新会丢数据。
  return persistFactLayer(inventoryStore, {
    createSnapshot: true,
    source: 'import',
    meta: { inventoryFileName: inventory.fileName, salesFileName: sales.fileName },
  })
}
