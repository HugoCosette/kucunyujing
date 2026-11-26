// 表头悬停说明：只回答「这一列怎么算」，不重复行内已可见的提示。
// 主面板口径见 src/utils/inventory.js 与 src/purchase/inTransit.js；
// 销售表口径见 tools/cleaning/engine.mjs（汇总规则见 数据清洗规则.md 第 5 节）。
//
// 维护约定：
// - 列 key 是本模块的索引：增删列、改列名都不必改这里（标题直接取列上的 label），
//   只有列的「算法」变了才需要改文案；新增列漏写文案时表头照常显示，开发态会 console.warn。
// - 模式区间、评分维度权重、总分区、SPU 档位、按量健康度阈值都从当前方案配置实时生成，
//   设置页改完立刻跟着变，不写死数字。
// - 每条固定是「单位 + [标签, 说明] 行」，标签统一 2 个字，保证 tooltip 对齐工整。

import {
  SCORING_DIMENSIONS,
  getAutoModes,
  normalizeSpuGrades,
} from '@/stocking'

const IS_DEV = Boolean(import.meta.env?.DEV)

function hint(unit, rows) {
  return { unit, rows }
}

function formatNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? String(Number(number.toFixed(2))) : '不限'
}

// 模式区间：两端都留空 = 不限，只留一端 = 单边区间，否则 A~B（端点口径见 模式与系数设置.md 第 2 节）。
function formatRange(range) {
  const from = Number.isFinite(range?.from) ? Number(range.from) : null
  const to = Number.isFinite(range?.to) ? Number(range.to) : null
  if (from === null && to === null) return '不限'
  if (from === null) return `<${formatNumber(to)}`
  if (to === null) return `≥${formatNumber(from)}`
  return `${formatNumber(from)}~${formatNumber(to)}`
}

function describeModes(modes) {
  if (!modes.length) return '按当前方案的模式区间判定'
  return modes.map((mode) => `${mode.name} ${formatRange(mode.range)}`).join(' · ')
}

function describeScoringDimensions(scoring) {
  const parts = SCORING_DIMENSIONS.map(({ key, label }) => ({
    label,
    weight: Number(scoring?.dimensions?.[key]?.weight),
  }))
    .filter((entry) => Number.isFinite(entry.weight) && entry.weight > 0)
    .map((entry) => `${entry.label} ${formatNumber(entry.weight)}%`)
  return parts.length ? parts.join(' · ') : '按当前评分规则加权'
}

function describeScoringTotal(scoring) {
  const from = Number(scoring?.total?.midFrom)
  const to = Number(scoring?.total?.midTo)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return `>${formatNumber(to)} 低风险（绿） · ${formatNumber(from)}~${formatNumber(
    to,
  )} 中风险（黄） · <${formatNumber(from)} 高风险（红）`
}

function describeBulkScoring(bulkMode) {
  const ratio = bulkMode?.healthScoring?.ratio
  const customers = bulkMode?.healthScoring?.customers
  if (!ratio || !customers) return '按量模式只做 2 项判定、不参与模式一律显示 —'
  return `按量只做 2 项判定（进销比 ${formatNumber(ratio.normalFrom)}~${formatNumber(
    ratio.normalTo,
  )}%、累积客户 ${formatNumber(customers.normalFrom)}~${formatNumber(
    customers.normalTo,
  )} 个），不算综合分；不参与模式一律显示 —`
}

function describeSpuGrades(spuGrades) {
  return normalizeSpuGrades(spuGrades)
    .tiers.map((tier) =>
      Number.isFinite(tier.minMonthlyAvg)
        ? `${tier.label} ≥${formatNumber(tier.minMonthlyAvg)}`
        : `${tier.label} 其余`,
    )
    .join(' · ')
}

// 主面板：模式 / 评分两列的文案按当前方案配置生成，其余列固定。
export function buildInventoryColumnHints(config) {
  const modes = getAutoModes(config)
  const bulkMode = modes.find((mode) => mode.key === 'bulk')
  const participatingModes = modes.filter((mode) => mode.participates !== false)
  const markingModes = modes.filter((mode) => mode.participates === false)
  const ruleRows = [['判定', describeModes(participatingModes)]]
  if (markingModes.length) {
    ruleRows.push(['标注', `${describeModes(markingModes)}，只标注不参与计算`])
  }
  ruleRows.push(
    ['说明', '区间与系数在「设置 → 备货配置」可改；累计客户为 1 记专属品，不参与计算'],
    ['分级', `品名父行按月均条数合计取等级：${describeSpuGrades(config?.spuGrades)}`],
  )
  const scoringRows = [
    ['公式', 'Σ(维度得分 × 权重) ÷ 参与维度权重合计'],
    ['维度', describeScoringDimensions(config?.scoring)],
  ]
  const totalText = describeScoringTotal(config?.scoring)
  if (totalText) scoringRows.push(['档位', totalText])
  scoringRows.push(['说明', describeBulkScoring(bulkMode)])

  return {
    rule: hint('', ruleRows),
    score: hint('分', scoringRows),
    product: hint('', [
      ['父行', '点品名展开 / 收起该品名下的 SKU'],
      ['汇总', '数量列只加总有数据的子行；日库销比按 汇总库存 ÷ 汇总日销量 还原'],
    ]),
    color: hint('', [
      ['关联', '跨导入按「唯一标识 = 品名 | 颜色」关联，不用行号'],
      ['详情', '点行尾方形按钮打开 SKU 详情（模式、评分、采购订单）'],
    ]),
    urgency: hint('', [
      ['指标', '热销 / 常规比日库销比，按量比库存公斤；需安排计入后按预计库存'],
      ['灯色', '红 紧急补货 · 紫 降低库存 · 绿 无需补货 · 黄 常规补货'],
      ['区间', '红 < 红线 · 黄 红线~正常×80% · 绿 正常×80%~峰值 · 紫 > 峰值'],
    ]),
    planned: hint('公斤', [
      ['说明', '人工填写的补货量，采纳后计入预计库存（全表唯一可编辑数量列）'],
      ['建议', 'max(0, ⌈正常库存 − 在仓库存 − 在途库存⌉)，输入框占位即此值'],
      ['缸', '缸取整只在「采购下单」换算，这里始终是精准公斤数'],
    ]),
    inTransitStock: hint('公斤', [
      ['公式', 'min(max(0, 排单累计 − 生产入库累计), 在途库存)'],
      ['来源', '生产排单「进仓重量」；没有对账基线时退回导入的累计进仓重量'],
    ]),
    arranged: hint('公斤', [
      ['公式', '在途库存 − 生产中'],
      ['说明', '已下单但还没排产的部分（订单流水对账得出）'],
    ]),
    ordered: hint('公斤', [
      ['来源', '采购订单流水的累计下单，只算有效单，不来自导入'],
      ['说明', '下过单的留痕：到仓后不清零。到没到仓看「在途库存」，筛选看采购状态组（已下单 / 已到仓）'],
    ]),
    backorder: hint('', [
      ['来源', '欠货订单导出的欠货总数量'],
      ['单位', 'SKU 原单位，只展示，不参与计算'],
    ]),
    weeklySales: hint('公斤/周', [
      ['公式', '月均销量 ÷ 4'],
      ['说明', '清洗阶段已把销量换算成公斤'],
    ]),
    turnoverIn: hint('', [
      ['来源', '导入的周转入数量'],
      ['单位', 'SKU 原单位，只展示，不参与计算'],
    ]),
    inTransitOrdered: hint('公斤', [
      ['公式', 'max(0, max(下单累计, 排单累计) − 生产入库累计)'],
      ['说明', '没有对账值时显示累积下单公斤；行尾图标点开看采购订单（图标转灰 = 已全部到仓）'],
    ]),
    warehouseStock: hint('公斤', [
      ['公式', '库存结存数量 × 公斤系数'],
      ['单位', '码单位：公斤系数 = 1 ÷ 出码率；公斤单位取原值'],
    ]),
    theoreticalStock: hint('公斤', [
      ['公式', '在仓库存 + 在途库存'],
      ['说明', '等于 预计库存 − 需安排；没有对账值时按「在仓 + 生产排单」'],
    ]),
    projectedStock: hint('公斤', [
      ['公式', '理论库存 + 需安排'],
      ['说明', '填需安排时按草稿实时预览，采纳后按锁定值计'],
    ]),
    daysOfStock: hint('天', [
      ['公式', '预计库存 ÷ 日销量'],
      ['说明', '日销量 = 加权月销量 ÷ 30；销量为 0 记 ∞，直接判「降低库存」'],
      ['说明', '按量模式比的是库存公斤，此列显示 --'],
    ]),
    shortage: hint('公斤', [
      ['公式', '正常库存 − 预计库存'],
      ['说明', '负数表示已超出正常库存（绿带中位）'],
    ]),
    shortageRate: hint('%', [
      ['公式', '缺口量 ÷ 正常库存 × 100%'],
    ]),
  }
}

export const SALES_COLUMN_HINTS = {
  product: hint('', [
    ['父行', '点品名展开 / 收起该品名下的 SKU'],
    ['汇总', '数量列求和；客户CR5率按累积条数加权平均'],
  ]),
  color: hint('', [
    ['关联', '跨导入按「唯一标识 = 品名 | 颜色」关联'],
    ['详情', '点行尾方形按钮打开 SKU 详情'],
  ]),
  monthlyAvgCount: hint('条/月', [
    ['公式', '累积条数 ÷ 动销月份'],
    ['说明', '决定备货模式，与主面板「模式」同一口径'],
  ]),
  totalOrders: hint('单', [
    ['统计', '有效出库行数，1 行 = 1 单'],
  ]),
  activeMonths: hint('个月', [
    ['统计', '有出库的月份中最长连续段，跨年算连续'],
  ]),
  activeCustomers: hint('个', [
    ['统计', '有出库的客户去重计数'],
  ]),
  cumulativeCount: hint('条', [
    ['公式', 'Σ出库数量 ÷ 单位换算系数（码 100 / 公斤 20）'],
    ['说明', '取整；只用于模式判定与 SPU 分级'],
  ]),
  customerCr5: hint('%', [
    ['公式', '销量前 5 名客户销量 ÷ 该 SKU 总销量'],
    ['汇总', '父行按累积条数加权平均，不求和'],
  ]),
}

// 1-12 月三列同口径，只换月份标题。
const MONTH_COLUMN_HINTS = {
  count: hint('条', [
    ['公式', '当月出库数量 ÷ 单位换算系数（码 100 / 公斤 20）'],
    ['统计', '只算出库数量 > 0 的行，取整'],
  ]),
  sales: hint('公斤', [
    ['公式', '当月出库数量换算成公斤后求和'],
    ['统计', '只算出库数量 > 0 的行'],
  ]),
  order: hint('单', [
    ['统计', '当月出库行数，1 行 = 1 单'],
    ['说明', '退货与纯入库行不计'],
  ]),
}

export function salesColumnHint(column) {
  if (!column) return null
  return SALES_COLUMN_HINTS[column.key] ?? MONTH_COLUMN_HINTS[column.kind] ?? null
}

// —— 开发态自检 ——
// 列改了、文案没跟上时在控制台点名，避免「表头没有说明」悄悄漏过去；
// 生产构建里 import.meta.env.DEV 为 false，什么都不做。
function warn(message) {
  if (IS_DEV) console.warn(`[表头说明] ${message}`)
}

const NO_HINT_COLUMN_KEYS = new Set(['select', 'stockingGroupPlaceholder'])

export function checkInventoryColumnHints(columns, hints) {
  if (!IS_DEV) return
  const missing = columns
    .filter((column) => !NO_HINT_COLUMN_KEYS.has(column.key) && !hints[column.key])
    .map((column) => `${column.key}（${column.label}）`)
  if (missing.length) {
    warn(`主面板有列没有表头说明，请补到 src/data/columnHints.js：${missing.join('、')}`)
  }

  const keys = new Set(columns.map((column) => column.key))
  const orphaned = Object.keys(hints).filter((key) => !keys.has(key))
  if (orphaned.length) {
    warn(`主面板有已失效的表头说明（列已删除或改了 key）：${orphaned.join('、')}`)
  }
}

export function checkSalesColumnHints(columns) {
  if (!IS_DEV) return
  const missing = columns
    .filter((column) => !column.hint)
    .map((column) => `${column.key}（${column.label}）`)
  if (missing.length) {
    warn(`销售表有列没有表头说明，请补到 src/data/columnHints.js：${missing.join('、')}`)
  }

  const keys = new Set(columns.map((column) => column.key))
  const orphaned = Object.keys(SALES_COLUMN_HINTS).filter((key) => !keys.has(key))
  if (orphaned.length) {
    warn(`销售表有已失效的表头说明（列已删除或改了 key）：${orphaned.join('、')}`)
  }
}
