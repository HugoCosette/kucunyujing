/**
 * 滚动导入回放（在途口径验收 + 可导入的演示数据）
 * ==================================================================
 * 造 N 个 SKU × D 天的六张分表，逐日跑一遍**真实的**清洗引擎 + 在途对账，
 * 断言「同一批货在 需安排 → 已安排 → 生产中 → 在仓 之间迁移时，预计库存不跳动」。
 *
 * 用法（在 tools/cleaning 下执行）：
 *   node simulate-rolling.mjs                     # 1000 SKU × 7 天，写到 output/rolling-sim
 *   node simulate-rolling.mjs --skus 200 --days 5
 *   node simulate-rolling.mjs --no-files          # 只在内存里造数回放，不落 xlsx
 *   node simulate-rolling.mjs --keep              # 不清理旧的输出目录
 *
 * 产物：{@link OUT_DIR}/day-01 … day-07，每天六张表，可以直接拖进网页「导入分表」按天导入。
 *
 * 造数不是平均分布：每个 SKU 先定「月均条数」目标，再按 20 公斤/条（公斤单位）或
 * 100 码 ÷ 出码率（码单位）折成公斤，出库量按 92 天摊平。这样模式判定才有热销 / 常规 /
 * 按量 / 尾货 / 滞销五档（比例对齐真实数据，见 MODE_BANDS），需安排、评分、预警才有东西可看。
 *
 * 校验的是口径，不是性能：真实全量的耗时请用 tools/cleaning/data 下的正式分表另测。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

import { runCleaning } from './engine.mjs'
import { createEvaluator, evaluateItem } from '../../src/stocking/engine.js'
import { createDefaultConfig } from '../../src/stocking/defaults.js'
import { calculateInventoryRow, getSuggestedPlanned } from '../../src/utils/inventory.js'
import { buildInTransitIndex, createInTransitBaseline, reconcileSku } from '../../src/purchase/inTransit.js'
import { buildOrderIndex, orderedTotalsOf } from '../../src/purchase/resolve.js'

/* ---------------------------------------------------------------- */
/* 一、参数                                                          */
/* ---------------------------------------------------------------- */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_OUT_DIR = join(HERE, 'output', 'rolling-sim')

function parseArgs(argv) {
  const options = { skus: 1000, days: 7, files: true, keep: false, out: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--skus') options.skus = Math.max(10, Number(argv[(i += 1)]) || options.skus)
    else if (arg === '--days') options.days = Math.max(3, Number(argv[(i += 1)]) || options.days)
    else if (arg === '--out') options.out = argv[(i += 1)] || null
    else if (arg === '--no-files') options.files = false
    else if (arg === '--keep') options.keep = true
  }
  return options
}

/* ---------------------------------------------------------------- */
/* 二、造数                                                          */
/* ---------------------------------------------------------------- */

const COLORS = ['1#黑', '2#本白', '3#大白', '4#浅杏', '31#浅米黄', '66#深灰', '88#玉米色', '101#藏青', '193#浅咖', '205#酒红']
const CUSTOMERS = ['杭州锦程布行', '苏州驰萌布行', '郑州群厚贸易', '深圳凤聪布行', '北京群江纺织', '广州汇美布业', '绍兴柯桥档口', '东莞恒盛面料']
// 出码率取真实数据的中段（22k SKU 的 出码率 p50≈20、p90≈35 码/公斤）
const RATE_CHOICES = [12, 18, 24, 30]
const UNIT_CHOICES = ['公斤', '公斤', '码'] // 三分之一是码单位，考验公斤系数

// 回放窗口 = 10/25 … 10/31（7 天）；预置历史 = 8/1 … 10/24。
// 历史必须横跨 3 个自然月：「动销月份」按自然月计数，只给 7 天数据会把月均条数压到 1/4，
// 所有 SKU 都会掉进尾货 / 滞销（这正是第一版演示数据的问题）。
const BASE_YEAR = 2026
const BASE_MONTH = 10
const WINDOW_FIRST_DAY = 25
const HISTORY_FIRST = { year: 2026, month: 8, day: 1 }
const HISTORY_ROWS = 10 // 每个 SKU 预置的历史出库笔数（面料是大单，不按天出库）
const WINDOW_SALES_SHARE = 0.15 // 窗口期内继续出库的份额，其余留在历史里

/** Excel 日期序列号（1900 体系） */
function excelSerial(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000)
}

// 模式分布对齐真实数据（22k SKU：尾货≈73%、按量≈15%、常规≈6%、热销≈2%、滞销≈3%），
// 可参与备货的比例略微提亮到 ~30%，否则演示时整张表都是「不参与」、需安排全是 0。
// count(index) 给出目标「月均条数」，区间落在 src/stocking/config.json 的模式范围内且远离端点。
const MODE_BANDS = [
  { key: 'hot', weight: 4, count: (i) => 34 + ((i * 7) % 24) }, // 34~57 条/月
  { key: 'normal', weight: 8, count: (i) => 13 + ((i * 5) % 14) }, // 13~26
  { key: 'bulk', weight: 18, count: (i) => 4 + ((i * 3) % 5) }, // 4~8
  { key: 'tail', weight: 65, count: (i) => 0.5 + ((i * 7) % 16) / 10 }, // 0.5~2.0
  { key: 'slow', weight: 5, count: () => 0 }, // 无出库 → 滞销
]

// 在仓按「几个月的销量」铺开，让预警灯红 / 黄 / 绿 / 紫四档都有人：
// 热销系数是 20 / 40 / 60 天，0.5~0.9 个月→红或黄，1.1~1.6→黄或绿，2.2~3→紫。
// 下限 0.5 个月是为了盖住窗口期内继续出库的 0.45 个月，库存不会被打成 0。
const STOCK_MONTHS = [0.5, 0.7, 0.9, 1.1, 1.3, 1.6, 2.2, 3.0]

function bandOf(index) {
  const roll = ((index - 1) % 100) + 1
  let acc = 0
  for (const band of MODE_BANDS) {
    acc += band.weight
    if (roll <= acc) return band
  }
  return MODE_BANDS[MODE_BANDS.length - 1]
}

const SCENARIO_PRODUCTS = [
  { key: 'A', product: '场景A品', seedKg: 1000, countPerMonth: 70 }, // 主流程：下单 → 排单 → 入库
  { key: 'B', product: '场景B品', seedKg: 1000, countPerMonth: 70 }, // 部分到货（分两批）
  { key: 'C', product: '场景C品', seedKg: 1000, countPerMonth: 70 }, // 超产：排单比下单多
  { key: 'D', product: '场景D品', seedKg: 500, countPerMonth: 70 }, // 退货入库：不动在途
  { key: 'E', product: '场景E品', seedKg: 1000, countPerMonth: 70 }, // 下单后撤销
  { key: 'F', product: '场景F品', seedKg: 1000, countPerMonth: 70 }, // 排单漏记，直接入库
]

/** 脏数据：缺出码率 / 非公斤单位 / 排单颜色带尾巴 / 排单颜色为空 */
const DIRTY_SKUS = [
  { skuId: '无码率品|1#黑', product: '无码率品', color: '1#黑', unit: '码', rate: null, drop: true },
  { skuId: '按条品|1#黑', product: '按条品', color: '1#黑', unit: '条', rate: null, drop: true },
  { skuId: '松散品|1#黑', product: '松散品', color: '1#黑', unit: '公斤', rate: null, seedKg: 500 },
  { skuId: '排单空色品|1#黑', product: '排单空色品', color: '1#黑', unit: '公斤', rate: null, seedKg: 500 },
]

function buildCatalog(skuCount) {
  const skus = []
  let index = 0

  const perProduct = COLORS.length
  const productCount = Math.ceil(skuCount / perProduct)
  for (let p = 0; p < productCount; p += 1) {
    const product = `模拟网${String(p + 1).padStart(3, '0')}`
    const unit = UNIT_CHOICES[p % UNIT_CHOICES.length]
    const rate = unit === '码' ? RATE_CHOICES[p % RATE_CHOICES.length] : null
    for (const color of COLORS) {
      if (skus.length >= skuCount) break
      index += 1
      const kgFactor = unit === '公斤' ? 1 : 1 / rate
      const band = bandOf(index)
      const countPerMonth = band.count(index)
      // 条/月 → 公斤/月：1 条 = 20 公斤，或 100 码 ÷ 出码率（与清洗引擎的「累积条数」同口径）
      const kgPerMonth = countPerMonth * (unit === '公斤' ? 20 : 100 / rate)
      const monthlyKg = Math.round(kgPerMonth * 100) / 100
      const seedKg =
        countPerMonth > 0
          ? Math.max(1, Math.round(monthlyKg * STOCK_MONTHS[index % STOCK_MONTHS.length]))
          : 30 + (index % 5) * 25 // 滞销：没销量但有存货
      skus.push({
        index,
        skuId: `${product}|${color}`,
        product,
        color,
        unit,
        rate,
        kgFactor,
        band: band.key,
        countPerMonth,
        monthlyKg,
        seedKg,
        treeCategory: p % 2 === 0 ? '厚布类' : '薄布类',
        scenario: false,
        windowSales: index % 3 !== 0, // 三分之二的 SKU 在窗口期内继续出库
      })
    }
  }

  let seq = index
  for (const scenario of SCENARIO_PRODUCTS) {
    seq += 1
    skus.push({
      index: seq,
      skuId: `${scenario.product}|1#黑`,
      product: scenario.product,
      color: '1#黑',
      unit: '公斤',
      rate: null,
      kgFactor: 1,
      band: 'hot',
      countPerMonth: scenario.countPerMonth,
      monthlyKg: scenario.countPerMonth * 20,
      seedKg: scenario.seedKg,
      treeCategory: '场景类',
      scenario: true,
      key: scenario.key,
      // 场景 SKU 只在历史里出库、窗口期内不出库：在仓恒为 seedKg，剧本里的数字才核对得清。
      // 月均条数靠 8~10 月的历史销量撑到热销，需安排才可填、预警才不是「不参与」。
      windowSales: false,
    })
  }

  for (const dirty of DIRTY_SKUS) {
    seq += 1
    skus.push({
      index: seq,
      skuId: dirty.skuId,
      product: dirty.product,
      color: dirty.color,
      unit: dirty.unit,
      rate: dirty.rate,
      kgFactor: dirty.unit === '公斤' ? 1 : null,
      band: 'slow',
      countPerMonth: 0,
      monthlyKg: 0,
      seedKg: dirty.seedKg ?? 0,
      treeCategory: '脏数据',
      scenario: true,
      windowSales: false,
      dirty: true,
      drop: Boolean(dirty.drop),
    })
  }

  const bySkuId = new Map(skus.map((sku) => [sku.skuId, sku]))
  return { skus, bySkuId }
}

/** 事件剧本：day 从 1 开始 */
function buildEvents() {
  const A = '场景A品|1#黑'
  const B = '场景B品|1#黑'
  const C = '场景C品|1#黑'
  const D = '场景D品|1#黑'
  const E = '场景E品|1#黑'
  const F = '场景F品|1#黑'
  return [
    // A：下单 500 → 排单 500 → 入库 500（主流程，预计库存 1500 全程不动）
    { day: 1, type: 'order', skuId: A, kg: 500 },
    { day: 2, type: 'schedule', skuId: A, kg: 500 },
    { day: 3, type: 'inbound', skuId: A, kg: 500, doc: '生产入库' },

    // B：下单 480 → 排单 480 → 分两批入库 240 + 240
    { day: 1, type: 'order', skuId: B, kg: 480 },
    { day: 2, type: 'schedule', skuId: B, kg: 480 },
    { day: 3, type: 'inbound', skuId: B, kg: 240, doc: '生产入库' },
    { day: 4, type: 'inbound', skuId: B, kg: 240, doc: '生产入库' },

    // C：下单 500 → 排单 600（超产）→ 入库 600
    { day: 1, type: 'order', skuId: C, kg: 500 },
    { day: 2, type: 'schedule', skuId: C, kg: 600 },
    { day: 3, type: 'inbound', skuId: C, kg: 600, doc: '生产入库' },

    // D：销售退货入库，只进在仓，不动在途
    { day: 3, type: 'inbound', skuId: D, kg: 100, doc: '销售退货入库' },

    // E：下单 300 后撤销，在途回退
    { day: 1, type: 'order', skuId: E, kg: 300 },
    { day: 2, type: 'revoke', skuId: E },

    // F：排单漏记，D3 直接生产入库，靠 max(下单, 排单) 归零
    { day: 1, type: 'order', skuId: F, kg: 500 },
    { day: 3, type: 'inbound', skuId: F, kg: 500, doc: '生产入库' },

    // 松散品：排单颜色带尾巴，仍并入基准 SKU
    { day: 2, type: 'schedule', skuId: '松散品|1#黑', color: '1#黑-CC', kg: 200 },
    // 排单颜色为空：整行忽略
    { day: 2, type: 'schedule', skuId: '排单空色品|1#黑', color: '', kg: 150 },
  ]
}

/* ---------------------------------------------------------------- */
/* 三、写分表                                                        */
/* ---------------------------------------------------------------- */

const FILE_OF_ROLE = {
  产品资料: '产品资料.xlsx',
  出码率: '出码率.xlsx',
  出入库明细: '出入库明细（销售+加工）.xlsx',
  库存结存表: '库存结存表.xlsx',
  欠货: '欠货订单导出.xlsx',
  生产排单: 'productionScheduling.xlsx',
}

const DETAIL_HEADER = ['做账日期', '单号', '来源单据', '品名', '颜色', '单位', '入库条数', '入库数量', '出库条数', '出库数量', '客户']
const SCHEDULE_HEADER = ['缸号', '生产卡号', '下单日期', '进仓日期', '染厂名称', '品名', '天鸿颜色', '进仓重量', '时长', '货期程度']

function writeSheet(dir, fileName, header, rows) {
  mkdirSync(dir, { recursive: true })
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet')
  XLSX.writeFile(book, join(dir, fileName))
}

/** kg → SKU 自己的数量单位（码要乘出码率） */
function toUnits(kg, sku) {
  if (!(kg > 0)) return 0
  const factor = Number(sku.kgFactor)
  if (!(factor > 0)) return 0
  return Math.max(1, Math.round(kg / factor))
}

/** 造 D 天的文件；返回逐日时间线 */
function buildTimeline({ catalog, events, days, outDir }) {
  const warehouse = new Map(catalog.skus.map((sku) => [sku.skuId, toUnits(sku.seedKg, sku)]))
  const detailRows = [] // { serial, day, cells }；day = 0 表示窗口期之前的历史
  const scheduleRows = []
  const timeline = []
  let detailSeq = 0

  const pushDetail = (serial, day, sku, cells) => {
    detailRows.push({ serial, day, sku, cells })
  }
  // 每 11 个 SKU 留一个「只有一个客户」的专属品（模式名会带「专属品」、不参与备货），其余轮换客户；
  // 场景 SKU 必须参与备货计算，固定多客户。
  const singleCustomer = (sku) => !sku.scenario && sku.index % 11 === 0
  const customerOf = (sku, seq) =>
    CUSTOMERS[(sku.index + (singleCustomer(sku) ? 0 : seq)) % CUSTOMERS.length]
  const salesCells = (sku, serial, units) => {
    detailSeq += 1
    return [
      serial,
      `XS-${String(detailSeq).padStart(6, '0')}`,
      '销售单',
      sku.product,
      sku.color,
      sku.unit,
      0,
      0,
      0,
      units,
      customerOf(sku, detailSeq),
    ]
  }

  const windowSerials = Array.from({ length: days }, (_, offset) =>
    excelSerial(BASE_YEAR, BASE_MONTH, WINDOW_FIRST_DAY + offset),
  )
  const historyFirstSerial = excelSerial(HISTORY_FIRST.year, HISTORY_FIRST.month, HISTORY_FIRST.day)
  const historyLastSerial = windowSerials[0] - 1
  const historyDays = historyLastSerial - historyFirstSerial + 1
  // 「动销月份」按自然月计数：历史 8/1~10/24 + 窗口 10/25~10/31 = 3 个自然月、92 天。
  // 月均条数 = 累积条数 ÷ 3，所以总出库量要按 3 个自然月摊，才正好落回 MODE_BANDS 的目标值。
  const horizonMonths =
    BASE_YEAR * 12 + BASE_MONTH - (HISTORY_FIRST.year * 12 + HISTORY_FIRST.month) + 1

  // 1) 历史出库：每个 SKU 若干笔大单铺满 8/1~10/24，撑起月均条数与加权月销量。
  //    历史行不扣在仓：库存结存表是窗口期第一天的期初，真实导出本来也跟累计出库对不上。
  const windowRowsByDay = new Map(Array.from({ length: days }, (_, offset) => [offset + 1, []]))
  for (const sku of catalog.skus) {
    if (!(sku.countPerMonth > 0)) continue
    const totalUnits = Math.max(1, Math.round((sku.monthlyKg * horizonMonths) / sku.kgFactor))
    const windowUnits = sku.windowSales ? Math.round(totalUnits * WINDOW_SALES_SHARE) : 0
    const historyUnits = totalUnits - windowUnits

    const rowCount = Math.max(1, Math.min(HISTORY_ROWS, historyUnits))
    for (let i = 0; i < rowCount; i += 1) {
      const units = Math.floor(historyUnits / rowCount) + (i < historyUnits % rowCount ? 1 : 0)
      if (units <= 0) continue
      const serial =
        rowCount === 1
          ? historyLastSerial
          : historyFirstSerial + Math.round(((historyDays - 1) * i) / (rowCount - 1))
      pushDetail(serial, 0, sku, salesCells(sku, serial, units))
    }

    if (windowUnits <= 0) continue
    // 窗口期再出两笔（第 2~4 天与第 5~6 天），前一笔占六成
    const firstUnits = Math.round(windowUnits * 0.6)
    const buckets = [
      [Math.min(days, 2 + (sku.index % 3)), firstUnits],
      [Math.min(days, 5 + (sku.index % 2)), windowUnits - firstUnits],
    ]
    for (const [day, units] of buckets) {
      if (units > 0) windowRowsByDay.get(day).push({ sku, units })
    }
  }

  for (let day = 1; day <= days; day += 1) {
    const serial = windowSerials[day - 1]

    // 1) 窗口期日常出库（场景 SKU 只在历史里出库，这里不会出现）
    for (const entry of windowRowsByDay.get(day) ?? []) {
      pushDetail(serial, day, entry.sku, salesCells(entry.sku, serial, entry.units))
      warehouse.set(entry.sku.skuId, warehouse.get(entry.sku.skuId) - entry.units)
    }

    // 2) 当天的排单 / 入库事件（写入的是累计流水）
    for (const event of events) {
      if (event.day !== day) continue
      const sku = catalog.bySkuId.get(event.skuId)
      if (!sku) throw new Error(`未知 SKU：${event.skuId}`)
      if (event.type === 'schedule') {
        scheduleRows.push([
          `GH-${String(scheduleRows.length + 1).padStart(4, '0')}`,
          '',
          serial,
          serial + 20,
          '连江治建霞',
          sku.product,
          event.color ?? sku.color,
          event.kg,
          '30天',
          '',
        ])
      } else if (event.type === 'inbound') {
        detailSeq += 1
        pushDetail(serial, day, sku, [
          serial,
          `RK-${String(day).padStart(2, '0')}-${String(detailSeq).padStart(6, '0')}`,
          event.doc,
          sku.product,
          sku.color,
          sku.unit,
          0,
          toUnits(event.kg, sku),
          0,
          0,
          '',
        ])
        warehouse.set(sku.skuId, warehouse.get(sku.skuId) + toUnits(event.kg, sku))
      }
    }

    // 3) 落盘：当天「截止今天」的六张表
    const dir = join(outDir, `day-${String(day).padStart(2, '0')}`)
    const baseRows = catalog.skus.map((sku) => [sku.product, sku.color, sku.unit, sku.treeCategory])
    writeSheet(dir, FILE_OF_ROLE['产品资料'], ['品名', '颜色', '单位', '树形分类'], baseRows)

    const rateByProduct = new Map()
    for (const sku of catalog.skus) {
      if (sku.rate) rateByProduct.set(sku.product, sku.rate)
    }
    writeSheet(
      dir,
      FILE_OF_ROLE['出码率'],
      ['品名', '出码率'],
      [...rateByProduct.entries()].map(([product, rate]) => [product, rate]),
    )

    const detailOfDay = detailRows
      .filter((row) => row.day === 0 || row.day <= day)
      .sort((a, b) => a.serial - b.serial)
      .map((row) => row.cells)
    writeSheet(dir, FILE_OF_ROLE['出入库明细'], DETAIL_HEADER, detailOfDay)
    writeSheet(dir, FILE_OF_ROLE['生产排单'], SCHEDULE_HEADER, scheduleRows)

    const stockRows = catalog.skus
      .filter((sku) => warehouse.has(sku.skuId))
      .map((sku) => [sku.product, sku.color, Math.max(0, warehouse.get(sku.skuId))])
    writeSheet(dir, FILE_OF_ROLE['库存结存表'], ['品名', '颜色', '数量'], stockRows)

    const backorderRows = catalog.skus
      .filter((sku) => sku.index % 17 === 0)
      .map((sku) => [sku.product, sku.color, 5 + (sku.index % 30)])
    writeSheet(dir, FILE_OF_ROLE['欠货'], ['品名', '颜色', '欠货总数量'], backorderRows)

    timeline.push({
      index: day,
      dir,
      events: events.filter((event) => event.day === day),
    })
  }

  return timeline
}

/* ---------------------------------------------------------------- */
/* 四、逐日回放                                                      */
/* ---------------------------------------------------------------- */

async function cleanDay(dir) {
  const readRecords = async (source, fields, handle) => {
    const fileName = FILE_OF_ROLE[source.label]
    if (!fileName) throw new Error(`没有为「${source.label}」配置分表文件`)
    const file = join(dir, fileName)
    if (!existsSync(file)) throw new Error(`缺少分表文件：${fileName}`)
    const book = XLSX.readFile(file)
    const sheet = book.Sheets[book.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' })
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
  return { total: result.tables['总表'], sales: result.tables['销售表'], stats: result.stats }
}

/** 总表 → 库存行（字段名与 src/utils/inventoryApply.js 对齐） */
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
    totalOutbound: at('总出库数量'),
  }
  for (const [name, index] of Object.entries(col)) {
    if (index < 0) throw new Error(`总表缺少列：${name}（${table.columns.join(' / ')}）`)
  }

  return table.rows.map((cells, rowIndex) => {
    const number = (key) => {
      const value = Number(cells[col[key]])
      return Number.isFinite(value) ? value : 0
    }
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
      totalOutbound: number('totalOutbound'),
      planned: null,
    }
  })
}

/** 销售表 → Map<唯一标识, 动销指标>；1-12 月销量（公斤）给模式判定的加权月销量用 */
function buildSalesIndex(salesTable) {
  const at = (name) => salesTable.columns.indexOf(name)
  const keyColumn = at('唯一标识')
  const monthColumns = Array.from({ length: 12 }, (_, index) => at(`${index + 1}月销量`))
  const index = new Map()
  for (const cells of salesTable.rows) {
    const skuId = String(cells[keyColumn] ?? '').trim()
    if (!skuId) continue
    index.set(skuId, {
      orders: Number(cells[at('订单总数')]) || 0,
      cumulativeCount: Number(cells[at('累积条数')]) || 0,
      cumulativeSales: Number(cells[at('累积销量')]) || 0,
      activeMonths: Number(cells[at('动销月份')]) || 0,
      activeCustomers: Number(cells[at('累计客户')]) || 0,
      monthSales: monthColumns.map((column) => (column < 0 ? 0 : Number(cells[column]) || 0)),
    })
  }
  return index
}

function salesRowOf(salesIndex, skuId) {
  return salesIndex.get(skuId) ?? null
}

/**
 * 按时间线回放：导入 → 应用当天订单事件 → 对账 → 算行。
 * @returns {{day:number, rows:Map<string, object>, items:object[], salesIndex:Map<string, object>}[]}
 */
async function replay(timeline, { skipDays = [], evaluator, idempotentDay = null } = {}) {
  const orders = []
  let orderSeq = 0
  let baseline = null
  const records = []

  for (const day of timeline) {
    if (skipDays.includes(day.index)) continue

    const cleaned = await cleanDay(day.dir)
    const items = itemsFromTotalTable(cleaned.total)
    const salesIndex = buildSalesIndex(cleaned.sales)
    if (!baseline) baseline = createInTransitBaseline(items)

    if (idempotentDay === day.index) {
      const again = itemsFromTotalTable((await cleanDay(day.dir)).total)
      const digest = (list) =>
        list
          .map((item) => `${item.skuId}|${item.warehouseStock}|${item.producing}|${item.producedIn}|${item.kgFactor}`)
          .join('\n')
      check(
        `重复导入同一天（D${day.index}）的清洗结果完全一致`,
        digest(items) === digest(again),
        true,
      )
    }

    // 当天的订单事件（导入之后发生，模拟「看完预警再下单」）
    for (const event of day.events) {
      if (event.type === 'order') {
        orderSeq += 1
        orders.push({
          id: `so-${orderSeq}`,
          skuId: event.skuId,
          quantity: event.kg,
          receivedQty: 0,
          status: 'active',
        })
      } else if (event.type === 'revoke') {
        for (let i = orders.length - 1; i >= 0; i -= 1) {
          if (orders[i].skuId === event.skuId && orders[i].status === 'active') {
            orders[i] = { ...orders[i], status: 'cancelled' }
            break
          }
        }
      }
    }

    const orderIndex = buildOrderIndex(orders)
    const orderedTotals = orderedTotalsOf(orderIndex)
    const inTransit = buildInTransitIndex({ items, orderedTotals, baseline })

    const rows = new Map()
    for (const item of items) {
      const snapshot = inTransit.get(item.skuId) ?? reconcileSku({})
      const sales = salesIndex.get(item.skuId) ?? null
      // 与 src/utils/inventoryApply.js 同口径：月均条数 = 累积条数 ÷ 动销月份
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
      const orderEntry = orderIndex.get(item.skuId)
      const row = calculateInventoryRow({
        ...evaluated,
        ...snapshot,
        ordered: orderEntry?.ordered ?? 0,
        received: orderEntry?.received ?? 0,
      })
      rows.set(item.skuId, row)
    }

    records.push({ day: day.index, rows, items, sales: cleaned.sales, salesIndex, inTransit })
  }

  return records
}

/* ---------------------------------------------------------------- */
/* 五、断言                                                          */
/* ---------------------------------------------------------------- */

const failures = []
let checkCount = 0

function check(label, actual, expected, tolerance = 0.01) {
  checkCount += 1
  const ok =
    typeof expected === 'number'
      ? Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance
      : actual === expected
  if (!ok) failures.push(`${label}：期望 ${expected}，实际 ${actual}`)
  return ok
}

const SCENARIO_STEPS = [
  // 主流程：下单 → 排单 → 入库，预计库存不动
  { key: 'A', skuId: '场景A品|1#黑', steps: [
    { day: 1, warehouseKg: 1000, inTransitKg: 500, arrangedKg: 500, producingKg: 0, projectedStock: 1500 },
    { day: 2, warehouseKg: 1000, inTransitKg: 500, arrangedKg: 0, producingKg: 500, projectedStock: 1500 },
    { day: 3, warehouseKg: 1500, inTransitKg: 0, arrangedKg: 0, producingKg: 0, projectedStock: 1500 },
  ] },
  // 部分到货：两批入库
  { key: 'B', skuId: '场景B品|1#黑', steps: [
    { day: 1, warehouseKg: 1000, inTransitKg: 480, arrangedKg: 480, producingKg: 0, projectedStock: 1480 },
    { day: 2, warehouseKg: 1000, inTransitKg: 480, arrangedKg: 0, producingKg: 480, projectedStock: 1480 },
    { day: 3, warehouseKg: 1240, inTransitKg: 240, arrangedKg: 0, producingKg: 240, projectedStock: 1480 },
    { day: 4, warehouseKg: 1480, inTransitKg: 0, arrangedKg: 0, producingKg: 0, projectedStock: 1480 },
  ] },
  // 超产：排单比下单多 100，预计库存随新发现的产量上调一次
  { key: 'C', skuId: '场景C品|1#黑', steps: [
    { day: 1, warehouseKg: 1000, inTransitKg: 500, arrangedKg: 500, producingKg: 0, projectedStock: 1500 },
    { day: 2, warehouseKg: 1000, inTransitKg: 600, arrangedKg: 0, producingKg: 600, projectedStock: 1600 },
    { day: 3, warehouseKg: 1600, inTransitKg: 0, arrangedKg: 0, producingKg: 0, projectedStock: 1600 },
  ] },
  // 退货入库：只增加到仓，不动在途
  { key: 'D', skuId: '场景D品|1#黑', steps: [
    { day: 2, warehouseKg: 500, inTransitKg: 0, projectedStock: 500 },
    { day: 3, warehouseKg: 600, inTransitKg: 0, projectedStock: 600 },
  ] },
  // 下单后撤销：在途回退
  { key: 'E', skuId: '场景E品|1#黑', steps: [
    { day: 1, warehouseKg: 1000, inTransitKg: 300, arrangedKg: 300, projectedStock: 1300 },
    { day: 2, warehouseKg: 1000, inTransitKg: 0, arrangedKg: 0, projectedStock: 1000 },
  ] },
  // 排单漏记，直接入库：base = max(下单, 排单) 兜住
  { key: 'F', skuId: '场景F品|1#黑', steps: [
    { day: 1, warehouseKg: 1000, inTransitKg: 500, arrangedKg: 500, projectedStock: 1500 },
    { day: 2, warehouseKg: 1000, inTransitKg: 500, arrangedKg: 500, projectedStock: 1500 },
    { day: 3, warehouseKg: 1500, inTransitKg: 0, arrangedKg: 0, projectedStock: 1500 },
  ] },
]

function assertScenario(records) {
  const byDay = new Map(records.map((record) => [record.day, record]))

  for (const scenario of SCENARIO_STEPS) {
    for (const step of scenario.steps) {
      const record = byDay.get(step.day)
      if (!record) continue
      const row = record.rows.get(scenario.skuId)
      if (!row) {
        failures.push(`${scenario.key} · D${step.day}：总表里找不到该 SKU`)
        continue
      }
      const label = `${scenario.key} · D${step.day}`
      for (const [key, expected] of Object.entries(step)) {
        if (key === 'day') continue
        check(`${label} · ${key}`, row[key], expected)
      }
    }
  }
}

function assertInvariants(records) {
  for (const record of records) {
    for (const [skuId, row] of record.rows) {
      if (!Number.isFinite(row.inTransitKg)) continue
      check(
        `${skuId} · D${record.day} · 在途 = 已安排 + 生产中`,
        Math.abs(row.arrangedKg + row.producingKg - row.inTransitKg) <= 0.01,
        true,
      )
      check(
        `${skuId} · D${record.day} · 预计库存 = 在仓 + 在途 + 需安排`,
        Math.abs((row.warehouseKg ?? 0) + row.inTransitKg + (Number(row.planned) || 0) - row.projectedStock) <= 0.01,
        true,
      )
      // 理论库存 = 在仓 + 在途：不能再用生产排单的原始累计，否则入库后已到仓的货会被算两遍
      check(
        `${skuId} · D${record.day} · 理论库存 = 在仓 + 在途`,
        Math.abs((row.warehouseKg ?? 0) + row.inTransitKg - row.theoreticalStock) <= 0.01,
        true,
      )
      check(
        `${skuId} · D${record.day} · 在途不为负`,
        row.inTransitKg >= 0 && row.arrangedKg >= 0 && row.producingKg >= 0,
        true,
      )
    }
  }
}

function assertDirtyData(records, catalog) {
  const byDay = new Map(records.map((record) => [record.day, record]))
  const first = records[0]
  const skuIds = new Set(first.items.map((item) => item.skuId))
  check('缺出码率的码单位 SKU 被剔除', skuIds.has('无码率品|1#黑'), false)
  check('按条单位 SKU 被剔除', skuIds.has('按条品|1#黑'), false)

  const dayTwo = byDay.get(2)
  if (dayTwo) {
    check('排单颜色带尾巴「1#黑-CC」并入基准 SKU', dayTwo.rows.get('松散品|1#黑')?.producing, 200)
    check('排单颜色为空的行被忽略', dayTwo.rows.get('排单空色品|1#黑')?.producing, 0)
  }

  // 入库行不能污染销量：场景 A 只有 8~10 月的 10 笔历史出库，D3 那笔生产入库不能算进来
  const scenarioA = catalog.bySkuId.get('场景A品|1#黑')
  const aSales = salesRowOf(first.salesIndex, '场景A品|1#黑')
  check('入库行不算订单（历史出库 10 笔）', aSales?.orders ?? null, HISTORY_ROWS)
  check(
    '入库行不算累积销量（只算历史出库）',
    aSales?.cumulativeSales ?? null,
    scenarioA.monthlyKg * 3,
  )
}

function assertModeMix(records) {
  const last = records[records.length - 1]
  const rows = [...last.rows.values()]
  const participating = rows.filter((row) => row.modeParticipates && !row.excluded)
  const actionable = rows.filter((row) => getSuggestedPlanned(row) > 0)
  const share = participating.length / rows.length
  check(
    `可参与备货的 SKU 占比 ${(share * 100).toFixed(0)}% 落在 20%~50%`,
    share >= 0.2 && share <= 0.5,
    true,
  )
  check(`建议需安排 > 0 的 SKU 不少于 20 个（实际 ${actionable.length}）`, actionable.length >= 20, true)
  check(
    '预警灯覆盖 紧急补货 / 常规补货 / 无需补货 / 降低库存 四档',
    new Set(rows.map((row) => row.urgencyTone)).size >= 4,
    true,
  )

  for (const scenario of SCENARIO_PRODUCTS) {
    const row = last.rows.get(`${scenario.product}|1#黑`)
    check(`场景${scenario.key} 参与备货计算（模式 ${row?.modeName ?? '缺省'}）`, row?.modeParticipates, true)
  }
  const a = last.rows.get('场景A品|1#黑')
  check(`场景A 月均条数 ${a?.monthlyAvgCount} 落在热销区间`, (a?.monthlyAvgCount ?? 0) >= 30, true)
  // 窗口期内不出库：D1 在仓 = 1000，到 D3 那笔生产入库之后才是 1500
  const aDayOne = records[0].rows.get('场景A品|1#黑')
  check('场景A D1 在仓 = 1000（窗口期内不出库）', aDayOne?.warehouseKg, 1000)
  check('场景A 建议需安排可算（不是不参与导致的 0 口径）', aDayOne?.strategyAvailable, true)
}

function assertSkipDay(records) {
  // 只回放 D1 与 D3：到仓按累计差分一次补齐
  const dayThree = records.find((record) => record.day === 3)
  if (!dayThree) {
    failures.push('跳天回放：缺少 D3')
    return
  }
  const row = dayThree.rows.get('场景A品|1#黑')
  check('跳天回放 · A 在仓', row?.warehouseKg, 1500)
  check('跳天回放 · A 在途', row?.inTransitKg, 0)
  check('跳天回放 · A 预计库存', row?.projectedStock, 1500)
}

/* ---------------------------------------------------------------- */
/* 六、主流程                                                        */
/* ---------------------------------------------------------------- */

function printScenarioTable(records) {
  const header = ['日', 'SKU', '在仓', '已安排', '生产中', '在途', '预计库存']
  console.log(`\n${header.join('\t')}`)
  for (const record of records) {
    for (const scenario of SCENARIO_STEPS) {
      const row = record.rows.get(scenario.skuId)
      if (!row) continue
      console.log(
        [
          `D${record.day}`,
          scenario.key,
          Math.round(row.warehouseKg ?? 0),
          Math.round(row.arrangedKg ?? 0),
          Math.round(row.producingKg ?? 0),
          Math.round(row.inTransitKg ?? 0),
          Math.round(row.projectedStock ?? 0),
        ].join('\t'),
      )
    }
  }
}

function printModeSummary(records) {
  const last = records[records.length - 1]
  const counts = new Map()
  const tones = new Map()
  let actionable = 0
  for (const row of last.rows.values()) {
    const label = row.excluded ? `${row.modeName}·不参与` : row.modeName
    counts.set(label, (counts.get(label) ?? 0) + 1)
    tones.set(row.urgencyText, (tones.get(row.urgencyText) ?? 0) + 1)
    if (getSuggestedPlanned(row) > 0) actionable += 1
  }
  console.log(
    `\n模式分布：${[...counts.entries()].map(([label, count]) => `${label} ${count}`).join(' / ')}`,
  )
  console.log(
    `预警分布：${[...tones.entries()].map(([label, count]) => `${label} ${count}`).join(' / ')}`,
  )
  console.log(`建议需安排 > 0 的 SKU：${actionable} 个`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const catalog = buildCatalog(options.skus)
  const events = buildEvents()
  // --no-files 也要落盘：回放走的是真实的清洗引擎，它只认磁盘上的 xlsx。
  // 所以落到一个临时目录，跑完删掉，效果等同于「只在内存里回放」。
  const outDir = options.out
    ? resolve(process.cwd(), options.out)
    : options.files
      ? DEFAULT_OUT_DIR
      : join(HERE, 'output', '.rolling-sim-tmp')

  // 只清 day-* 子目录：输出目录里还可能躺着说明文档（docs/测试数据/…/README.md）
  if (!options.keep && existsSync(outDir)) {
    for (let day = 1; day <= 99; day += 1) {
      const dir = join(outDir, `day-${String(day).padStart(2, '0')}`)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }
  const timeline = buildTimeline({ catalog, events, days: options.days, outDir })

  console.log(
    `造数：${catalog.skus.length} 个 SKU（含 ${SCENARIO_PRODUCTS.length} 个场景 / ${DIRTY_SKUS.length} 个脏数据）× ${options.days} 天`,
  )
  console.log(`分表目录：${options.files ? outDir : '（临时目录，跑完删除）'}`)

  const evaluator = createEvaluator(createDefaultConfig(), { baselineMonth: null })

  const records = await replay(timeline, { evaluator, idempotentDay: 2 })
  printScenarioTable(records)
  printModeSummary(records)
  assertScenario(records)
  assertInvariants(records)
  assertDirtyData(records, catalog)
  assertModeMix(records)

  const skipRecords = await replay(timeline, { evaluator, skipDays: [2] })
  assertSkipDay(skipRecords)

  const last = records[records.length - 1]
  const stillInTransit = last.items
    .map((item) => ({ skuId: item.skuId, kg: last.rows.get(item.skuId)?.inTransitKg ?? 0 }))
    .filter((entry) => entry.kg > 0)
  console.log(
    `\n最后一天：${last.items.length} 个 SKU，${stillInTransit.length} 个仍在途` +
      (stillInTransit.length
        ? `（${stillInTransit.map((entry) => `${entry.skuId} ${Math.round(entry.kg)}kg`).join('、')}）`
        : ''),
  )
  console.log(`断言：${checkCount} 项`)

  if (!options.files) rmSync(outDir, { recursive: true, force: true })

  if (failures.length) {
    console.error(`\n✗ 回放未通过（${failures.length} 项）：`)
    for (const failure of failures.slice(0, 40)) console.error(`  · ${failure}`)
    if (failures.length > 40) console.error(`  · ……还有 ${failures.length - 40} 项`)
    process.exitCode = 1
    return
  }
  console.log('\n✓ 回放全部通过：状态迁移期间预计库存不跳动，在途 = 已安排 + 生产中')
}

await main()
