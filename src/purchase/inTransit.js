// 在途对账（唯一口径）
// ================================================================
// 同一批货在系统里只可能落在四个桶之一：
//   需安排（未下单） → 已安排（下单未排单） → 生产中（排单未入库） → 在仓
// 桶间迁移时「预计库存」必须纹丝不动，否则每天导入会让预警反复跳色。
//
// 三个累计量都从同一个切换日（baseline）起算：
//   o = 下单累计（本地订单流水里 status = active 的合计）
//   s = 排单累计（生产排单「进仓重量」的合计）
//   r = 生产入库累计（出入库明细「入库数量」里来源单据为生产 / 加工入库的部分）
//
//   在途   = max(0, max(o, s) − r)
//   生产中 = min(max(0, s − r), 在途)
//   已安排 = 在途 − 生产中
//
// 为什么取 max 而不是 o + s：同一批货在「下单」和「排单」两个视角里只算一次；
// 而排单里可能有我们没在本系统下过单的产量（提前备货），那也是要进仓的货，所以不能只取 o。
// 为什么减 r 而不是减「排单消失」：排单导出是累计流水（实测已完成的行不会消失），
// 只有生产入库能证明那批货真的进了仓。
// 退货入库不进 r：退货只让在仓增加，不应该把我们的采购单冲掉。

export const IN_TRANSIT_BASELINE_VERSION = 1

function amount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function toMap(source) {
  if (source instanceof Map) return source
  if (source && typeof source === 'object') return new Map(Object.entries(source))
  return new Map()
}

/**
 * 单个 SKU 的在途拆分。
 * @param {{orderedKg?: number, scheduledKg?: number, producedKg?: number}} input
 * @returns {{orderedKg: number, scheduledKg: number, producedKg: number, inTransitKg: number, producingKg: number, arrangedKg: number}}
 */
export function reconcileSku({ orderedKg, scheduledKg, producedKg } = {}) {
  const o = amount(orderedKg)
  const s = amount(scheduledKg)
  const r = amount(producedKg)
  const inTransitKg = Math.max(0, Math.max(o, s) - r)
  // 生产中只取「排单里还没入库」的部分，再被在途封顶，保证 在途 = 已安排 + 生产中
  const producingKg = Math.min(Math.max(0, s - r), inTransitKg)
  return {
    orderedKg: o,
    scheduledKg: s,
    producedKg: r,
    inTransitKg,
    producingKg,
    arrangedKg: inTransitKg - producingKg,
  }
}

/**
 * 切换日基线：把导入侧的排单累计 / 生产入库累计当前值记下来，之后只用增量。
 * 没有基线时，历史产量会把在途撑爆（实测排单累计 21.7 万公斤）。
 * @param {{skuId?: string, producing?: number, producedIn?: number}[]} items
 */
export function createInTransitBaseline(items, { now = null } = {}) {
  const skus = {}
  for (const item of items ?? []) {
    const skuId = String(item?.skuId ?? '').trim()
    if (!skuId) continue
    const scheduledKg = amount(item.producing)
    const producedKg = amount(item.producedIn)
    if (scheduledKg === 0 && producedKg === 0) continue
    skus[skuId] = { scheduledKg, producedKg }
  }
  return {
    version: IN_TRANSIT_BASELINE_VERSION,
    createdAt: now ?? new Date().toISOString(),
    skus,
  }
}

/**
 * 一次算出全表每个 SKU 的在途拆分。
 * @param {object} input
 * @param {{skuId?: string, producing?: number, producedIn?: number}[]} input.items 导入后的库存行
 * @param {Map<string, number>|Record<string, number>} [input.orderedTotals] 每 SKU 的累计下单（公斤）
 * @param {Map<string, number>|Record<string, number>} [input.receivedTotals] 每 SKU 的手工到货（公斤），与生产入库一起算「已到仓」
 * @param {{skus?: Record<string, {scheduledKg?: number, producedKg?: number}>}} [input.baseline]
 * @returns {Map<string, ReturnType<typeof reconcileSku>>}
 */
export function buildInTransitIndex({ items, orderedTotals, receivedTotals, baseline } = {}) {
  const ordered = toMap(orderedTotals)
  const received = toMap(receivedTotals)
  const base = toMap(baseline?.skus)
  const index = new Map()

  for (const item of items ?? []) {
    const skuId = String(item?.skuId ?? '').trim()
    if (!skuId) continue
    const line = base.get(skuId) ?? {}
    index.set(
      skuId,
      reconcileSku({
        orderedKg: ordered.get(skuId) ?? 0,
        // 排单只保留未完成时，累计值会下降，按 0 兜底，不让它变成负数
        scheduledKg: amount(item.producing) - amount(line.scheduledKg),
        // 到仓累计 = 导入的生产入库增量 + 手工登记的到货
        producedKg: amount(item.producedIn) - amount(line.producedKg) + amount(received.get(skuId)),
      }),
    )
  }

  return index
}

/** 把一笔新下单 / 撤销计入累计下单（公斤），负数（撤销）按 0 兜底。 */
export function addOrderedKg(orderedTotals, skuId, deltaKg) {
  const key = String(skuId ?? '').trim()
  if (!key) return toMap(orderedTotals)
  const next = toMap(orderedTotals)
  next.set(key, Math.max(0, amount(next.get(key)) + Number(deltaKg || 0)))
  return next
}
