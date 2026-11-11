/**
 * 分表清洗合并引擎（唯一事实来源）
 * ==================================================================
 * 以【产品资料】为 SKU 全集，按唯一标识左连接出入库明细、库存结存表、欠货、生产排单，
 * 产出「总表」与「销售表」两张表。
 *
 * ★ 改清洗逻辑就改这个文件，全项目只有这一份。
 * 这里只放「口径」：配置、唯一标识、汇总、关联、宽松合并。文件怎么读由调用方注入 readRecords：
 *   · 网页   src/utils/cleanMerge.js（经 src/cleaning/engine.js 转发）→ fflate 流式解析
 *   · 脚本   tools/cleaning/clean-merge.js                          → SheetJS + fs
 * 本文件不 import 任何模块，所以 Node 脚本能直接 import 它，Vite 也能正常打包。
 */

/* ================================================================
 * 一、配置
 * ================================================================ */

const CONFIG = {
  // 所有表的唯一标识都由此拼接；aliases 兼容各表不同的列名写法
  keyFields: [
    { field: '品名', aliases: ['产品名'] },
    { field: '颜色', aliases: ['天鸿颜色'] },
  ],
  // 总表列顺序（唯一标识固定在最左），列了但没有数据源的列整列填 0
  columnOrder: [
    '品名',
    '颜色',
    '色彩',
    '树形分类', // 产品资料里的唯一定位：采购下单按它决定分单人员名单
    '出码率', // 品名维度的「码/公斤」，来自可选的「出码率」表
    '公斤系数', // 每 1 个数量单位 = ? 公斤：码 → 1/出码率，公斤 → 1，其他留空
    '生产中', // 暂无数据源（排单导出缺生产状态列）
    '欠货',
    '周销量', // 月均销量（公斤）÷ 4
    '周转入', // 暂无数据源（出入库明细无周转入单据）
    '在途库存',
    '在仓库存',
    '总出库数量',
  ],
}

/** 唯一标识含这些词即算「黑白」，其余算「彩色」 */
const MONOCHROME_WORDS = ['本白', '大白', '黑白', '黑色']

/** 能否换算成公斤：公斤单位直接可用，码单位必须带出码率；条/件/米/空单位无法换算 */
function isKilogramConvertible(row) {
  const unit = cellText(row['单位'])
  if (unit === '公斤') return true
  if (unit === '码') return toNumber(row['出码率']) > 0
  return false
}

/** 基准表：决定总表的行集合（左连接主表）。
 *  只保留能换算成公斤的 SKU：公斤单位直接用，码单位必须有出码率，其余（条/件/米/无单位）一律剔除。 */
const BASE = {
  label: '产品资料',
  rowFilter: (row) => isKilogramConvertible(row),
  columns: [
    '品名',
    '颜色',
    { field: '单位', as: '单位' },
    {
      as: '色彩',
      derive: ({ key }) =>
        MONOCHROME_WORDS.some((word) => key.includes(word)) ? '黑白' : '彩色',
    },
    // 树形分类：采购下单据此取分单人员；源表没有该列时整列为空（optional）
    { field: '树形分类', optional: true },
    // 出码率不在产品资料里，由「出码率」表按品名注入（见 runCleaning）
    { as: '出码率', type: 'number' },
    {
      as: '公斤系数',
      derive: ({ values }) => {
        const unit = cellText(values['单位'])
        const rate = toNumber(values['出码率'])
        if (unit === '公斤') return 1
        if (unit === '码' && rate > 0) return Math.round((1 / rate) * 1000000) / 1000000
        return ''
      },
    },
  ],
}

/** 出码率（可选）：品名 → 码/公斤。只用于把「码」换算成「公斤」，不参与关联 */
const RATES = {
  id: 'rates',
  label: '出码率',
  match: ['出码率'],
  optional: true,
  keyFields: [{ field: '品名' }],
  columns: [{ field: '品名' }, { field: '出码率', type: 'number' }],
}

/** 分表：每张表按唯一标识并入总表 */
const JOINS = [
  {
    label: '出入库明细',
    // 出库数量=0 的行是退货/纯入库，不算订单、也不算动销月份
    rowFilter: (row) => toNumber(row['出库数量']) > 0,
    columns: [
      { field: '出库数量', as: '总出库数量' },
      // 累积条数 = 总出库数量 ÷ 单位换算系数（码→100、公斤→20；件/条等无规则的记 0），只用于判定模式与 SPU 展示
      {
        field: '出库数量',
        as: '累积条数',
        divideBy: { field: '单位', map: { 码: 100, 公斤: 20 } },
        digits: 0,
      },
      // 累积销量 = 全历史出库换算成公斤（码 ÷ 出码率；公斤原值；无出码率的记 0）
      { field: '出库数量', as: '累积销量', toKilogram: true, digits: 2 },
      // 月均销量 = 累积销量 ÷ 动销月份（最长连续动销段）
      { as: '月均销量', divideFrom: { column: '累积销量', byColumn: '动销月份' }, digits: 2 },
      // 周销量 = 月均销量 ÷ 4（一个月按 4 周计）
      { as: '周销量', divideFrom: { column: '月均销量', by: 4 }, digits: 2 },
      { as: '订单总数', agg: 'rows' }, // 1 行 = 1 单
      { field: '做账日期', as: '动销月份', agg: 'months' }, // 最长连续月份数
      // 累计客户 = 该 SKU 的去重客户数；明细表没有客户列时整列按 0 处理（optional）
      { field: '客户', as: '累计客户', agg: 'distinct', optional: true },
      // 客户CR5率 = 销量前 5 的客户占该 SKU 总销量的比例（0~1）；明细表没有客户列时整列按 0 处理
      {
        field: '出库数量',
        as: '客户CR5率',
        agg: 'topShare',
        top: 5,
        customerField: '客户',
        digits: 4,
        optional: true,
      },
    ],
    monthlyColumns: {
      dateField: '做账日期',
      // year 留空：按数据里最新的年份统计月份
      year: null,
      columns: [
        // 月条数：出库数量 ÷ 单位换算系数（码 100 / 公斤 20），只做展示与折线图
        {
          field: '出库数量',
          as: '{月}月条数',
          divideBy: { field: '单位', map: { 码: 100, 公斤: 20 } },
          digits: 0,
        },
        // 月销量（公斤）：码 → 出库码数 ÷ 出码率；公斤 → 原值
        { field: '出库数量', as: '{月}月销量', toKilogram: true, digits: 2 },
        // 该月订单数 = 该月有效行数（1 行 = 1 单，与订单总数同口径）
        { as: '{月}月订单数', agg: 'rows' },
      ],
    },
  },
  {
    label: '库存结存表',
    columns: [{ field: '数量', as: '在仓库存' }],
  },
  {
    label: '欠货',
    mergeSimilarKeys: true, // 颜色尾部多符号/英文的并入基准同一 SKU
    appendUnmatched: true, // 基准里完全没有的欠货 SKU 才追加成新行
    columns: [{ field: '欠货总数量', as: '欠货' }],
  },
  {
    label: '生产排单',
    match: ['Scheduling'],
    skipIncompleteKey: true, // 颜色为空的行无法定位 SKU，忽略
    mergeSimilarKeys: true,
    appendUnmatched: true,
    columns: [{ field: '进仓重量', as: '在途库存' }],
  },
]

/** 输出两张表：「{按月}」展开成全部按月列 */
export const MONTHLY_TOKEN = '{按月}'

/** 输出表配置：sheet 名 + 输出文件名（脚本用）+ 列（{按月} 展开成全部按月列） */
export const OUTPUTS = [
  {
    sheet: '总表',
    file: '总表_清洗结果.xlsx',
    columns: ['唯一标识', ...CONFIG.columnOrder],
  },
  {
    sheet: '销售表',
    file: '销售表.xlsx',
    columns: [
      '唯一标识',
      '品名',
      '颜色',
      '累计客户', // 出入库明细「客户」列去重计数
      '订单总数',
      '动销月份',
      '累积条数', // 只用于判定模式与 SPU 展示
      '累积销量', // 全历史出库换算成公斤，评分「进销比」的分母
      '客户CR5率', // 出入库明细「客户」列的前 5 名销量占比（0~1）
      MONTHLY_TOKEN, // 每月：条数 + 销量（公斤）+ 订单数
    ],
  },
]

/* ================================================================
 * 二、配置规范化
 * ================================================================ */

function normalizeColumns(columns, role) {
  return (columns || []).map((column) => {
    const isText = typeof column === 'string'
    const raw = isText ? { field: column } : column
    if (raw.derive !== undefined) {
      const field = raw.as ?? raw.field
      return { ...raw, field, as: field, sourceField: null }
    }
    const field = raw.field ?? raw.as
    const as = raw.as ?? raw.field
    // sourceField 只记录源表真实存在的列：周消耗（由月均条数换算）、订单总数（按行数统计）没有源列
    const sourceField = raw.field ?? null
    return role === 'base'
      ? { ...raw, field, as, sourceField, type: raw.type ?? 'text' }
      : { ...raw, field, as, sourceField, agg: raw.agg ?? 'sum' }
  })
}

/** 按月展开列：模板 as 里的 {月} 依次替换成 1..12 */
function expandMonthlyColumns(config, role) {
  if (!config) return []
  const templates = normalizeColumns(config.columns, role)
  const months = config.months ?? 12
  const expanded = []
  for (let month = 1; month <= months; month += 1) {
    for (const template of templates) {
      expanded.push({
        ...template,
        as: template.as.split('{月}').join(String(month)),
        month,
        monthYear: config.year ?? null,
        monthDateField: config.dateField,
      })
    }
  }
  return expanded
}

function normalizeKeyFields(keyFields) {
  return (keyFields || []).map((keyField) => {
    if (typeof keyField === 'string') return { field: keyField, aliases: [] }
    return { ...keyField, aliases: keyField.aliases ?? [] }
  })
}

function normalizeSource(sourceConfig, role) {
  return {
    ...sourceConfig,
    id: sourceConfig.id ?? sourceConfig.label,
    role,
    optional: Boolean(sourceConfig.optional),
    match: sourceConfig.match ?? [sourceConfig.label],
    keyFields: normalizeKeyFields(sourceConfig.keyFields ?? CONFIG.keyFields),
    columns: [
      ...normalizeColumns(sourceConfig.columns, role),
      ...expandMonthlyColumns(sourceConfig.monthlyColumns, role),
    ],
  }
}

/** 合并 BASE / JOINS / 出码率，并在调用时读取，便于运行期增删分表 */
export function normalizeSources() {
  return [
    normalizeSource(BASE, 'base'),
    ...JOINS.map((config) => normalizeSource(config, 'join')),
    normalizeSource(RATES, 'lookup'),
  ]
}

/** 页面用：分表清单（名称、文件关键字、是否基准表、是否可选），与清洗配置同源 */
export function getSplitSourceRoles() {
  return normalizeSources().map((source) => ({
    id: source.id,
    label: source.label,
    isBase: source.role === 'base',
    optional: source.optional,
    role: source.role,
    keywords: source.match,
  }))
}

/* ================================================================
 * 三、通用工具
 * ================================================================ */

/** 单元格文本：空值 → ""，其余转字符串并去除首尾空白（含全角空格） */
export function cellText(value) {
  if (value === null || value === undefined) return ''
  return String(value).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '')
}

/** 数量统一转数字：空值/非数字记 0；"130 KG"、"1,200" 这类文本取开头数字 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const text = cellText(value).replace(/,/g, '')
  if (!text) return 0
  const num = Number(text)
  if (Number.isFinite(num)) return num
  const matched = text.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)
  return matched ? Number(matched[0]) : 0
}

/** 消除浮点累加噪声 */
function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n')
}

function textValue(value) {
  return normalizeNewlines(cellText(value))
}

/** 取唯一标识各段的值：field → aliases 中第一个非空值 */
function keyParts(row, keyFields) {
  return keyFields.map((keyField) => {
    for (const name of [keyField.field, ...keyField.aliases]) {
      const value = textValue(row[name])
      if (value) return value
    }
    return ''
  })
}

/** 生成唯一标识：各段以 | 连接；全部为空返回 ""（合计行/空行） */
function makeKey(row, keyFields) {
  const parts = keyParts(row, keyFields)
  return parts.every((part) => part === '') ? '' : parts.join('|')
}

/** 匹配用的归一化：全角转半角 + 转小写（输出仍用源表原文） */
function normalizeKeyText(key) {
  return key.normalize('NFKC').toLowerCase()
}

const NUMERIC_AGGS = new Set([
  'sum',
  'count',
  'rows',
  'months',
  'min',
  'max',
  'distinct',
  'topShare',
])

function columnDefault(column) {
  if (column.default !== undefined) return column.default
  return NUMERIC_AGGS.has(column.agg || 'sum') ? 0 : ''
}

/** 尾部多出来的部分是否只是符号/英文（不含中文），如 "-CC"、"S"、"（H）" */
function isSuffixDecoration(text) {
  return text.length > 0 && text.length <= 6 && !/[\u4e00-\u9fff]/.test(text)
}

/** 宽松匹配：品名相同、颜色只是基准颜色尾部多出符号/英文时视为同一 SKU */
function findLooseMatch(key, base) {
  const parts = key.split('|')
  if (parts.length < 2) return null
  const candidates = base.looseIndex.get(normalizeKeyText(parts.slice(0, -1).join('|')))
  if (!candidates) return null

  const color = normalizeKeyText(parts[parts.length - 1])
  let best = null
  let ambiguous = false
  for (const candidate of candidates) {
    const tail = normalizeKeyText(candidate.tail)
    if (!tail || color === tail || !color.startsWith(tail)) continue
    if (!isSuffixDecoration(color.slice(tail.length))) continue
    if (!best || candidate.tail.length > best.tail.length) {
      best = candidate
      ambiguous = false
    } else if (candidate.tail.length === best.tail.length && candidate.key !== best.key) {
      ambiguous = true
    }
  }
  return best && !ambiguous ? best.key : null
}

/** 分表主键解析：先按归一化精确匹配基准，再（mergeSimilarKeys 时）尝试宽松匹配 */
function createKeyResolver(base, source) {
  const cache = new Map()

  const resolve = (rawKey) => {
    if (cache.has(rawKey)) return cache.get(rawKey)
    let resolved = base.lookup.get(normalizeKeyText(rawKey)) ?? null
    if (!resolved && source.mergeSimilarKeys) resolved = findLooseMatch(rawKey, base)
    cache.set(rawKey, resolved)
    return resolved
  }

  return { resolve }
}

/** Excel 日期序列号 → { year, month }（epoch 1899-12-30，与 Excel 一致） */
function excelSerialToYearMonth(serial) {
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
  if (Number.isNaN(date.getTime())) return null
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
}

/** 解析日期单元格：支持 Excel 序列号与 "2026-02-25 / 2026年2月" 等文本 */
function toYearMonth(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 59 ? excelSerialToYearMonth(value) : null
  }
  if (value instanceof Date) return { year: value.getFullYear(), month: value.getMonth() + 1 }
  const text = cellText(value)
  if (!text) return null
  const matched = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})/)
  if (matched) return { year: Number(matched[1]), month: Number(matched[2]) }
  const num = Number(text)
  return Number.isFinite(num) && num > 20000 ? excelSerialToYearMonth(num) : null
}

/** 最长连续月份数：月份换算成 年*12+月 后排序，取最长连号段（跨年算连续） */
function longestConsecutiveMonths(indices) {
  const list = [...indices].sort((a, b) => a - b)
  let best = 0
  let run = 0
  let prev = null
  for (const current of list) {
    run = prev !== null && current === prev + 1 ? run + 1 : 1
    if (run > best) best = run
    prev = current
  }
  return best
}

/** 按单位取换算系数（码→100、公斤→20）；未配置的单位返回 null（该 SKU 记 0） */
function resolveDivisor(divideBy, context) {
  const unit = textValue(context && context[divideBy.field])
  const factor = divideBy.map && divideBy.map[unit]
  if (Number.isFinite(factor) && factor !== 0) return factor
  return Number.isFinite(divideBy.default) && divideBy.default !== 0 ? divideBy.default : null
}

/** 把一行出库数量换算成公斤：码 ÷ 出码率；公斤取原值；其他单位无换算关系记 0 */
function toKilogram(row, column) {
  const amount = toNumber(row[column.field])
  if (!amount) return 0
  const unit = textValue(row['单位'])
  if (unit === '公斤') return amount
  if (unit === '码') {
    const rate = toNumber(row['出码率'])
    return rate > 0 ? amount / rate : 0
  }
  return 0
}

function initState(column) {  switch (column.agg || 'sum') {
    case 'concat':
    case 'months':
    case 'distinct':
      return new Set()
    case 'topShare':
      return new Map() // 客户 → 销量合计
    case 'count':
    case 'rows':
    case 'sum':
      return 0
    default:
      return null // min / max / first / last
  }
}

function updateState(column, state, row) {
  const agg = column.agg || 'sum'
  const value = row[column.field]
  switch (agg) {
    case 'sum':
      // 公斤口径：码 ÷ 出码率，公斤取原值，其他单位无换算关系记 0
      if (column.toKilogram) return state + toKilogram(row, column)
      return state + toNumber(value)
    case 'count':
    case 'rows':
      return state + 1
    case 'months': {
      const month = toYearMonth(value)
      if (month) state.add(month.year * 12 + month.month)
      return state
    }
    case 'min': {
      const num = toNumber(value)
      return state === null || num < state ? num : state
    }
    case 'max': {
      const num = toNumber(value)
      return state === null || num > state ? num : state
    }
    case 'concat':
    case 'distinct': {
      const text = textValue(value)
      if (text) state.add(text)
      return state
    }
    // 按客户累加销量，供集中度取前 N 名；没有客户名的行不参与
    case 'topShare': {
      const customer = textValue(row[column.customerField])
      const amount = toNumber(value)
      if (!customer || !(amount > 0)) return state
      state.set(customer, (state.get(customer) || 0) + amount)
      return state
    }
    case 'last': {
      const text = textValue(value)
      return text ? value : state
    }
    case 'first':
    default: {
      const text = textValue(value)
      if (!text) return state
      // 数字单元格保留数字类型，避免单价等列被写成文本
      return state === null || state === '' ? (typeof value === 'number' ? value : text) : state
    }
  }
}

function finalizeState(column, state, context) {
  switch (column.agg || 'sum') {
    case 'concat':
      return [...state].join(column.separator || '、')
    case 'distinct':
      return state.size
    // 集中度：销量前 N 名客户合计 ÷ 总销量，四舍五入到 digits 位
    case 'topShare': {
      if (!state.size) return columnDefault(column)
      const amounts = [...state.values()].sort((a, b) => b - a)
      const total = amounts.reduce((sum, amount) => sum + amount, 0)
      if (!(total > 0)) return columnDefault(column)
      const top = Math.max(1, column.top ?? 5)
      const share =
        amounts.slice(0, top).reduce((sum, amount) => sum + amount, 0) / total
      return round(share, column.digits ?? 4)
    }
    case 'months':
      return longestConsecutiveMonths(state)
    case 'sum': {
      const digits = column.digits ?? 6
      if (!column.divideBy) return round(state, digits)
      const divisor = resolveDivisor(column.divideBy, context)
      return divisor === null ? 0 : round(state / divisor, digits)
    }
    case 'count':
    case 'rows':
      return state
    case 'min':
    case 'max':
      return state === null ? columnDefault(column) : round(state)
    default:
      return state === null ? columnDefault(column) : state
  }
}

/* ================================================================
 * 四、读取：按行流式解析，只保留用到的列
 * ================================================================ */

/** 数据源真正要读的列（主键、汇总列、换算依据列、日期列） */
function sourceFields(source) {
  const fields = new Set()
  for (const keyField of source.keyFields) {
    fields.add(keyField.field)
    for (const alias of keyField.aliases) fields.add(alias)
  }
  for (const column of source.columns) {
    if (column.sourceField) fields.add(column.sourceField)
    if (column.customerField) fields.add(column.customerField)
    if (column.divideBy?.field) fields.add(column.divideBy.field)
    if (column.onlyUnits?.field) fields.add(column.onlyUnits.field)
    if (column.monthDateField) fields.add(column.monthDateField)
  }
  return [...fields]
}

/**
 * 校验表头：主键列与所有配置的取值列都必须存在，缺列直接报错，避免静默算出 0。
 * @param {object} source 规范化后的数据源
 * @param {string[]} labels 表头行的列名（已去空白）
 */
export function assertSourceHeader(source, labels) {
  const present = new Set(labels.map((label) => cellText(label)).filter(Boolean))
  const missing = source.keyFields
    .filter((keyField) => ![keyField.field, ...keyField.aliases].some((name) => present.has(name)))
    .map((keyField) => keyField.field)
  const missingValueColumns = source.columns
    .filter((column) => column.sourceField && !column.optional && !present.has(column.sourceField))
    .map((column) => column.sourceField)
  // 分组/去重依据列（如 客户）同样校验；标记 optional 的列缺失时按 0 处理，不报错
  const missingGroupColumns = source.columns
    .filter(
      (column) => column.customerField && !column.optional && !present.has(column.customerField),
    )
    .map((column) => column.customerField)
  const problems = [...new Set([...missing, ...missingValueColumns, ...missingGroupColumns])]
  if (problems.length) {
    throw new Error(
      `「${source.label}」表头缺少列：${problems.join('、')}，请确认第一行是表头且列名未改动`,
    )
  }
}

/**
 * 把一张分表读成记录流。由调用方注入：页面用 fflate 流式解析，脚本用 SheetJS。
 * @callback readRecords
 * @param {object} source 规范化后的数据源配置
 * @param {string[]} fields 需要读取的列名（主键、汇总列、换算依据列、日期列）
 * @param {(record: object) => void} handle 每读到一行有效数据回调一次
 * @param {(ratio: number) => void} [onProgress] 解析进度（0-1）
 * @returns {Promise<{sheetName?: string}>}
 */

/* ================================================================
 * 五、汇总与关联
 * ================================================================ */

/** 基准表：按唯一标识去重，保留首次出现行 */
function createBaseBuilder(source) {
  const keys = []
  const index = new Map()
  const lookup = new Map()
  const looseIndex = new Map()
  let duplicatedRows = 0
  let skippedRows = 0

  const add = (row) => {
    const key = makeKey(row, source.keyFields)
    if (!key) return
    if (source.rowFilter && !source.rowFilter(row)) {
      // 例如缺出码率的「码」单位 SKU：无法换算成公斤，直接从基准里剔除
      skippedRows += 1
      return
    }
    if (index.has(key)) {
      duplicatedRows += 1
      return
    }
    const normalized = normalizeKeyText(key)
    if (!lookup.has(normalized)) lookup.set(normalized, key)

    const values = {}
    for (const column of source.columns) {
      if (column.derive) {
        values[column.as] = cellText(column.derive({ key, values }))
        continue
      }
      values[column.as] =
        column.type === 'number' ? toNumber(row[column.field]) : textValue(row[column.field])
    }
    index.set(key, values)
    keys.push(key)
  }

  const finish = () => {
    for (const key of keys) {
      const parts = key.split('|')
      if (parts.length < 2) continue
      const prefix = normalizeKeyText(parts.slice(0, -1).join('|'))
      if (!looseIndex.has(prefix)) looseIndex.set(prefix, [])
      looseIndex.get(prefix).push({ key, tail: parts[parts.length - 1] })
    }
    return { keys, index, lookup, looseIndex, duplicatedRows, skippedRows }
  }

  return { add, finish }
}

/** 分表：按唯一标识分组汇总 */
function createAggregator(source, base) {
  const resolver = createKeyResolver(base, source)
  const stateColumns = source.columns.filter((column) => !column.divideFrom)
  const divideFields = [
    ...new Set(source.columns.filter((column) => column.divideBy).map((column) => column.divideBy.field)),
  ]
  const states = new Map()
  const contexts = new Map() // key → { 换算依据列名: 值 }，供 divideBy 使用
  const monthlyDateField = source.monthlyColumns?.dateField ?? null
  let monthlyYear = source.monthlyColumns?.year ?? null
  let incompleteRows = 0

  const add = (row) => {
    if (source.rowFilter && !source.rowFilter(row)) return
    const parts = keyParts(row, source.keyFields)
    if (parts.every((part) => part === '')) return // 合计行 / 空行
    if (source.skipIncompleteKey && parts.some((part) => part === '')) {
      incompleteRows += 1 // 例如颜色为空，无法定位到 SKU，按配置忽略
      return
    }

    const rawKey = parts.join('|')
    const key = resolver.resolve(rawKey) || rawKey // 已对上基准的用基准标识归集

    let current = states.get(key)
    if (!current) {
      current = stateColumns.map((column) => initState(column))
      states.set(key, current)
    }

    let month = null // 按月列只统计该月份的记录
    if (monthlyDateField) {
      const parsed = toYearMonth(row[monthlyDateField])
      month = parsed && (monthlyYear === null || parsed.year === monthlyYear) ? parsed.month : null
    }

    stateColumns.forEach((column, i) => {
      if (column.month !== undefined && column.month !== month) return
      if (column.onlyUnits && !column.onlyUnits.include.includes(textValue(row[column.onlyUnits.field]))) {
        return
      }
      current[i] = updateState(column, current[i], row)
    })

    if (divideFields.length) {
      let context = contexts.get(key)
      if (!context) {
        context = {}
        contexts.set(key, context)
      }
      for (const name of divideFields) {
        if (!context[name]) context[name] = textValue(row[name]) // 同一 SKU 取第一个非空单位
      }
    }
  }

  const finish = () => {
    const summary = new Map()
    for (const [key, current] of states) {
      const values = {}
      stateColumns.forEach((column, i) => {
        values[column.as] = finalizeState(column, current[i], contexts.get(key))
      })
      // 由同表其它列换算出来的列（如 周消耗 = 月均条数 ÷ 4，月均条数 = 累积条数 ÷ 动销月份）
      for (const column of source.columns) {
        if (!column.divideFrom) continue
        const from = Number(values[column.divideFrom.column]) || 0
        const byColumn = column.divideFrom.byColumn
        const by = byColumn ? Number(values[byColumn]) || 0 : Number(column.divideFrom.by)
        values[column.as] = by ? round(from / by, column.digits ?? 6) : 0
      }
      summary.set(key, values)
    }
    return { summary, incompleteRows }
  }

  return {
    add,
    finish,
    needsYear: () => Boolean(monthlyDateField) && monthlyYear === null,
    setMonthlyYear: (year) => {
      monthlyYear = year
    },
  }
}

/** 以基准表为全集左连接所有分表；未匹配且 appendUnmatched 的分表 SKU 追加为最后的新行 */
function joinSources(base, baseColumns, joins, columnOrder) {
  const joinColumn = new Map() // 列名 → { entry, column }
  const summaryOf = new Map() // entry → 汇总结果
  for (const { entry, summary } of joins) {
    summaryOf.set(entry, summary)
    for (const column of entry.source.columns) joinColumn.set(column.as, { entry, column })
  }

  const buildLine = (key, baseValues, lookup) => {
    const line = [key]
    for (const name of columnOrder) {
      if (Object.prototype.hasOwnProperty.call(baseValues, name)) {
        line.push(baseValues[name])
        continue
      }
      const target = joinColumn.get(name)
      if (!target) {
        line.push(0) // 该列暂时没有数据源（如 生产中 / 周转入）
        continue
      }
      const values = lookup(target, name)
      line.push(values === undefined ? columnDefault(target.column) : values)
    }
    return line
  }

  const rows = []
  for (const key of base.keys) {
    const baseValues = base.index.get(key)
    rows.push(
      buildLine(key, baseValues, (target, name) => {
        const values = summaryOf.get(target.entry).get(key)
        return values ? values[name] : undefined
      }),
    )
  }

  // 基准里没有的 SKU：只对配置了 appendUnmatched 的分表追加新行
  const extras = new Map() // 归一化标识 → { key, entry }
  const normalizedValues = new Map() // entry → Map(归一化标识 → 汇总值)
  for (const { entry, summary } of joins) {
    const map = new Map()
    for (const [key, values] of summary) map.set(normalizeKeyText(key), values)
    normalizedValues.set(entry, map)
  }

  for (const { entry, summary } of joins) {
    if (!entry.source.appendUnmatched) continue
    for (const key of summary.keys()) {
      if (base.index.has(key)) continue
      const normalized = normalizeKeyText(key)
      if (!extras.has(normalized)) extras.set(normalized, { key, entry })
    }
  }

  for (const [normalized, { key, entry }] of extras) {
    const parts = key.split('|')
    const baseValues = {}
    for (const column of baseColumns) {
      if (column.derive) {
        baseValues[column.as] = textValue(column.derive({ key, values: baseValues }))
        continue
      }
      // 基准列若是主键的一部分（品名/颜色），用该分表里的原文
      const index = entry.source.keyFields.findIndex(
        (keyField) => keyField.field === column.as || keyField.aliases.includes(column.as),
      )
      baseValues[column.as] =
        index >= 0 ? textValue(parts[index]) : column.type === 'number' ? 0 : ''
    }
    rows.push(
      buildLine(key, baseValues, (target, name) => {
        const values = normalizedValues.get(target.entry).get(normalized)
        return values ? values[name] : undefined
      }),
    )
  }

  return rows
}

/* ================================================================
 * 六、主流程
 * ================================================================ */

function clampRatio(value) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/**
 * 执行一次分表清洗，返回总表与销售表（含表头的数据行）。
 * @param {object} options
 * @param {readRecords} options.readRecords 读取一张分表为记录流（页面用流式解析，脚本用 SheetJS）
 * @param {(progress: {percent: number, sourceId: string, sourcePercent: number, message: string}) => void} [options.onProgress]
 *   percent 是整轮清洗的进度；sourceId / sourcePercent 是当前这张分表自己的进度，供界面按行显示进度条
 * @returns {Promise<{tables: Record<string, {columns: string[], rows: Array<Array>}>, stats: object}>}
 */
export async function runCleaning({ readRecords, onProgress } = {}) {
  if (typeof readRecords !== 'function') throw new Error('runCleaning 需要传入 readRecords')
  const sources = normalizeSources()
  const baseSource = sources.find((source) => source.role === 'base')
  const lookupSourcesList = sources.filter((source) => source.role === 'lookup')
  const joinSourcesList = sources.filter((source) => source.role === 'join')
  const totalSteps = sources.length
  let step = 0

  const report = (source, ratio, message) =>
    onProgress?.({
      percent: Math.round(Math.min(1, (step + clampRatio(ratio)) / totalSteps) * 100),
      sourceId: source?.id ?? '',
      sourcePercent: Math.round(clampRatio(ratio) * 100),
      message,
    })

  // 0. 出码率（可选）：品名 → 码/公斤。缺失时所有「码」单位的重量类字段记 0
  const ratesByProduct = new Map()
  for (const source of lookupSourcesList) {
    await readRecords(
      source,
      sourceFields(source),
      (row) => {
        const name = normalizeKeyText(cellText(row['品名']))
        const rate = toNumber(row['出码率'])
        if (name && rate > 0) ratesByProduct.set(name, rate)
      },
      (ratio) => report(source, ratio, `读取 ${source.label}`),
    )
    step += 1
  }

  // 读表时按品名注入出码率：产品资料与出入库明细都要用它把「码」换算成公斤
  const readWithRate = (source, fields, handle, onProgressOfSource) => {
    if (source.role === 'lookup') return readRecords(source, fields, handle, onProgressOfSource)
    return readRecords(
      source,
      fields,
      (row) => {
        const name = normalizeKeyText(cellText(row['品名'] ?? row['产品名']))
        row['出码率'] = ratesByProduct.get(name) ?? null
        handle(row)
      },
      onProgressOfSource,
    )
  }

  // 1. 基准表：决定总表的行集合
  const baseBuilder = createBaseBuilder(baseSource)
  await readWithRate(
    baseSource,
    sourceFields(baseSource),
    baseBuilder.add,
    (ratio) => report(baseSource, ratio, `读取 ${baseSource.label}`),
  )
  const base = baseBuilder.finish()
  step += 1

  // 2. 分表：逐张按唯一标识汇总
  const joins = []
  const joinStats = []
  for (const source of joinSourcesList) {
    const aggregator = createAggregator(source, base)
    const prescan = aggregator.needsYear()
    const startRatio = prescan ? 0.45 : 0
    let monthlyYear = null

    if (prescan) {
      const dateField = source.monthlyColumns.dateField
      await readWithRate(
        source,
        [dateField],
        (row) => {
          const parsed = toYearMonth(row[dateField])
          if (parsed && (monthlyYear === null || parsed.year > monthlyYear)) monthlyYear = parsed.year
        },
        (ratio) => report(source, ratio * startRatio, `识别 ${source.label} 的统计年份`),
      )
      aggregator.setMonthlyYear(monthlyYear)
    }

    await readWithRate(
      source,
      sourceFields(source),
      aggregator.add,
      (ratio) => report(source, startRatio + ratio * (1 - startRatio), `汇总 ${source.label}`),
    )
    const result = aggregator.finish()
    let unmatchedKeys = 0
    for (const key of result.summary.keys()) {
      if (!base.index.has(key)) unmatchedKeys += 1
    }
    joins.push({ entry: { source }, summary: result.summary })
    joinStats.push({
      label: source.label,
      keyCount: result.summary.size,
      incompleteRows: result.incompleteRows,
      unmatchedKeys,
      monthlyYear: source.monthlyColumns ? monthlyYear : null,
    })
    step += 1
  }

  // 3. 关联成一张宽表，再按输出配置拆成总表 / 销售表
  const monthlyNames = joins.flatMap(({ entry }) =>
    entry.source.columns.filter((column) => column.month !== undefined).map((column) => column.as),
  )
  const resolvedOutputs = OUTPUTS.map((output) => ({
    sheet: output.sheet,
    columns: output.columns.flatMap((name) => (name === MONTHLY_TOKEN ? monthlyNames : [name])),
  }))
  const columnOrder = []
  for (const name of [
    ...CONFIG.columnOrder,
    ...monthlyNames,
    ...resolvedOutputs.flatMap((output) => output.columns),
  ]) {
    if (name !== '唯一标识' && !columnOrder.includes(name)) columnOrder.push(name)
  }

  report(null, 1, '按唯一标识关联总表')
  const header = ['唯一标识', ...columnOrder]
  const lines = joinSources(base, baseSource.columns, joins, columnOrder)

  // 兜底：欠货 / 生产排单会追加基准里没有的 SKU，无法换算成公斤的一并剔除，
  // 保证总表里每一行都能算出公斤（公斤单位或带出码率的码单位）。
  const factorAt = header.indexOf('公斤系数')
  let appendedDropped = 0
  const keptLines =
    factorAt < 0
      ? lines
      : lines.filter((line) => {
          const convertible = cellText(line[factorAt]) !== ''
          if (!convertible) appendedDropped += 1
          return convertible
        })

  const tables = {}
  for (const output of resolvedOutputs) {
    const indexes = output.columns.map((name) => {
      const at = header.indexOf(name)
      if (at < 0) throw new Error(`输出列「${name}」不存在，请检查清洗配置`)
      return at
    })
    tables[output.sheet] = {
      columns: output.columns,
      rows: keptLines.map((line) => indexes.map((at) => line[at])),
    }
  }

  // 被剔除的 SKU 都发生在基准阶段（追加行另有 appendedDropped 兜底）
  const missingRateSkuCount = base.skippedRows

  return {
    tables,
    stats: {
      rowCount: keptLines.length,
      base: {
        label: baseSource.label,
        keyCount: base.keys.length,
        duplicatedRows: base.duplicatedRows,
        // 因无法换算成公斤（缺出码率的码单位、条/件/米等）被剔除的 SKU
        skippedRows: base.skippedRows,
      },
      joins: joinStats,
      // 基准里没有、被追加成新行的 SKU 数量
      appendedRows: keptLines.length - base.keys.length,
      // 追加行里因为无法换算成公斤又被剔除的数量
      appendedDropped,
      // 出码率：命中品名数 + 需要换算但没有出码率的 SKU 数
      rates: { productCount: ratesByProduct.size, missingSkuCount: missingRateSkuCount },
    },
  }
}
