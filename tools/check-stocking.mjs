// 备货口径自检：直接读 src/stocking/config.json 里当前启用的方案，
// 用固定的样例 SKU 跑一遍「模式判定 → 加权月销量 → 三档库存 → 预警灯 → 建议需安排」，
// 逐项与手算值比对；任何一项不符就以非零码退出，改完口径可以一键回归。
//
// 用法：node tools/check-stocking.mjs
//
// 样例的库存一律按「公斤」给：码单位用 kgFactor = 1 / 出码率 换算（与清洗口径一致）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createEvaluator,
  evaluateItem,
  findBaselineMonth,
  weightedMonthlySales,
} from '../src/stocking/engine.js'
import { getActiveProfile, normalizeProfileFile, validateConfig } from '../src/stocking/validate.js'
import { calculateInventoryRow, getSuggestedPlanned } from '../src/utils/inventory.js'

const CONFIG_PATH = fileURLToPath(new URL('../src/stocking/config.json', import.meta.url))

const failures = []
function record(ok, message) {
  if (!ok) failures.push(message)
  return ok
}

// 浮点比较：公斤 / 天数一律留 0.01 的容差。
function near(label, actual, expected, tolerance = 0.01) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
  return record(ok, `${label}：期望 ${expected}，实际 ${actual}`)
}

function same(label, actual, expected) {
  return record(actual === expected, `${label}：期望 ${expected}，实际 ${actual}`)
}

// 演示行：12 个月销量都等于 monthlyKg；动销月份按是否有销量给。
function makeSku({
  skuId,
  monthlyAvg,
  monthlyKg,
  category = '黑白',
  kgFactor = 1,
  stock = 0,
  customers = 3,
}) {
  return {
    skuId,
    product: `${skuId}品名`,
    color: `${skuId}色`,
    category,
    treeCategory: '',
    monthlyAvgCount: monthlyAvg,
    monthSales: new Array(12).fill(monthlyKg),
    monthCounts: new Array(12).fill(0),
    activeMonths: monthlyAvg > 0 ? 12 : 0,
    activeCustomers: customers,
    cumulativeCount: 0,
    cumulativeSales: monthlyAvg * 12,
    totalOrders: 0,
    kgFactor,
    warehouseStock: stock,
    producing: 0,
    turnoverIn: 0,
    totalOutbound: 0,
    planned: null,
  }
}

// —— 配置 ——
const profileFile = normalizeProfileFile(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
const activeProfile = getActiveProfile(profileFile)
const config = activeProfile.config

console.log(`配置方案：${activeProfile.name}（${activeProfile.id}）`)
const validation = validateConfig(config)
console.log(
  `校验：ok=${validation.ok}，errors=${validation.errors.length}，warnings=${validation.warnings.length}`,
)
record(
  validation.ok,
  `配置校验未通过：${validation.errors.map((error) => error.message).join('；')}`,
)
for (const warning of validation.warnings) console.log(`  ⚠ ${warning.message}`)

console.log('\n模式（顺序即判定优先级）')
const modes = config.strategies?.[0]?.modes ?? []
for (const mode of modes) {
  const range =
    mode.range.from === null && mode.range.to === null
      ? '不限'
      : `${mode.range.from ?? '-∞'} ~ ${mode.range.to ?? '+∞'}`
  const comparison = mode.participates
    ? mode.metric === 'days'
      ? '按日库销比（天）'
      : '按公斤库存'
    : '不参与'
  console.log(`  ${String(mode.name).padEnd(4)} 月均 ${range.padEnd(14)} ${comparison}`)
}

const weights = config.salesWindow?.weights ?? []
console.log(
  `\n销量权重：${weights
    .map((entry) => `近 ${entry.months} 个月 ${Math.round(entry.weight * 100)}%`)
    .join(' + ')}`,
)

// —— 加权月销量：缺失月份按 0（样例里只有最后一个月有 30 公斤）——
{
  const counts = new Array(12).fill(0)
  counts[11] = 30
  const monthlyMean = (months) => {
    let sum = 0
    for (let offset = 0; offset < months; offset += 1) sum += counts[11 - offset] ?? 0
    return sum / months
  }
  const expected = weights.reduce(
    (sum, entry) => sum + entry.weight * monthlyMean(entry.months),
    0,
  )
  near('加权月销量（基准月缺省 → 最后一个有销量的月）', weightedMonthlySales(counts, null, weights), expected)
}

// —— 样例 SKU ——
// 码单位：出码率 24 → kgFactor = 1/24；1440 码 = 60 公斤。
const hotCode = makeSku({ skuId: 'hot-code', monthlyAvg: 50, monthlyKg: 50, kgFactor: 1 / 24, stock: 1440 })
const normalKg = makeSku({ skuId: 'normal-kg', monthlyAvg: 15, monthlyKg: 15, stock: 10 })
// 同一形态、库存不同：用来锁住「绿区上沿 = 峰值」的两侧（40 天在绿、50 天超峰）。
const normalOverKg = makeSku({ skuId: 'normal-over', monthlyAvg: 15, monthlyKg: 15, stock: 20 })
const normalPeakKg = makeSku({ skuId: 'normal-peak', monthlyAvg: 15, monthlyKg: 15, stock: 25 })
const bulkKg = makeSku({ skuId: 'bulk-kg', monthlyAvg: 5, monthlyKg: 5, stock: 50 })
const tailKg = makeSku({ skuId: 'tail-kg', monthlyAvg: 1, monthlyKg: 1, stock: 20 })
const slowKg = makeSku({ skuId: 'slow-kg', monthlyAvg: 0, monthlyKg: 0, stock: 0 })
const exclusiveKg = makeSku({
  skuId: 'hot-exclusive',
  monthlyAvg: 50,
  monthlyKg: 50,
  stock: 60,
  customers: 1,
})
const noFactorKg = makeSku({
  skuId: 'no-kg-factor',
  monthlyAvg: 50,
  monthlyKg: 50,
  kgFactor: null,
  stock: 3000,
})
const manualCustomKg = makeSku({ skuId: 'manual-custom', monthlyAvg: 15, monthlyKg: 15, stock: 50 })
const manualOrderKg = makeSku({ skuId: 'manual-order', monthlyAvg: 15, monthlyKg: 15, stock: 50 })

const allSkus = [hotCode, normalKg, bulkKg, tailKg, slowKg, exclusiveKg, noFactorKg]
const baselineMonth = findBaselineMonth(allSkus)
same('基准月（最后一个有销量的月份）', baselineMonth, 12)

const evaluator = createEvaluator(config, { baselineMonth })

// 期望值按「当前启用的方案」手算；改模式区间 / 系数后这里的数字要一起更新，
// 这正是自检要拦住的漂移：口径变了，预期却没跟着改就会被判失败。
const cases = [
  {
    label: '热销·码单位',
    sku: hotCode,
    modeKey: 'hot',
    tone: 'green',
    urgencyText: '无需补货',
    daysOfStock: 36,
    redLineStock: 33.33,
    normalStock: 66.67,
    peakStock: 100,
    suggested: 7,
  },
  {
    label: '常规·公斤',
    sku: normalKg,
    modeKey: 'normal',
    tone: 'yellow',
    urgencyText: '常规补货',
    daysOfStock: 20,
    redLineStock: 7.5,
    normalStock: 15,
    peakStock: 22.5,
    suggested: 5,
  },
  {
    // 绿区上沿是峰值：日库销比 40 天已超「正常 × 120%」（36 天）但没到峰值 45 天 ——
    // 这是加需安排后最容易踩的右段，必须保持「无需补货」，不能退回黄的「常规补货」。
    label: '常规·偏多',
    sku: normalOverKg,
    modeKey: 'normal',
    tone: 'green',
    urgencyText: '无需补货',
    daysOfStock: 40,
    redLineStock: 7.5,
    normalStock: 15,
    peakStock: 22.5,
    suggested: 0,
  },
  {
    label: '常规·超峰',
    sku: normalPeakKg,
    modeKey: 'normal',
    tone: 'purple',
    urgencyText: '降低库存',
    daysOfStock: 50,
    redLineStock: 7.5,
    normalStock: 15,
    peakStock: 22.5,
    suggested: 0,
  },
  {
    label: '按量·公斤',
    sku: bulkKg,
    modeKey: 'bulk',
    tone: 'yellow',
    urgencyText: '常规补货',
    daysOfStock: 50,
    redLineStock: 40,
    normalStock: 80,
    peakStock: 200,
    suggested: 30,
  },
  {
    label: '尾货',
    sku: tailKg,
    modeKey: 'tail',
    tone: 'unavailable',
    urgencyText: '不参与',
    participates: false,
    suggested: 0,
  },
  {
    label: '滞销',
    sku: slowKg,
    modeKey: 'slow',
    tone: 'unavailable',
    urgencyText: '不参与',
    participates: false,
    suggested: 0,
  },
  {
    label: '专属品',
    sku: exclusiveKg,
    modeKey: 'hot',
    tone: 'unavailable',
    urgencyText: '不参与',
    participates: false,
    excluded: true,
    suggested: 0,
  },
  {
    label: '缺出码率',
    sku: noFactorKg,
    modeKey: 'hot',
    tone: 'unavailable',
    urgencyText: '模式缺省',
    strategyIssueShort: '缺出码率',
    suggested: 0,
  },
]

console.log('\n样例评估')
console.log(
  '样例'.padEnd(12) +
    '模式'.padEnd(10) +
    '日销量'.padStart(8) +
    '日库销比'.padStart(10) +
    '红/正/峰'.padStart(18) +
    '灯'.padStart(8) +
    '建议'.padStart(8),
)

const printKg = (value) => (value === null || !Number.isFinite(value) ? '—' : Number(value).toFixed(0))

for (const testCase of cases) {
  const evaluated = evaluateItem(testCase.sku, evaluator)
  const row = calculateInventoryRow(evaluated)
  const name = testCase.label

  console.log(
    name.padEnd(12) +
      String(evaluated.modeLabel).padEnd(10) +
      Number(row.dailySales ?? 0).toFixed(2).padStart(8) +
      (Number.isFinite(row.daysOfStock) ? Number(row.daysOfStock).toFixed(0) : '∞').padStart(10) +
      `${printKg(row.redLineStock)}/${printKg(row.normalStock)}/${printKg(row.peakStock)}`.padStart(18) +
      String(row.urgencyText).padStart(8) +
      String(getSuggestedPlanned(row)).padStart(8),
  )

  same(`${name} · 模式`, evaluated.modeKey, testCase.modeKey)
  same(`${name} · 预警灯`, row.urgencyTone, testCase.tone)
  same(`${name} · 预警文案`, row.urgencyText, testCase.urgencyText)
  if (testCase.participates !== undefined) {
    same(`${name} · 参与计算`, evaluated.modeParticipates, testCase.participates)
  }
  if (testCase.excluded !== undefined) same(`${name} · 默认排除`, row.excluded, testCase.excluded)
  if (testCase.strategyIssueShort !== undefined) {
    same(`${name} · 缺省原因`, row.strategyIssueShort, testCase.strategyIssueShort)
  }
  if (testCase.daysOfStock !== undefined) {
    near(`${name} · 日库销比`, row.daysOfStock, testCase.daysOfStock)
  }
  if (testCase.redLineStock !== undefined) {
    near(`${name} · 红线库存`, row.redLineStock, testCase.redLineStock)
  }
  if (testCase.normalStock !== undefined) {
    near(`${name} · 正常库存`, row.normalStock, testCase.normalStock)
  }
  if (testCase.peakStock !== undefined) {
    near(`${name} · 峰值库存`, row.peakStock, testCase.peakStock)
  }
  near(`${name} · 建议需安排`, getSuggestedPlanned(row), testCase.suggested)
}

// —— 手动策略：自定系数按公斤比库存；订单货完全不参与 ——
const manualEvaluator = createEvaluator(config, {
  baselineMonth,
  manualOverrides: new Map([
    [
      'manual-custom',
      { modeId: 'manual-custom', coefficients: { redLine: 30, normal: 60, peak: 90 } },
    ],
    ['manual-order', { modeId: 'manual-order' }],
  ]),
})

console.log('\n手动策略')
{
  const evaluated = evaluateItem(manualCustomKg, manualEvaluator)
  const row = calculateInventoryRow(evaluated)
  console.log(
    `  ${evaluated.modeLabel}：库存 ${row.projectedStock} 公斤，红/正/峰 ${row.redLineStock}/${row.normalStock}/${row.peakStock}，灯=${row.urgencyText}，建议=${getSuggestedPlanned(row)}`,
  )
  same('自定系数 · 策略', evaluated.strategy, 'manual')
  same('自定系数 · 比较方式', evaluated.modeMetric, 'stock')
  near('自定系数 · 正常库存', row.normalStock, 60)
  same('自定系数 · 预警灯', row.urgencyTone, 'green')
  near('自定系数 · 建议需安排', getSuggestedPlanned(row), 10)
}
{
  const evaluated = evaluateItem(manualOrderKg, manualEvaluator)
  const row = calculateInventoryRow(evaluated)
  console.log(`  ${evaluated.modeLabel}：灯=${row.urgencyText}，建议=${getSuggestedPlanned(row)}`)
  same('订单货 · 参与计算', evaluated.modeParticipates, false)
  same('订单货 · 行为', evaluated.manualBehavior, 'order')
  same('订单货 · 预警灯', row.urgencyTone, 'unavailable')
  same('订单货 · 建议需安排', getSuggestedPlanned(row), 0)
}

// —— 汇总 ——
if (failures.length) {
  console.error(`\n✗ 自检未通过（${failures.length} 项）：`)
  for (const failure of failures) console.error(`  · ${failure}`)
  process.exitCode = 1
} else {
  console.log('\n✓ 自检全部通过')
}
