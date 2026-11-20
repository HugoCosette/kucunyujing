// 核心业务逻辑单元测试（不用任何第三方框架，node 直接跑）
// 覆盖采购下单两大核心问题：给谁下单（resolve）/ 下多少（vat），以及订单聚合、颜色口径、库存计算、归一化、历史。
// 运行：node tests/unit/core-logic.test.mjs
import {
  createDefaultVatRules, planOrderQuantity, resolveVatRule, resolveVatBand,
  vatQuantityOptions, normalizeVatSizes, validateVatRule, normalizeVatRule, VAT_RULE_NONE,
} from '../../src/purchase/vat.js'
import {
  enabledFactories, factoriesForSku, assigneesForSku, assigneesForCategory,
  categoryForSku, summarizeOrders, buildOrderIndex, orderSummaryOf,
  findFactoryById, findFactoryByName,
} from '../../src/purchase/resolve.js'
import { fillTone, FILL_LOW_RATIO } from '../../src/purchase/fillTone.js'
import { calculateInventoryRow, getSuggestedPlanned } from '../../src/utils/inventory.js'
import { normalizeOrders, normalizeSettings } from '../../src/purchase/validate.js'
import { buildOrderHistory, filterHistory } from '../../src/purchase/history.js'

let passed = 0, failed = 0
const failures = []
function ok(id, desc, fn) {
  try { fn(); passed++ }
  catch (e) { failed++; failures.push({ id, desc, msg: e.message }); console.log(`FAIL ${id} ${desc}\n     ${e.message}`) }
}
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label} 期望 ${b}，实际 ${a}`)
}
function near(actual, expected, label = '') {
  if (Math.abs(actual - expected) > 1e-6) throw new Error(`${label} 期望 ${expected}，实际 ${actual}`)
}

const [STANDARD, SMALL] = createDefaultVatRules()

// ===== A. 下多少 —— 缸规则换算（vat.js）=====
ok('TC-A01', '标准规则 need=20 → 补到 80（1缸）', () => {
  const r = planOrderQuantity(20, STANDARD); eq(r.rounded, 80); eq(r.vatCount, 1); eq(r.action, 'fixed')
})
ok('TC-A02', '标准规则 need=100 → 补到 80', () => eq(planOrderQuantity(100, STANDARD).rounded, 80))
ok('TC-A03', '边界 need=120 归前段 → 补到 80', () => eq(planOrderQuantity(120, STANDARD).rounded, 80))
ok('TC-A04', '边界 need=121 进后段 → 补到 160', () => eq(planOrderQuantity(121, STANDARD).rounded, 160))
ok('TC-A05', 'need=200 → 补到 160', () => eq(planOrderQuantity(200, STANDARD).rounded, 160))
ok('TC-A06', 'need=201 → 每缸240，1缸', () => {
  const r = planOrderQuantity(201, STANDARD); eq(r.rounded, 240); eq(r.vatCount, 1); eq(r.kgPerVat, 240)
})
ok('TC-A07', 'need=300 余量60<半缸 → 舍弃，240', () => eq(planOrderQuantity(300, STANDARD).rounded, 240))
ok('TC-A08', 'need=360 余量120=半缸 → 补1缸，480', () => {
  const r = planOrderQuantity(360, STANDARD); eq(r.rounded, 480); eq(r.vatCount, 2)
})
ok('TC-A09', 'need=500 余量20 → 舍弃，480', () => eq(planOrderQuantity(500, STANDARD).rounded, 480))
ok('TC-A10', 'need=3371 → 3360（14缸×240，余11舍弃）', () => {
  const r = planOrderQuantity(3371, STANDARD); eq(r.rounded, 3360); eq(r.vatCount, 14)
})
ok('TC-A11', 'need=0 → skip，0公斤', () => {
  const r = planOrderQuantity(0, STANDARD); eq(r.rounded, 0); eq(r.action, 'skip')
})
ok('TC-A12', 'need 为负数按 0 处理 → skip', () => eq(planOrderQuantity(-50, STANDARD).rounded, 0))

// 自定义规则覆盖各 action
const vat100 = normalizeVatRule({ id: 'v', name: '每缸100', bandKey: 'planned', remainder: 'nearest', bands: [{ upTo: null, action: 'vat', value: 100 }] })
ok('TC-A13', 'vat 动作 每缸100 need=250 就近→300（3缸）', () => {
  const r = planOrderQuantity(250, vat100); eq(r.action, 'vat'); eq(r.rounded, 300); eq(r.vatCount, 3)
})
ok('TC-A14', 'vat 动作 remainder=floor need=250 → 200（2缸）', () => {
  const rule = normalizeVatRule({ ...vat100, remainder: 'floor' }); eq(planOrderQuantity(250, rule).rounded, 200)
})
ok('TC-A15', 'vat 动作 remainder=ceil need=210 → 300（3缸）', () => {
  const rule = normalizeVatRule({ ...vat100, remainder: 'ceil' }); eq(planOrderQuantity(210, rule).rounded, 300)
})
ok('TC-A16', 'round 动作 整百 need=155 → 200', () => {
  const rule = normalizeVatRule({ id: 'r', name: '整百', bands: [{ upTo: null, action: 'round', value: 100 }] })
  eq(planOrderQuantity(155, rule).rounded, 200)
})
ok('TC-A17', 'skip 档 need≤50 → 0（小批量默认）', () => eq(planOrderQuantity(40, SMALL).rounded, 0))
ok('TC-A18', '多缸型 ladder 就近：80/160/240 need=100 → 80', () => {
  const rule = normalizeVatRule({ id: 'L', name: '多缸', bands: [{ upTo: null, action: 'ladder', value: 0, sizes: [80, 160, 240] }] })
  eq(planOrderQuantity(100, rule).rounded, 80)
})
ok('TC-A19', '多缸型 ladder 正好一半取大：need=120 → 160', () => {
  const rule = normalizeVatRule({ id: 'L', name: '多缸', bands: [{ upTo: null, action: 'ladder', value: 0, sizes: [80, 160, 240] }] })
  eq(planOrderQuantity(120, rule).rounded, 160)
})
ok('TC-A20', '无缸型 ladder → 原量下单 + 警告', () => {
  const rule = normalizeVatRule({ id: 'x', name: '空缸', bands: [{ upTo: null, action: 'ladder', value: 0, sizes: [] }] })
  const r = planOrderQuantity(300, rule); eq(r.rounded, 300); ok('warn', '', () => { if (!r.warnings.length) throw new Error('无警告') })
})

// ===== B. 下多少 —— 规则解析与继承（vat.js）=====
const SETTINGS = {
  vatRules: [STANDARD, SMALL],
  defaultVatRuleId: 'vr-standard',
  spuVatRules: { '品名A': 'vr-small' },
  skuVatRules: { 'SKU-1': 'vr-small', 'SKU-NONE': VAT_RULE_NONE },
}
ok('TC-B01', 'SKU 级绑定优先于 SPU', () => eq(resolveVatRule(SETTINGS, { skuId: 'SKU-1', product: '品名A' }).id, 'vr-small'))
ok('TC-B02', 'SPU 级绑定优先于默认', () => eq(resolveVatRule(SETTINGS, { skuId: 'SKU-X', product: '品名A' }).id, 'vr-small'))
ok('TC-B03', '未绑定用默认规则', () => eq(resolveVatRule(SETTINGS, { skuId: 'SKU-X', product: '品名Z' }).id, 'vr-standard'))
ok('TC-B04', '显式 __none__ → 不取整（null）', () => eq(resolveVatRule(SETTINGS, { skuId: 'SKU-NONE', product: '品名A' }), null))
ok('TC-B05', '无规则时回落到第一条', () => eq(resolveVatRule({ vatRules: [STANDARD] }, { skuId: 'x' }).id, 'vr-standard'))
ok('TC-B06', 'resolveVatBand 边界 120→档0，121→档1', () => {
  eq(resolveVatBand(STANDARD, { planned: 120 }).index, 0)
  eq(resolveVatBand(STANDARD, { planned: 121 }).index, 1)
})
ok('TC-B07', '下拉候选只列单缸重量 80/160/240', () => eq(vatQuantityOptions(STANDARD).map(o => o.quantity), [80, 160, 240]))
ok('TC-B08', 'normalizeVatSizes 去重升序去非正数', () => eq(normalizeVatSizes([240, 80, 0, 160, 80, -5]), [80, 160, 240]))
ok('TC-B09', '校验：末档必须无上限', () => {
  const e = validateVatRule({ name: 'X', bands: [{ upTo: 100, action: 'fixed', value: 80 }] })
  ok('chk', '', () => { if (!e.some(x => x.message.includes('最后一档必须无上限'))) throw new Error('未拦截') })
})
ok('TC-B10', '校验：区间上限必须递增', () => {
  const e = validateVatRule({ name: 'X', bands: [
    { upTo: 100, action: 'fixed', value: 80 },
    { upTo: 90, action: 'fixed', value: 160 },
    { upTo: null, action: 'fixed', value: 240 },
  ] })
  ok('chk', '', () => { if (!e.some(x => x.message.includes('上限必须大于上一档'))) throw new Error('未拦截') })
})
ok('TC-B11', '校验：ladder 必须有缸型', () => {
  const e = validateVatRule({ name: 'X', bands: [{ upTo: null, action: 'ladder', value: 0, sizes: [] }] })
  ok('chk', '', () => { if (!e.some(x => x.message.includes('至少填写一种缸型'))) throw new Error('未拦截') })
})

// ===== C. 给谁下单 —— 染厂/人员/分类（resolve.js）=====
const SET = {
  dyeFactories: [
    { id: 'f1', name: '染厂一', enabled: true },
    { id: 'f2', name: '染厂二', enabled: true },
    { id: 'f3', name: '染厂三', enabled: false },
  ],
  skuFactories: { 'S1': ['f1', 'f3'], 'S2': ['f3'] },
  assignees: ['张三', '李四', '王五'],
  treeCategories: [
    { name: '分类A', assignees: ['张三', '李四'] },
    { name: '分类B', assignees: [] },
  ],
  skuCategoryOverrides: { 'S1': '分类A' },
}
ok('TC-C01', '启用染厂过滤掉停用项', () => eq(enabledFactories(SET).map(f => f.id), ['f1', 'f2']))
ok('TC-C02', 'SKU 配了染厂→只列启用中的', () => eq(factoriesForSku(SET, 'S1').map(f => f.id), ['f1']))
ok('TC-C03', 'SKU 配的染厂都被停用→回退全部启用', () => eq(factoriesForSku(SET, 'S2').map(f => f.id), ['f1', 'f2']))
ok('TC-C04', 'SKU 未配染厂→回退全部启用', () => eq(factoriesForSku(SET, 'S9').map(f => f.id), ['f1', 'f2']))
ok('TC-C05', '分类覆盖优先于导入分类', () => eq(categoryForSku(SET, 'S1', '导入分类'), '分类A'))
ok('TC-C06', '无覆盖用导入分类', () => eq(categoryForSku(SET, 'S9', '导入分类'), '导入分类'))
ok('TC-C07', '分类有人员→只列分类人员', () => eq(assigneesForSku(SET, 'S1', '任意'), ['张三', '李四']))
ok('TC-C08', '分类无人员→回退全部人员', () => eq(assigneesForSku(SET, 'S9', '分类B'), ['张三', '李四', '王五']))
ok('TC-C09', '按 id 找染厂', () => eq(findFactoryById(SET, 'f2').name, '染厂二'))
ok('TC-C10', '按名称找染厂', () => eq(findFactoryByName(SET, '染厂三').id, 'f3'))

// ===== D. 订单聚合 —— 累积下单/待收/到货（resolve.js）=====
const ORDERS = [
  { skuId: 'X', status: 'active', quantity: 800, receivedQty: 300, vatCount: 2 },
  { skuId: 'X', status: 'active', quantity: 200, receivedQty: 0, vatCount: 1 },
  { skuId: 'X', status: 'cancelled', quantity: 500, receivedQty: 100, vatCount: 2 },
  { skuId: 'Y', status: 'active', quantity: 100, receivedQty: 100, vatCount: 1 },
]
ok('TC-D01', '作废单不进聚合：X 累积下单=1000', () => eq(orderSummaryOf(buildOrderIndex(ORDERS), 'X').ordered, 1000))
ok('TC-D02', '待收=累积下单−到货=700', () => eq(orderSummaryOf(buildOrderIndex(ORDERS), 'X').pending, 700))
ok('TC-D03', '到货累计=300', () => eq(orderSummaryOf(buildOrderIndex(ORDERS), 'X').received, 300))
ok('TC-D04', '张数=2（作废不计）', () => eq(orderSummaryOf(buildOrderIndex(ORDERS), 'X').count, 2))
ok('TC-D05', '待收下限保护：Y 收齐→pending=0', () => eq(orderSummaryOf(buildOrderIndex(ORDERS), 'Y').pending, 0))
ok('TC-D06', '无订单返回空聚合', () => eq(orderSummaryOf(buildOrderIndex(ORDERS), 'Z').ordered, 0))
ok('TC-D07', 'summarizeOrders 只统计 quantity>0', () => {
  eq(summarizeOrders([{ quantity: 80, vatCount: 1 }, { quantity: 0 }, { quantity: 160, vatCount: 2 }]), { total: 240, counted: 2, vats: 3 })
})

// ===== E. 下单数量颜色口径（fillTone.js）=====
ok('TC-E01', '未下单 filled=0 → idle', () => eq(fillTone(0, 100, 240), 'idle'))
ok('TC-E02', '低于80% → low', () => eq(fillTone(79, 100, 240), 'low'))
ok('TC-E03', '正好80% → ok', () => eq(fillTone(80, 100, 240), 'ok'))
ok('TC-E04', '正好100% → ok', () => eq(fillTone(100, 100, 240), 'ok'))
ok('TC-E05', '超出但一缸以内 → ok', () => eq(fillTone(110, 100, 240), 'ok'))
ok('TC-E06', '超出超过一缸 → err', () => eq(fillTone(341, 100, 240), 'err'))
ok('TC-E07', '无缸型时超出即 err', () => eq(fillTone(101, 100, 0), 'err'))
ok('TC-E08', '需安排为0且有填量 → ok', () => eq(fillTone(50, 0, 240), 'ok'))

// ===== F. 库存计算与建议（inventory.js）=====
const BASE_ITEM = {
  strategyAvailable: true, modeParticipates: true, modeMetric: 'qty', excluded: false,
  kgFactor: 1, warehouseStock: 100, inTransitStock: 0, producing: 0,
  ordered: 800, received: 300, planned: 100,
  stockingCoefficients: { redLine: 100, normal: 1000, peak: 2000 }, dailySales: 0,
}
ok('TC-F01', '预计库存=理论+待收+到货+锁定需安排', () => {
  const r = calculateInventoryRow(BASE_ITEM)
  eq(r.theoreticalStock, 100); eq(r.pendingOrder, 500)
  eq(r.projectedStock, 100 + 500 + 300 + 100)
})
ok('TC-F02', '不变量：累积下单=待收+到货', () => {
  const r = calculateInventoryRow(BASE_ITEM); eq(r.ordered, r.pendingOrder + r.received)
})
ok('TC-F03', '到货不改变预计库存（只挪 received，待收此消彼长）', () => {
  const a = calculateInventoryRow({ ...BASE_ITEM, ordered: 800, received: 300, planned: 100 })
  const b = calculateInventoryRow({ ...BASE_ITEM, ordered: 800, received: 500, planned: 100 })
  eq(a.projectedStock, 1000); eq(b.projectedStock, 1000)
  near(b.projectedStock - a.projectedStock, 0)
})
ok('TC-F04', '建议需安排=max(0,ceil(正常−理论−累积下单))', () => {
  eq(getSuggestedPlanned({ strategyAvailable: true, normalStock: 1000, theoreticalStock: 500, ordered: 200 }), 300)
})
ok('TC-F05', '累积下单已覆盖缺口→建议=0', () => {
  eq(getSuggestedPlanned({ strategyAvailable: true, normalStock: 1000, theoreticalStock: 500, ordered: 600 }), 0)
})
ok('TC-F06', '不参与备货→建议=0', () => {
  eq(getSuggestedPlanned({ strategyAvailable: false, normalStock: 1000, theoreticalStock: 100, ordered: 0 }), 0)
})

// ===== G. 数据归一化与迁移（validate.js）=====
ok('TC-G01', 'receivedQty 由 receipts 派生，不信任外部值', () => {
  const doc = normalizeOrders({ version: 2, orders: [
    { skuId: 'X', quantity: 800, receivedQty: 999, receipts: [{ qty: 300 }, { qty: 100, voidedAt: 't' }] },
  ] })
  eq(doc.orders[0].receivedQty, 300)
})
ok('TC-G02', '空白订单行被丢弃', () => {
  const doc = normalizeOrders({ orders: [{ skuId: 'X', quantity: 0, factoryId: '', note: '' }] })
  eq(doc.orders.length, 0)
})
ok('TC-G03', '运行态保留空白草稿行', () => {
  const doc = normalizeOrders({ drafts: { X: [{ quantity: 0 }] } }, { keepBlankEntries: true })
  eq(doc.drafts.X.length, 1)
})
ok('TC-G04', 'v1 map 迁移为 active 流水', () => {
  const doc = normalizeOrders({ orders: { X: [{ factoryName: '染厂一', quantity: 100 }] }, updatedAt: '2026-01-01T00:00:00.000Z' })
  eq(doc.orders[0].status, 'active'); eq(doc.orders[0].skuId, 'X'); ok('batch', '', () => { if (!doc.orders[0].batchId.startsWith('legacy-')) throw new Error('batchId未迁移') })
})
ok('TC-G05', '设置归一化：重复染厂按名去重', () => {
  const s = normalizeSettings({ dyeFactories: [{ name: 'A' }, { name: 'A' }, { name: 'B' }] })
  eq(s.dyeFactories.length, 2)
})
ok('TC-G06', '分类人员必须在总名单内，否则清除', () => {
  const s = normalizeSettings({ assignees: ['张三'], treeCategories: [{ name: 'C', assignees: ['张三', '李四'] }] })
  eq(s.treeCategories[0].assignees, ['张三'])
})
ok('TC-G07', '非法缸规则绑定被丢弃，合法保留', () => {
  const s = normalizeSettings({ vatRules: [STANDARD, SMALL], spuVatRules: { A: 'vr-small', B: '不存在' } })
  eq(s.spuVatRules, { A: 'vr-small' })
})

// ===== H. 下单历史（history.js）=====
const HISTORY_ORDERS = [
  { id: 'o1', batchId: 'b1', skuId: 'X', quantity: 800, receivedQty: 300, status: 'active', submittedAt: '2026-11-01T10:00:00.000Z', receipts: [{ qty: 300 }] },
  { id: 'o2', batchId: 'b1', skuId: 'Y', quantity: 200, receivedQty: 0, status: 'active', submittedAt: '2026-11-01T10:01:00.000Z', receipts: [] },
  { id: 'o3', batchId: 'b1', skuId: 'Z', quantity: 500, receivedQty: 100, status: 'cancelled', submittedAt: '2026-11-01T10:02:00.000Z', receipts: [{ qty: 100 }] },
]
ok('TC-H01', '批次聚合：作废单不进账，下单合计=1000', () => {
  const h = buildOrderHistory(HISTORY_ORDERS); eq(h.batches[0].quantity, 1000)
})
ok('TC-H02', '作废数单独统计=1', () => eq(buildOrderHistory(HISTORY_ORDERS).batches[0].cancelledCount, 1))
ok('TC-H03', '批次号按天顺排 PO-YYYYMMDD-01', () => {
  ok('code', '', () => { if (!/^PO-\d{8}-01$/.test(buildOrderHistory(HISTORY_ORDERS).batches[0].code)) throw new Error('批次号格式错误') })
})
ok('TC-H04', '默认筛选 active：作废行被排除', () => {
  const f = filterHistory(buildOrderHistory(HISTORY_ORDERS), {}); eq(f.batches[0].orderCount, 2)
})
ok('TC-H05', '全部状态：作废行保留但合计不变', () => {
  const f = filterHistory(buildOrderHistory(HISTORY_ORDERS), { status: 'all' })
  eq(f.batches[0].orderCount, 3); eq(f.batches[0].quantity, 1000)
})
ok('TC-H06', '关键词筛选按品名/染厂/备注命中', () => {
  const f = filterHistory(buildOrderHistory(HISTORY_ORDERS), { status: 'all', keyword: 'X' })
  eq(f.batches[0].orderCount, 1)
})

console.log('\n================ TEST SUMMARY ================')
console.log(`TOTAL: ${passed + failed}  PASS: ${passed}  FAIL: ${failed}`)
if (failures.length) {
  console.log('\n失败用例:')
  for (const f of failures) console.log(`  ${f.id} ${f.desc}`)
}
process.exit(failed ? 1 : 0)
