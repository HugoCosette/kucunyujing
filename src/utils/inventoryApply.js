import { HEAT_FACTOR_FIELDS } from '@/data/quantityFields'

// 整表替换主面板库存行：库存数据以总表为准，需安排、撤销记录与采购清单按唯一标识保留，
// 因此改品名或颜色不会丢失已采纳的补货计划。动销指标只来自销售表，缺列或缺值记为空（评分记 Z）。
// 模式与系数不写回行数据，由视图按当前配置现算。
export function applyImportedInventory(store, importedItems, { salesBySku = null } = {}) {
  const { inventoryItems, purchaseList, plannedUndoHistory } = store

  const previousBySkuId = new Map()
  for (const item of inventoryItems) previousBySkuId.set(item.skuId, item)

  const idByPreviousId = new Map()
  const nextItems = importedItems.map((entry, index) => {
    const id = index + 1
    const previous = previousBySkuId.get(entry.skuId)
    if (previous) idByPreviousId.set(previous.id, id)

    const salesEntry = salesBySku?.get(entry.skuId) ?? null
    const salesMetrics = salesEntry?.metrics ?? null
    const metrics = {}
    for (const { field } of HEAT_FACTOR_FIELDS) {
      const value = salesMetrics?.[field]
      metrics[field] = Number.isFinite(value) ? value : null
    }
    // 月均条数只用于模式判定：优先取销售表自带值，否则由「累积条数 ÷ 动销月份」现算。
    if (!Number.isFinite(metrics.monthlyAvgCount)) {
      const cumulative = metrics.cumulativeCount
      const months = metrics.activeMonths
      metrics.monthlyAvgCount =
        Number.isFinite(cumulative) && Number.isFinite(months) && months > 0
          ? Math.round((cumulative / months) * 100) / 100
          : 0
    }

    return {
      id,
      skuId: entry.skuId,
      product: entry.product,
      color: entry.color,
      category: entry.category,
      treeCategory: entry.treeCategory ?? '',
      planned: previous?.planned ?? null,
      producing: entry.producing,
      backorder: entry.backorder,
      weeklySales: entry.weeklySales,
      warehouseStock: entry.warehouseStock,
      inTransitStock: entry.inTransitStock,
      turnoverIn: entry.turnoverIn,
      totalOutbound: entry.totalOutbound,
      // 公斤系数：库存（码或公斤）× 该系数 = 公斤；缺失时该行不参与计算。
      kgFactor: entry.kgFactor ?? null,
      // 1-12 月销量（公斤）与条数：加权月销量与弹窗折线图的原始数据。
      monthSales: Array.isArray(salesEntry?.sales) ? [...salesEntry.sales] : null,
      monthCounts: Array.isArray(salesEntry?.counts) ? [...salesEntry.counts] : null,
      // 累积销量（公斤）：评分进销比的分母。
      cumulativeSales: salesEntry?.cumulativeSales ?? null,
      ...metrics,
    }
  })

  // 模式判定、评分分档与系数统一由视图按当前配置计算。

  // 撤销快照按新 id 重建，避免新旧 id 相同或互换时互相覆盖。
  const nextUndoHistory = new Map()
  for (const [previousId, id] of idByPreviousId) {
    const undo = plannedUndoHistory[previousId]
    if (undo) nextUndoHistory.set(id, undo)
  }
  for (const key of Object.keys(plannedUndoHistory)) delete plannedUndoHistory[key]
  for (const [id, undo] of nextUndoHistory) plannedUndoHistory[id] = undo

  const nextItemById = new Map(nextItems.map((item) => [item.id, item]))
  const nextPurchaseList = []
  for (const purchaseItem of purchaseList) {
    const nextId = idByPreviousId.get(purchaseItem.id)
    const item = nextId === undefined ? null : nextItemById.get(nextId)
    if (!item) continue

    nextPurchaseList.push({
      ...purchaseItem,
      id: nextId,
      skuId: item.skuId,
      product: item.product,
      color: item.color,
      planned: item.planned ?? 0,
    })
  }

  inventoryItems.splice(0, inventoryItems.length, ...nextItems)
  purchaseList.splice(0, purchaseList.length, ...nextPurchaseList)

  return nextItems
}
