import { applyImportedInventory } from '@/utils/inventoryApply'
import { findBaselineMonth } from '@/stocking'
import { persistFactLayer, writeInTransitBaseline } from '@/data/persistence'
import { buildImportDiff, captureImportBaseline, saveImportDiff } from '@/data/importDiff'

// 导入确认后的统一写回：总表整表替换主面板库存行，销售表的动销指标、客户CR5率与 1-12 月数据写入 store。
// 手动导入（useSourceImport）与分表清洗导入（useSplitImport）共用这一段。
export function applySourceImport(inventoryStore, { inventory, sales }) {
  // 「SKU 数据变动」只能在整表替换之前抓旧值：替换之后旧行就没了。
  // 只留要比的几个字段，2 万行也只是几十万个数字，不阻塞导入。
  const beforeSnapshot = captureImportBaseline(inventoryStore.inventoryItems)

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

  // 在途对账基线：第一次导入时按当次导入的排单 / 生产入库建一份并落盘，
  // 之后每次导入只算增量（历史产量不进在途）。基线跨快照保留，与快照分开存。
  const { baseline, created } = inventoryStore.ensureInTransitBaseline(items)
  if (created) void writeInTransitBaseline(baseline)

  // 导入的终点从「只写内存」改成「内存 + 快照」：刷新或重开浏览器后不用再导入一次。
  // 快照落库在后台进行，不阻塞确认按钮；需安排按 skuId 单独存，不随快照回滚。
  // 返回 Promise<snapshotId|null>，null 表示没存住，调用方要提示用户刷新会丢数据。
  const persisted = persistFactLayer(inventoryStore, {
    createSnapshot: true,
    source: 'import',
    meta: { inventoryFileName: inventory.fileName, salesFileName: sales.fileName },
  })

  // 「SKU 数据变动」：跟这次导入前的值逐字段比一次，落一份报表（丢了也不影响导入）。
  const diff = buildImportDiff(beforeSnapshot, items, {
    files: { inventory: inventory.fileName, sales: sales.fileName },
  })
  void saveImportDiff(diff)

  return { persisted, diff }
}
