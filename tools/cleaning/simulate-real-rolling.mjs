/**
 * 真实数据滚动导入演示（20k SKU × 7 天）
 * ==================================================================
 * 用 `tools/cleaning/data/` 里的**真实六张分表**当基底：
 *   - 产品资料 / 出码率 / 出入库明细 / 库存结存表 / 欠货 / 生产排单 原样保留（按 SKU 子集裁剪）
 *   - 出入库明细保留真实历史（2026-02 ~ 10-21），这样「月均条数」「动销月份」跟生产一致
 *   - 在真实数据最后一天之后接 7 天窗口（默认 10-22 ~ 10-28），每天写一份「截止当天」的累计快照
 *   - 窗口内按真实月销量给每个 SKU 补 0~2 笔出库；另加 6 个场景 SKU（A~F）演 下单→排单→入库
 *
 * 用法（在 tools/cleaning 下执行）：
 *   node simulate-real-rolling.mjs                      # 20,000 SKU × 7 天
 *   node simulate-real-rolling.mjs --skus 2000 --days 3
 *   node simulate-real-rolling.mjs --check              # 生成后跑一遍清洗 + 场景断言
 *   node simulate-real-rolling.mjs --out ../../docs/测试数据/xxx --keep
 *
 * 产物：{@link OUT_DIR}/day-01 … day-07，每天 6 张分表，直接按天导入即可。
 * 注意：明细是真实体量（近 40 万行），每份 xlsx 约 20 MB，7 天合计 100 MB 以上。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

import { runCleaning } from './engine.mjs'
import { createEvaluator, evaluateItem } from '../../src/stocking/engine.js'
import { createDefaultConfig } from '../../src/stocking/defaults.js'
import { calculateInventoryRow, getSuggestedPlanned } from '../../src/utils/inventory.js'
import { buildInTransitIndex, createInTransitBaseline } from '../../src/purchase/inTransit.js'
import { buildOrderIndex, orderedTotalsOf } from '../../src/purchase/resolve.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DATA_DIR = join(HERE, 'data')
const DEFAULT_OUT = join(HERE, '..', '..', 'docs', '测试数据', '滚动导入演示-2w')

/* ---------------------------------------------------------------- */
/* 一、参数与文件认领                                                */
/* ---------------------------------------------------------------- */

function parseArgs(argv) {
  const options = {
    skus: 20000,
    days: 7,
    out: null,
    keep: false,
    check: false,
    startSerial: null,
    historyMonths: 0,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--skus') options.skus = Math.max(10, Number(argv[(i += 1)]) || options.skus)
    else if (arg === '--days') options.days = Math.max(1, Number(argv[(i += 1)]) || options.days)
    else if (arg === '--out') options.out = argv[(i += 1)] || null
    else if (arg === '--start') options.startSerial = excelSerial(argv[(i += 1)])
    else if (arg === '--history-months') options.historyMonths = Math.max(0, Number(argv[(i += 1)]) || 0)
    else if (arg === '--keep') options.keep = true
    else if (arg === '--check') options.check = true
  }
  return options
}

/** Excel 日期序列号（1900 体系）；支持 'YYYY-MM-DD' */
function excelSerial(text) {
  const match = String(text ?? '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) return null
  const [, year, month, day] = match
  return Math.round(
    (Date.UTC(Number(year), Number(month) - 1, Number(day)) - Date.UTC(1899, 11, 30)) / 86400000,
  )
}

/** Excel 序列号 → 单号里用的 YYYYMMDD */
function serialLabel(serial) {
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

// 文件名关键字与 engine 的认领规则一致；Excel 打开时留下的 ~$ 临时文件要跳过
const ROLES = [
  { role: '产品资料', match: /产品资料/ },
  { role: '出码率', match: /出码率/ },
  { role: '出入库明细', match: /出入库明细/ },
  { role: '库存结存表', match: /库存结存/ },
  { role: '欠货', match: /欠货/ },
  { role: '生产排单', match: /scheduling/i },
]

const OUTPUT_NAME = {
  产品资料: '产品资料.xlsx',
  出码率: '出码率.xlsx',
  出入库明细: '出入库明细（销售+加工）.xlsx',
  库存结存表: '库存结存表.xlsx',
  欠货: '欠货订单导出.xlsx',
  生产排单: 'productionScheduling.xlsx',
}

function resolveDataFiles() {
  const files = readdirSync(DATA_DIR).filter((name) => /\.xlsx$/i.test(name) && !name.startsWith('~$'))
  const found = new Map()
  for (const { role, match } of ROLES) {
    const hit = files.filter((name) => match.test(name)).sort((a, b) => b.length - a.length)[0]
    if (!hit) throw new Error(`data 目录里找不到「${role}」分表`)
    found.set(role, join(DATA_DIR, hit))
  }
  return found
}

function readSheet(path) {
  const book = XLSX.readFile(path, { cellDates: false })
  const sheet = book.Sheets[book.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
  const header = (grid[0] ?? []).map((cell) => String(cell ?? '').trim())
  const rows = grid
    .slice(1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
  return { header, rows }
}

function writeSheet(dir, fileName, header, rows) {
  mkdirSync(dir, { recursive: true })
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet')
  // 明细近 40 万行：开压缩 + 共享字符串，否则单份就是 160 MB
  XLSX.writeFile(book, join(dir, fileName), { compression: true, bookSST: true })
}

/* ---------------------------------------------------------------- */
/* 二、真实基底                                                      */
/* ---------------------------------------------------------------- */

const COLORS_MONO = ['本白', '大白', '黑白', '黑色']
const isMonochrome = (color) => COLORS_MONO.some((word) => String(color).includes(word))

function indexOf(header, name) {
  return header.indexOf(name)
}

/** 真实出库量 → 条数（与清洗引擎同口径：码 ÷ 100、公斤 ÷ 20） */
function unitsToCount(units, unit) {
  if (unit === '码') return units / 100
  if (unit === '公斤') return units / 20
  return 0
}

/** 连续动销月份数（与清洗引擎的 agg: 'months' 同义，真实数据按月连续） */
function consecutiveMonths(monthIndices) {
  const sorted = [...monthIndices].sort((a, b) => a - b)
  if (!sorted.length) return 0
  let best = 1
  let run = 1
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1] + 1) {
      run += 1
      best = Math.max(best, run)
    } else if (sorted[i] !== sorted[i - 1]) {
      run = 1
    }
  }
  return best
}

const SCENARIOS = [
  { key: 'A', product: '场景A品', seedKg: 1000, countPerMonth: 70 },
  { key: 'B', product: '场景B品', seedKg: 1000, countPerMonth: 70 },
  { key: 'C', product: '场景C品', seedKg: 1000, countPerMonth: 70 },
  { key: 'D', product: '场景D品', seedKg: 500, countPerMonth: 70 },
  { key: 'E', product: '场景E品', seedKg: 1000, countPerMonth: 70 },
  { key: 'F', product: '场景F品', seedKg: 1000, countPerMonth: 70 },
]

/** 场景剧本：day 从 1 开始；只写分表里能看到的部分（下单 / 撤销在网页里做） */
function buildEvents() {
  const id = (product) => `${product}|1#黑`
  return [
    { day: 1, type: 'order', skuId: id('场景A品'), kg: 500 },
    { day: 2, type: 'schedule', skuId: id('场景A品'), kg: 500 },
    { day: 3, type: 'inbound', skuId: id('场景A品'), kg: 500, doc: '生产入库' },

    { day: 1, type: 'order', skuId: id('场景B品'), kg: 480 },
    { day: 2, type: 'schedule', skuId: id('场景B品'), kg: 480 },
    { day: 3, type: 'inbound', skuId: id('场景B品'), kg: 240, doc: '生产入库' },
    { day: 4, type: 'inbound', skuId: id('场景B品'), kg: 240, doc: '生产入库' },

    { day: 1, type: 'order', skuId: id('场景C品'), kg: 500 },
    { day: 2, type: 'schedule', skuId: id('场景C品'), kg: 600 },
    { day: 3, type: 'inbound', skuId: id('场景C品'), kg: 600, doc: '生产入库' },

    { day: 3, type: 'inbound', skuId: id('场景D品'), kg: 100, doc: '销售退货入库' },

    { day: 1, type: 'order', skuId: id('场景E品'), kg: 300 },
    { day: 2, type: 'revoke', skuId: id('场景E品') },

    { day: 1, type: 'order', skuId: id('场景F品'), kg: 500 },
    { day: 3, type: 'inbound', skuId: id('场景F品'), kg: 500, doc: '生产入库' },
  ]
}

/* ---------------------------------------------------------------- */
/* 三、主流程                                                        */
/* ---------------------------------------------------------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const files = resolveDataFiles()
  const outDir = options.out ? resolve(process.cwd(), options.out) : DEFAULT_OUT

  let mark = Date.now()
  const elapsed = (label) => {
    console.log(`  ${label} ${((Date.now() - mark) / 1000).toFixed(1)}s`)
    mark = Date.now()
  }

  console.log('读取真实分表…')
  const master = readSheet(files.get('产品资料'))
  const rate = readSheet(files.get('出码率'))
  const stock = readSheet(files.get('库存结存表'))
  const backorder = readSheet(files.get('欠货'))
  const schedule = readSheet(files.get('生产排单'))
  const detail = readSheet(files.get('出入库明细'))
  elapsed('读取完成')

  const rateOf = new Map()
  {
    const pi = indexOf(rate.header, '品名')
    const ri = indexOf(rate.header, '出码率')
    for (const row of rate.rows) {
      const product = String(row[pi] ?? '').trim()
      const value = Number(row[ri])
      if (product && Number.isFinite(value) && value > 0) rateOf.set(product, value)
    }
  }

  const keyOf = (product, color) => `${String(product ?? '').trim()}|${String(color ?? '').trim()}`

  // 真实出库统计：条数 / 动销月份 / 公斤，用来定窗口期的日出库量与模式
  const stats = new Map()
  {
    const kp = indexOf(detail.header, '品名')
    const kc = indexOf(detail.header, '颜色')
    const ku = indexOf(detail.header, '单位')
    const kout = indexOf(detail.header, '出库数量')
    const kdate = indexOf(detail.header, '做账日期')
    for (const row of detail.rows) {
      const qty = Number(row[kout])
      if (!(qty > 0)) continue
      const unit = String(row[ku] ?? '').trim()
      const key = keyOf(row[kp], row[kc])
      const count = unitsToCount(qty, unit)
      if (count <= 0) continue
      const entry = stats.get(key) ?? { count: 0, kg: 0, months: new Set(), unit }
      entry.count += count
      const product = String(row[kp] ?? '').trim()
      entry.kg += unit === '公斤' ? qty : qty / (rateOf.get(product) || 1)
      const serial = Number(row[kdate])
      if (Number.isFinite(serial) && serial > 0) {
        const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
        entry.months.add(date.getUTCFullYear() * 12 + date.getUTCMonth())
      }
      stats.set(key, entry)
    }
  }

  // 选 SKU：只挑「清洗后能留下」的（公斤单位，或码单位且有出码率），
  // 否则 --skus 20000 会被清洗砍到 1.7 万左右。先取有出库的（保真实模式分布），再按库存 / 产品资料补齐。
  const masterProduct = indexOf(master.header, '品名')
  const masterColor = indexOf(master.header, '颜色')
  const masterUnitIdx = indexOf(master.header, '单位')
  const cleanable = new Set()
  const masterOrder = []
  for (const row of master.rows) {
    const product = String(row[masterProduct] ?? '').trim()
    const color = String(row[masterColor] ?? '').trim()
    if (!product || !color) continue
    const unit = String(row[masterUnitIdx] ?? '').trim()
    const key = `${product}|${color}`
    masterOrder.push(key)
    if (unit === '公斤' || (unit === '码' && rateOf.has(product))) cleanable.add(key)
  }

  const selected = new Set()
  for (const [key, entry] of [...stats.entries()].sort((a, b) => b[1].count - a[1].count)) {
    if (selected.size >= options.skus) break
    if (entry.count > 0 && cleanable.has(key)) selected.add(key)
  }
  const stockKeyIndex = { p: indexOf(stock.header, '品名'), c: indexOf(stock.header, '颜色'), q: indexOf(stock.header, '数量') }
  for (const row of [...stock.rows].sort((a, b) => (Number(b[stockKeyIndex.q]) || 0) - (Number(a[stockKeyIndex.q]) || 0))) {
    if (selected.size >= options.skus) break
    const key = keyOf(row[stockKeyIndex.p], row[stockKeyIndex.c])
    if (cleanable.has(key)) selected.add(key)
  }
  for (const key of masterOrder) {
    if (selected.size >= options.skus) break
    if (cleanable.has(key)) selected.add(key)
  }
  console.log(`选中 ${selected.size} 个 SKU（可清洗 ${cleanable.size} 个 / 真实有出库 ${stats.size} 个）`)
  elapsed('选 SKU')

  // 明细：只留选中的 SKU；真实历史原样保留
  const detailKey = { p: indexOf(detail.header, '品名'), c: indexOf(detail.header, '颜色') }
  const detailDate = indexOf(detail.header, '做账日期')
  let historyRows = detail.rows.filter((row) =>
    selected.has(keyOf(row[detailKey.p], row[detailKey.c])),
  )
  // --history-months N：只留最近 N 个自然月（N=0 保留全部历史）。
  // 注意砍历史会让「动销月份」和「累积销量」一起变小，进销比评分会偏，演示够用、别拿它核评分。
  if (options.historyMonths > 0) {
    let maxSerial = 0
    for (const row of historyRows) {
      const serial = Number(row[detailDate])
      if (Number.isFinite(serial) && serial > maxSerial && serial < 60000) maxSerial = serial
    }
    const maxDate = new Date(Date.UTC(1899, 11, 30) + maxSerial * 86400000)
    const cutoffDate = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth() - (options.historyMonths - 1), 1))
    const cutoff = Math.round((cutoffDate - Date.UTC(1899, 11, 30)) / 86400000)
    historyRows = historyRows.filter((row) => Number(row[detailDate]) >= cutoff)
    console.log(`只保留 ${options.historyMonths} 个自然月（${cutoff} 起）`)
  }
  console.log(`真实明细保留 ${historyRows.length} 行`)
  elapsed('裁明细')

  let windowStart = options.startSerial
  if (!windowStart) {
    const di = indexOf(detail.header, '做账日期')
    let maxSerial = 0
    for (const row of historyRows) {
      const serial = Number(row[di])
      if (Number.isFinite(serial) && serial > maxSerial && serial < 60000) maxSerial = serial
    }
    windowStart = maxSerial + 1
  }
  console.log(`窗口：${serialLabel(windowStart)} 起 ${options.days} 天`)

  /* ---------------- 窗口期出库增量 ---------------- */
  const windowOut = new Map() // day → rows
  for (let day = 1; day <= options.days; day += 1) windowOut.set(day, [])
  let seq = 0
  // 明细行按真实表头的位置拼，不靠列顺序硬编码
  const dcol = {
    date: indexOf(detail.header, '做账日期'),
    no: indexOf(detail.header, '单号'),
    doc: indexOf(detail.header, '来源单据'),
    product: indexOf(detail.header, '品名'),
    color: indexOf(detail.header, '颜色'),
    unit: indexOf(detail.header, '单位'),
    inboundCount: indexOf(detail.header, '入库条数'),
    inbound: indexOf(detail.header, '入库数量'),
    outboundCount: indexOf(detail.header, '出库条数'),
    outbound: indexOf(detail.header, '出库数量'),
    customer: indexOf(detail.header, '客户'),
  }
  const makeDetailRow = (values) => {
    const row = new Array(detail.header.length).fill('')
    for (const [key, value] of Object.entries(values)) {
      if (dcol[key] >= 0) row[dcol[key]] = value
    }
    return row
  }
  const pushOut = (day, product, color, unit, units, customer) => {
    seq += 1
    windowOut.get(day).push(
      makeDetailRow({
        date: windowStart + day - 1,
        no: `XS-${serialLabel(windowStart + day - 1)}-${String(seq).padStart(7, '0')}`,
        doc: '销售单',
        product,
        color,
        unit,
        inboundCount: 0,
        inbound: 0,
        outboundCount: 0,
        outbound: units,
        customer: customer ?? '',
      }),
    )
  }
  const customers = ['杭州锦程布行', '苏州驰萌布行', '郑州群厚贸易', '深圳凤聪布行', '北京群江纺织']
  let windowSkuCount = 0
  {
    let index = 0
    for (const [key, entry] of stats) {
      if (!selected.has(key)) continue
      index += 1
      const months = consecutiveMonths(entry.months) || 1
      const dailyUnits = entry.count / months / 30
      const totalUnits = Math.round(dailyUnits * options.days * 0.85)
      if (totalUnits <= 0) continue
      const [product, color] = key.split('|')
      // 每天 0~1 笔，七天内 1~2 笔，前一笔占六成
      const first = 1 + (index % options.days)
      let second = 1 + ((index * 3) % options.days)
      if (second === first) second = (first % options.days) + 1
      const firstUnits = Math.max(1, Math.round(totalUnits * 0.6))
      const secondUnits = Math.max(0, totalUnits - firstUnits)
      pushOut(first, product, color, entry.unit, firstUnits, customers[index % customers.length])
      if (secondUnits > 0) {
        pushOut(second, product, color, entry.unit, secondUnits, customers[(index + 2) % customers.length])
      }
      windowSkuCount += 1
    }
  }
  console.log(`窗口出库：${windowSkuCount} 个 SKU，${seq} 笔`)

  /* ---------------- 场景 SKU：历史 + 剧本 ---------------- */
  const events = buildEvents().filter((event) => event.day <= options.days)
  const scenarioHistory = new Map() // day 0 = 窗口前
  const scenarioInbound = new Map()
  for (let day = 0; day <= options.days; day += 1) {
    scenarioHistory.set(day, [])
    scenarioInbound.set(day, [])
  }
  {
    const first = windowStart - 84 // 8/1 前后：横跨 3 个自然月
    const last = windowStart - 1
    const days = last - first + 1
    for (const scenario of SCENARIOS) {
      const totalKg = scenario.countPerMonth * 20 * 3
      const rowCount = 10
      for (let i = 0; i < rowCount; i += 1) {
        const serial = first + Math.round(((days - 1) * i) / (rowCount - 1))
        const kg = Math.round(totalKg / rowCount)
        scenarioHistory.get(0).push(
          makeDetailRow({
            date: serial,
            no: `XS-${serialLabel(serial)}-S${scenario.key}${String(i).padStart(2, '0')}`,
            doc: '销售单',
            product: scenario.product,
            color: '1#黑',
            unit: '公斤',
            inboundCount: 0,
            inbound: 0,
            outboundCount: 0,
            outbound: kg,
            customer: customers[i % customers.length],
          }),
        )
      }
    }
  }
  for (const event of events) {
    if (event.type !== 'inbound') continue
    scenarioInbound.get(event.day).push(
      makeDetailRow({
        date: windowStart + event.day - 1,
        no: `RK-${serialLabel(windowStart + event.day - 1)}-${event.skuId.slice(0, 1)}`,
        doc: event.doc,
        product: event.skuId.split('|')[0],
        color: '1#黑',
        unit: '公斤',
        inboundCount: 0,
        inbound: event.kg,
        outboundCount: 0,
        outbound: 0,
        customer: '',
      }),
    )
  }

  /* ---------------- 产品资料 / 出码率 / 结存 / 欠货 / 排单 ---------------- */
  const masterKey = { p: indexOf(master.header, '品名'), c: indexOf(master.header, '颜色') }
  const masterUnit = indexOf(master.header, '单位')
  const masterTree = indexOf(master.header, '树形分类')
  const masterRows = master.rows
    .filter((row) => selected.has(keyOf(row[masterKey.p], row[masterKey.c])))
    .map((row) => row.slice())
  for (const scenario of SCENARIOS) {
    const row = new Array(master.header.length).fill('')
    row[masterKey.p] = scenario.product
    row[masterKey.c] = '1#黑'
    if (masterUnit >= 0) row[masterUnit] = '公斤'
    if (masterTree >= 0) row[masterTree] = '场景类'
    masterRows.push(row)
  }

  const usedProducts = new Set(masterRows.map((row) => String(row[masterKey.p] ?? '').trim()))
  const rateRows = rate.rows.filter((row) => usedProducts.has(String(row[indexOf(rate.header, '品名')] ?? '').trim()))

  // 结存按 SKU 合成一行（真实表按仓库拆行，引擎按 SKU 汇总），便于窗口期逐日扣减
  const stockRows = []
  const stockKeyIndex2 = { p: indexOf(stock.header, '品名'), c: indexOf(stock.header, '颜色'), q: indexOf(stock.header, '数量') }
  const stockOf = new Map()
  for (const row of stock.rows) {
    const key = keyOf(row[stockKeyIndex2.p], row[stockKeyIndex2.c])
    if (!selected.has(key)) continue
    stockOf.set(key, (stockOf.get(key) ?? 0) + (Number(row[stockKeyIndex2.q]) || 0))
  }
  for (const scenario of SCENARIOS) stockOf.set(`${scenario.product}|1#黑`, scenario.seedKg)
  for (const [key, qty] of stockOf) {
    const [product, color] = key.split('|')
    const row = new Array(stock.header.length).fill('')
    row[stockKeyIndex2.p] = product
    row[stockKeyIndex2.c] = color
    row[stockKeyIndex2.q] = Math.max(0, Math.round(qty))
    stockRows.push(row)
  }

  const backorderKey = { p: indexOf(backorder.header, '产品名'), c: indexOf(backorder.header, '颜色') }
  const backorderRows = backorder.rows.filter((row) =>
    selected.has(keyOf(row[backorderKey.p], row[backorderKey.c])),
  )

  const scheduleKey = { p: indexOf(schedule.header, '品名'), c: indexOf(schedule.header, '天鸿颜色') }
  const scheduleRows = schedule.rows.filter((row) =>
    selected.has(keyOf(row[scheduleKey.p], row[scheduleKey.c])),
  )
  const scheduleByDay = new Map()
  for (let day = 1; day <= options.days; day += 1) scheduleByDay.set(day, [])
  for (const event of events) {
    if (event.type !== 'schedule') continue
    const [product, color] = event.skuId.split('|')
    const row = new Array(schedule.header.length).fill('')
    row[indexOf(schedule.header, '缸号')] = `GH-${String(scheduleRows.length + event.day).padStart(4, '0')}`
    row[indexOf(schedule.header, '下单日期')] = windowStart + event.day - 1
    row[indexOf(schedule.header, '进仓日期')] = windowStart + event.day - 1 + 20
    row[indexOf(schedule.header, '染厂名称')] = '连江治建霞'
    row[indexOf(schedule.header, '品名')] = product
    row[indexOf(schedule.header, '天鸿颜色')] = color
    row[indexOf(schedule.header, '进仓重量')] = event.kg
    row[indexOf(schedule.header, '时长')] = '30天'
    scheduleByDay.get(event.day).push(row)
  }

  /* ---------------- 逐日写盘 ---------------- */
  if (!options.keep && existsSync(outDir)) {
    for (let day = 1; day <= 99; day += 1) {
      const dir = join(outDir, `day-${String(day).padStart(2, '0')}`)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }

  const cumOut = []
  const cumIn = []
  const cumSchedule = []
  const stockNow = new Map(stockOf)
  let totalBytes = 0

  for (let day = 1; day <= options.days; day += 1) {
    cumOut.push(...windowOut.get(day))
    cumIn.push(...scenarioInbound.get(day))
    cumSchedule.push(...scheduleByDay.get(day))
    for (const row of windowOut.get(day)) {
      const key = keyOf(row[detailKey.p], row[detailKey.c])
      const unit = String(row[indexOf(detail.header, '单位')] ?? '').trim()
      const units = Number(row[indexOf(detail.header, '出库数量')]) || 0
      // 码 / 公斤都按原值扣，结存数量本来就是 SKU 自己的单位
      stockNow.set(key, Math.max(0, (stockNow.get(key) ?? 0) - (unit === '码' || unit === '公斤' ? units : 0)))
    }
    for (const row of scenarioInbound.get(day)) {
      const key = keyOf(row[detailKey.p], row[detailKey.c])
      const units = Number(row[indexOf(detail.header, '入库数量')]) || 0
      stockNow.set(key, (stockNow.get(key) ?? 0) + units)
    }

    const dir = join(outDir, `day-${String(day).padStart(2, '0')}`)
    writeSheet(dir, OUTPUT_NAME['产品资料'], master.header, masterRows)
    writeSheet(dir, OUTPUT_NAME['出码率'], rate.header, rateRows)
    writeSheet(dir, OUTPUT_NAME['出入库明细'], detail.header, [
      ...scenarioHistory.get(0),
      ...historyRows,
      ...cumOut,
      ...cumIn,
    ])
    writeSheet(
      dir,
      OUTPUT_NAME['库存结存表'],
      stock.header,
      stockRows.map((row) => {
        const key = keyOf(row[stockKeyIndex2.p], row[stockKeyIndex2.c])
        const next = row.slice()
        next[stockKeyIndex2.q] = Math.max(0, Math.round(stockNow.get(key) ?? 0))
        return next
      }),
    )
    writeSheet(dir, OUTPUT_NAME['欠货'], backorder.header, backorderRows)
    writeSheet(dir, OUTPUT_NAME['生产排单'], schedule.header, [...scheduleRows, ...cumSchedule])

    const dayBytes = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
    totalBytes += dayBytes
    console.log(`  day-${String(day).padStart(2, '0')} 写完 ${(dayBytes / 1024 / 1024).toFixed(1)} MB，明细 ${(historyRows.length + cumOut.length + cumIn.length + scenarioHistory.get(0).length).toLocaleString()} 行`)
  }
  console.log(`合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB → ${outDir}`)
  elapsed('写盘')

  if (options.check) {
    console.log('\n自检：拿 day-01 与最后一天跑一遍真实清洗 + 对账…')
    const evaluator = createEvaluator(createDefaultConfig(), { baselineMonth: null })
    const snapshots = []
    for (const day of [1, options.days]) {
      const dir = join(outDir, `day-${String(day).padStart(2, '0')}`)
      const cleaned = await runCleaningSource(dir)
      const items = itemsFromTotalTable(cleaned.total)
      const salesIndex = buildSalesIndex(cleaned.sales)
      if (!snapshots.length) snapshots.push({ baseline: createInTransitBaseline(items) })
      const orders = buildOrderIndex(
        events.filter((event) => event.type === 'order' && event.day <= day)
          .map((event, index) => ({
            id: `so-${index}`,
            skuId: event.skuId,
            quantity: event.kg,
            receivedQty: 0,
            status: 'active',
          })),
      )
      const inTransit = buildInTransitIndex({
        items,
        orderedTotals: orderedTotalsOf(orders),
        baseline: snapshots[0].baseline,
      })
      const rows = items.map((item) => {
        const sales = salesIndex.get(item.skuId) ?? null
        const monthlyAvgCount =
          sales && sales.activeMonths > 0
            ? Math.round((sales.cumulativeCount / sales.activeMonths) * 100) / 100
            : 0
        const evaluated = evaluateItem(
          {
            ...item,
            monthlyAvgCount,
            monthSales: sales?.monthSales ?? null,
            activeCustomers: sales?.activeCustomers ?? 0,
          },
          evaluator,
        )
        return {
          ...calculateInventoryRow({ ...evaluated, ...(inTransit.get(item.skuId) ?? {}) }),
          ordered: orders.get(item.skuId)?.ordered ?? 0,
        }
      })
      const byId = new Map(rows.map((row) => [row.skuId, row]))
      const a = byId.get('场景A品|1#黑')
      console.log(
        `  day-${String(day).padStart(2, '0')}：${cleaned.total.rows.length} 个 SKU / ${cleaned.total.columns.length} 列，` +
          `场景A 在仓 ${Math.round(a?.warehouseKg ?? 0)} 在途 ${Math.round(a?.inTransitKg ?? 0)} 理论 ${Math.round(a?.theoreticalStock ?? 0)} 预计 ${Math.round(a?.projectedStock ?? 0)}`,
      )
      if (day === 1) {
        const buckets = new Map()
        let actionable = 0
        for (const row of rows) {
          const label = row.excluded ? `${row.modeName}·不参与` : row.modeName
          buckets.set(label, (buckets.get(label) ?? 0) + 1)
          if (getSuggestedPlanned(row) > 0) actionable += 1
        }
        console.log(
          `    模式分布：${[...buckets.entries()].map(([label, count]) => `${label} ${count}`).join(' / ')}`,
        )
        console.log(`    建议需安排 > 0：${actionable} 个`)
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* 四、自检用的小工具                                                */
/* ---------------------------------------------------------------- */

async function runCleaningSource(dir) {
  const readRecords = async (source, fields, handle) => {
    const file = join(dir, OUTPUT_NAME[source.label])
    if (!existsSync(file)) throw new Error(`缺少分表文件：${file}`)
    const book = XLSX.readFile(file)
    const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: '' })
    const header = (rows[0] ?? []).map((cell) => String(cell ?? '').trim())
    const at = new Map(header.map((name, column) => [name, column]))
    for (const row of rows.slice(1)) {
      if (row.every((cell) => String(cell ?? '').trim() === '')) continue
      const record = {}
      for (const name of fields) {
        const column = at.get(name)
        record[name] = column === undefined ? '' : row[column]
      }
      handle(record)
    }
    return { sheetName: source.label }
  }
  const result = await runCleaning({ readRecords })
  return { total: result.tables['总表'], sales: result.tables['销售表'] }
}

function itemsFromTotalTable(table) {
  const at = (name) => table.columns.indexOf(name)
  const col = {
    skuId: at('唯一标识'),
    product: at('品名'),
    color: at('颜色'),
    category: at('色彩'),
    treeCategory: at('树形分类'),
    kgFactor: at('公斤系数'),
    producing: at('生产中'),
    producedIn: at('生产入库'),
    returnedIn: at('退货入库'),
    warehouseStock: at('在仓库存'),
    backorder: at('欠货'),
    weeklySales: at('周销量'),
  }
  for (const [name, index] of Object.entries(col)) {
    if (index < 0) throw new Error(`总表缺少列：${name}`)
  }
  return table.rows.map((cells, rowIndex) => {
    const number = (key) => Number(cells[col[key]]) || 0
    const kgFactor = Number(cells[col.kgFactor])
    return {
      id: rowIndex + 1,
      skuId: String(cells[col.skuId] ?? '').trim(),
      product: String(cells[col.product] ?? '').trim(),
      color: String(cells[col.color] ?? '').trim(),
      category: String(cells[col.category] ?? '').trim(),
      treeCategory: String(cells[col.treeCategory] ?? '').trim(),
      kgFactor: Number.isFinite(kgFactor) && kgFactor > 0 ? kgFactor : null,
      producing: number('producing'),
      producedIn: number('producedIn'),
      returnedIn: number('returnedIn'),
      warehouseStock: number('warehouseStock'),
      backorder: number('backorder'),
      weeklySales: number('weeklySales'),
      planned: null,
    }
  })
}

function buildSalesIndex(salesTable) {
  const at = (name) => salesTable.columns.indexOf(name)
  const keyColumn = at('唯一标识')
  const monthColumns = Array.from({ length: 12 }, (_, index) => at(`${index + 1}月销量`))
  const index = new Map()
  for (const cells of salesTable.rows) {
    const skuId = String(cells[keyColumn] ?? '').trim()
    if (!skuId) continue
    index.set(skuId, {
      cumulativeCount: Number(cells[at('累积条数')]) || 0,
      cumulativeSales: Number(cells[at('累积销量')]) || 0,
      activeMonths: Number(cells[at('动销月份')]) || 0,
      activeCustomers: Number(cells[at('累计客户')]) || 0,
      monthSales: monthColumns.map((column) => (column < 0 ? 0 : Number(cells[column]) || 0)),
    })
  }
  return index
}

await main()
