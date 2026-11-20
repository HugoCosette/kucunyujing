// 探索性测试：用真实 orders.json 检查数据完整性与聚合口径
import { readFileSync } from 'node:fs'
import { normalizeOrders } from '../../src/purchase/validate.js'
import { buildOrderIndex } from '../../src/purchase/resolve.js'
import { buildOrderHistory, filterHistory } from '../../src/purchase/history.js'

const raw = JSON.parse(readFileSync(new URL('../../src/purchase/orders.json', import.meta.url), 'utf-8'))
const doc = normalizeOrders(raw)
console.log('=== 归一化 ===')
console.log('订单数:', doc.orders.length, '草稿SKU:', Object.keys(doc.drafts).length)

let overRecv = 0, missingFactory = 0, recvMismatch = 0, cancelledWithRecv = 0
const overSamples = [], mismatchSamples = []
for (const o of doc.orders) {
  if (o.receivedQty > o.quantity + 1e-6) { overRecv++; if (overSamples.length < 5) overSamples.push(`${o.skuId}/${o.factoryName} qty=${o.quantity} recv=${o.receivedQty}`) }
  if (!o.factoryId && !o.factoryName) missingFactory++
  const sum = o.receipts.filter(r => !r.voidedAt).reduce((s, r) => s + r.qty, 0)
  if (Math.abs(sum - o.receivedQty) > 1e-6) { recvMismatch++; if (mismatchSamples.length < 5) mismatchSamples.push(`${o.skuId} receipts=${sum} receivedQty=${o.receivedQty}`) }
  if (o.status === 'cancelled' && o.receivedQty > 0) cancelledWithRecv++
}
console.log('=== 数据完整性 ===')
console.log('超收订单:', overRecv, '缺染厂:', missingFactory, 'receivedQty与receipts不符:', recvMismatch, '作废单仍带到货:', cancelledWithRecv)
if (overSamples.length) console.log('超收样本:', overSamples)
if (mismatchSamples.length) console.log('不符样本:', mismatchSamples)

const idx = buildOrderIndex(doc.orders)
let negPending = 0, orderedZero = 0
for (const v of idx.values()) { if (v.pending < 0) negPending++; if (v.ordered <= 0) orderedZero++ }
console.log('=== 聚合 ===')
console.log('聚合SKU数:', idx.size, '负待收SKU:', negPending, '累积下单<=0的SKU:', orderedZero)

const hist = buildOrderHistory(doc.orders)
const activeTotal = filterHistory(hist, { status: 'active' }).totals.quantity
const allTotal = filterHistory(hist, { status: 'all' }).totals.quantity
console.log('=== 历史 ===')
console.log('批次数:', hist.batches.length, '月份数:', hist.months.length)
console.log('有效单合计下单:', activeTotal.toFixed(2), '全部状态合计:', allTotal.toFixed(2))

// 检查该 SKU 的 ordered 与历史里非作废合计是否一致（两个模块口径交叉验证）
let crossMismatch = 0
const histSkuQty = new Map()
for (const b of filterHistory(hist, { status: 'active' }).batches)
  for (const o of b.orders) histSkuQty.set(o.skuId, (histSkuQty.get(o.skuId) || 0) + o.quantity)
for (const [sku, v] of idx) {
  const h = histSkuQty.get(sku) || 0
  if (Math.abs(v.ordered - h) > 1e-6) crossMismatch++
}
console.log('=== 交叉验证 ===')
console.log('orderIndex 与 history 按SKU合计不一致数:', crossMismatch)
