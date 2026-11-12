import { createEvaluator, evaluateItem, findBaselineMonth } from '../src/stocking/engine.js'
import { createDefaultConfig } from '../src/stocking/defaults.js'
import { validateConfig, normalizeConfig } from '../src/stocking/validate.js'
import { calculateInventoryRow } from '../src/utils/inventory.js'

const config = createDefaultConfig()
console.log('validate:', JSON.stringify(validateConfig(config)))

// 构造 5 档 SKU：月均 0 / 1 / 5 / 15 / 50 条，库存单位分别为码 / 公斤
function make(counts, opts = {}) {
  return {
    skuId: opts.skuId ?? 'S',
    category: opts.category ?? '黑白',
    activeCustomers: opts.activeCustomers ?? 3,
    monthlyAvgCount: opts.monthlyAvg,
    monthCounts: counts,
    unitFactor: opts.unitFactor ?? 100,
    warehouseStock: opts.stock ?? 0,
    inTransitStock: 0,
    producing: 0,
    planned: null,
    turnoverIn: 0,
    weeklyUsage: 0,
  }
}

const rows = [
  make(new Array(12).fill(0), { skuId: 'slow', monthlyAvg: 0, stock: 5000 }),
  make([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30], { skuId: 'tail', monthlyAvg: 1, stock: 1000 }),
  make(new Array(12).fill(5), { skuId: 'bulk', monthlyAvg: 5, stock: 12000 }),
  make(new Array(12).fill(15), { skuId: 'normal', monthlyAvg: 15, stock: 20000 }),
  make(new Array(12).fill(50), { skuId: 'hot', monthlyAvg: 50, stock: 30000 }),
  make(new Array(12).fill(50), {
    skuId: 'hot-exclusive',
    monthlyAvg: 50,
    stock: 30000,
    activeCustomers: 1,
  }),
  make(new Array(12).fill(50), { skuId: 'no-factor', monthlyAvg: 50, stock: 30000, unitFactor: 0 }),
  make(new Array(12).fill(4), { skuId: 'kg-bulk', monthlyAvg: 4, stock: 1600, unitFactor: 20 }),
]

const baselineMonth = findBaselineMonth(rows)
const evaluator = createEvaluator(config, { baselineMonth })
console.log('baselineMonth =', baselineMonth)

// 手动策略：自定系数模式按「条」比较；排除模式不参与计算。
const manualRow = make(new Array(12).fill(10), { skuId: 'manual', monthlyAvg: 10, stock: 5000 })
const manualEvaluator = createEvaluator(config, {
  baselineMonth,
  manualOverrides: new Map([
    ['manual', { modeId: 'manual-custom', coefficients: { redLine: 30, normal: 60, peak: 90 } }],
    ['tail', { modeId: 'manual-exclude' }],
  ]),
})
const manualRowEval = evaluateItem({ ...manualRow, ...rows[1], skuId: 'manual' }, manualEvaluator)
const manualCalc = calculateInventoryRow(manualRowEval)
console.log(
  'manual custom ->',
  manualRowEval.modeLabel,
  '条=',
  Number(manualCalc.projectedUnits).toFixed(2),
  '红/正/峰=',
  [manualCalc.redLineStock, manualCalc.normalStock, manualCalc.peakStock].join('/'),
  '灯=',
  manualCalc.urgencyText,
)
const excludeManual = evaluateItem({ ...rows[2], skuId: 'tail' }, manualEvaluator)
console.log('manual exclude ->', excludeManual.modeLabel, '参与=', excludeManual.modeParticipates)

for (const row of rows) {
  const evaluated = evaluateItem(row, evaluator)
  const calculated = calculateInventoryRow(evaluated)
  console.log(
    [
      row.skuId.padEnd(14),
      `模式=${evaluated.modeLabel.padEnd(12)}`,
      `月销量=${Number(evaluated.monthlySales).toFixed(2)}`,
      `日销量=${Number(evaluated.dailySales).toFixed(3)}`,
      `库存条=${Number(calculated.projectedUnits).toFixed(2)}`,
      `日库销比=${Number.isFinite(calculated.daysOfStock) ? calculated.daysOfStock.toFixed(1) : '∞'}`,
      `红/正/峰=${[calculated.redLineStock, calculated.normalStock, calculated.peakStock].map((v) => (v === null ? '—' : Number(v).toFixed(0))).join('/')}`,
      `灯=${calculated.urgencyText}`,
      `问题=${calculated.strategyIssue || '-'}`,
    ].join('  '),
  )
}

// 手动策略：自定系数模式按「条」比较；排除模式不参与计算。