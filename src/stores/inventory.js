import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { initialInventoryItems } from '@/data/inventoryItems'
import { applyPlanLayer } from '@/data/serialize'
import { HEAT_FACTOR_FIELDS } from '@/data/quantityFields'
import { findBaselineMonth } from '@/stocking'

// 演示数据只有基础数量列（周销量与库存 / 欠货 / 周转入）：唯一标识、动销指标、累积条数 /
// 累积销量、客户CR5率、树形分类、1-12 月条数与销量都按周销量折算一组稳定数值，
// 让模式判定、评分、销售表与 SKU 弹窗在未导入 Excel 时也能像导入数据一样使用；导入后一律以 Excel 为准。
// 演示数据按「公斤」计量（公斤系数 = 1），销量与条数同值，且只落在最近 N 个动销月份。
// 周销量按「周消耗 = 月均条数 ÷ 4」折算，月均条数覆盖 5 个模式：热销 / 常规 / 按量 / 尾货 / 滞销。
// 演示数据只到 11 月（当前数据月）：12 月还没有发生，销售表与弹窗都不出 12 月的数据。
const DEMO_LAST_MONTH = 11
const DEMO_MONTHS = Array.from({ length: DEMO_LAST_MONTH }, (_, index) => index + 1)
const DEMO_METRIC_FIELDS = HEAT_FACTOR_FIELDS.map(({ field }) => field)

// 演示 SKU 的树形分类：与下单设置里的分类同名，采购下单按它取分单人员；
// 设置里没有同名分类时，下单页会回退到「分单人员表」的全部人员。
const DEMO_TREE_CATEGORIES = {
  挪威网: '小良-厚布类（厚布、大网、提花）',
  芭莎网: '小良-厚布类（厚布、大网、提花）',
  小BK: '小良-厚布类（厚布、大网、提花）',
  '40D涤安': '小凤-薄布类',
  '40D锦安': '小凤-薄布类',
  涤复丝瑞士网: '小凤-薄布类',
}

// 1-12 月的季节权重（合计 12）：弹窗折线图有起伏，加权月销量仍围绕月均条数。
const DEMO_SEASON_PATTERN = [0.82, 0.9, 0.95, 1, 1.06, 1.12, 1.08, 1.02, 0.96, 0.92, 1.05, 1.12]

function roundBy(value, digits = 0) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// 动销月份按月均条数量级给：卖得越少动销越短，滞销没有动销月份（与清洗口径一致）。
// 上限是 11 个月 —— 12 月还没有数据，不能算进动销月份。
function demoActiveMonths(monthlyAvg, id) {
  if (monthlyAvg >= 30) return DEMO_LAST_MONTH
  if (monthlyAvg >= 10) return id % 3 === 0 ? 9 : DEMO_LAST_MONTH
  if (monthlyAvg >= 3) return 9
  if (monthlyAvg > 0) return id % 2 === 0 ? 6 : DEMO_LAST_MONTH
  return 0
}

// 把总数按「最近 N 个月的季节权重」拆成整数，最大余数法保证合计不丢数；
// 12 月整列留空（还没有数据），没有动销的 SKU 其余月份记 0。
function demoMonthlySeries(total, activeMonths) {
  const series = new Array(12).fill(0)
  series[DEMO_LAST_MONTH] = null
  if (!(activeMonths > 0) || !(total > 0)) return series

  const parts = []
  for (let offset = 0; offset < Math.min(activeMonths, DEMO_LAST_MONTH); offset += 1) {
    const index = DEMO_LAST_MONTH - 1 - offset
    parts.push({ index, weight: DEMO_SEASON_PATTERN[index] })
  }
  const weightSum = parts.reduce((sum, part) => sum + part.weight, 0)
  const shares = parts.map((part) => {
    const exact = (total * part.weight) / weightSum
    const value = Math.floor(exact)
    return { index: part.index, value, remainder: exact - value }
  })

  let assigned = shares.reduce((sum, share) => sum + share.value, 0)
  shares.sort((first, second) => second.remainder - first.remainder)
  for (let index = 0; assigned < total; index = (index + 1) % shares.length) {
    shares[index].value += 1
    assigned += 1
  }
  for (const share of shares) series[share.index] += share.value
  return series
}

// 累计客户按月均条数量级给：卖得越少客户越少；少量 SKU 记 1 个客户，用来演示「专属品」。
function demoCustomers(monthlyAvg, id) {
  if (!(monthlyAvg > 0)) return 0
  if (id % 13 === 0) return 1
  if (monthlyAvg >= 30) return 8 + ((id * 3) % 17)
  if (monthlyAvg >= 10) return 4 + ((id * 5) % 9)
  if (monthlyAvg >= 3) return 2 + ((id * 3) % 7)
  return 1 + (id % 3)
}

// 客户CR5率（0~1）：累计客户 ≤ 5 时前 5 名就是全部客户（100%）；客户越分散占比越低，
// 取值落在 25%~84%，让评分里的 CR5 维度在演示数据上也有高 / 中 / 低三档。
function demoCustomerCr5(id, activeCustomers) {
  if (!(activeCustomers > 0)) return null
  if (activeCustomers <= 5) return 1
  return (25 + ((id * 37) % 60)) / 100
}

function withDemoSourceFields(item) {
  // 周消耗 × 4 周 = 月均条数（与清洗口径「周消耗 = 月均条数 ÷ 4」一致）。
  const monthlyAvg = item.monthlyAvgCount ?? item.weeklyUsage * 4
  const activeMonths = item.activeMonths ?? demoActiveMonths(monthlyAvg, item.id)
  const cumulativeCount =
    item.cumulativeCount ?? (activeMonths > 0 ? Math.round(monthlyAvg * activeMonths) : 0)
  const monthlyAvgCount =
    item.monthlyAvgCount ?? (activeMonths > 0 ? roundBy(cumulativeCount / activeMonths, 2) : 0)
  const monthlyCounts = item.monthCounts ?? demoMonthlySeries(cumulativeCount, activeMonths)
  const activeCustomers = item.activeCustomers ?? demoCustomers(monthlyAvg, item.id)
  return {
    ...item,
    skuId: item.skuId ?? `DEMO-${String(item.id).padStart(3, '0')}`,
    treeCategory: item.treeCategory ?? DEMO_TREE_CATEGORIES[item.product] ?? '',
    totalOutbound: item.totalOutbound ?? 0,
    monthlyAvgCount,
    // 订单总数按「一张单大约 6 条」估：与条数同量级，不再出现上万单。
    totalOrders:
      item.totalOrders ?? (cumulativeCount > 0 ? Math.max(1, Math.round(cumulativeCount / 6)) : 0),
    activeMonths,
    activeCustomers,
    cumulativeCount,
    kgFactor: item.kgFactor ?? 1,
    weeklySales: item.weeklySales ?? item.weeklyUsage,
    monthSales: item.monthSales ?? [...monthlyCounts],
    monthCounts: monthlyCounts,
    // 累积销量（公斤）：公斤系数为 1，销量与条数同值，等于 1-12 月的合计。
    cumulativeSales: item.cumulativeSales ?? cumulativeCount,
  }
}

// 演示销售表与「导入销售表」写进 store 的形状一致：销售表页的 1-12 月条数 / 销量 / 订单数、
// SKU 弹窗折线图与健康度评分里的 CR5、进销比都从这里取数。
function createDemoSalesSheet(items) {
  const bySku = new Map()
  for (const item of items) {
    bySku.set(item.skuId, {
      counts: [...item.monthCounts],
      sales: [...item.monthSales],
      orders: demoMonthlySeries(item.totalOrders, item.activeMonths),
      metrics: Object.fromEntries(DEMO_METRIC_FIELDS.map((field) => [field, item[field] ?? null])),
      cr5: demoCustomerCr5(item.id, item.activeCustomers),
      cumulativeSales: item.cumulativeSales ?? null,
    })
  }
  return {
    fileName: '演示数据（模拟）',
    sheetName: '销售表',
    months: [...DEMO_MONTHS],
    metricFields: [...DEMO_METRIC_FIELDS],
    baselineMonth: findBaselineMonth(items),
    bySku,
  }
}

// 启动时由 bootstrap 放进来的快照（事实层）与计划层；没有就用演示种子数据。
let primedState = null
export function primeInventoryState(state) {
  primedState = state ?? null
}

function createInventoryState() {
  const primed = primedState
  primedState = null

  const primedItems = primed?.inventoryItems ?? null
  const baseItems = primedItems ?? initialInventoryItems.map(withDemoSourceFields)
  // 需安排 / 采购清单 / 撤销快照按 skuId 挂回行上：行 id 会随导入重排，不能用 id 存。
  const plan = primed?.planLayer
    ? applyPlanLayer(baseItems, primed.planLayer)
    : { purchaseList: [], plannedUndoHistory: {} }

  const inventoryItems = ref(baseItems)
  const purchaseList = ref(plan.purchaseList)
  const plannedUndoHistory = ref(plan.plannedUndoHistory)
  // 销售表：在“销售表”面板导入的 1-12 月条数与重量，按唯一标识叠加到主面板行上。
  // 数据可达数万 SKU，用 shallowRef 保存整体替换的对象，不做逐行深度响应式。
  // 只有演示数据（没有导入过快照，可能只挂回了需安排）才现生成一份，
  // 让销售表页、SKU 弹窗与评分在未导入 Excel 时也能取到数。
  const salesSheet = shallowRef(
    primed?.salesSheet ?? (primedItems ? null : createDemoSalesSheet(baseItems)),
  )

  // 模式与系数在视图计算时按当前配置现算，store 只保存导入的原始数据。
  return { inventoryItems, purchaseList, plannedUndoHistory, salesSheet }
}

// 库存、采购清单、撤销记录与销售表都是全局唯一的一份运行状态。
export const useInventoryStore = defineStore('inventory', createInventoryState)
