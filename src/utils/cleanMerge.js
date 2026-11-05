import { streamSheetRows } from './xlsxStream'

/**
 * 分表清洗合并（clean-merge.js 的浏览器版）
 * ==================================================================
 * 业务规则与 数据清洗/clean-merge.js 保持一致：以【产品资料】为 SKU 全集，
 * 按唯一标识左连接出入库明细、库存结存表、欠货、生产排单，产出「总表」与「销售表」两张表。
 * 差异只在于读取方式：分表文件由页面选择，按行流式解析，不再落地 output/ 目录。
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
    '生产中', // 暂无数据源（排单导出缺生产状态列）
    '欠货',
    '周消耗', // 由「月均条数 ÷ 4」算出，月均条数本身只进销售表
    '周转入', // 暂无数据源（出入库明细无周转入单据）
    '在途库存',
    '在仓库存',
    '总出库数量',
  ],
}

/** 唯一标识含这些词即算「黑白」，其余算「彩色」 */
const MONOCHROME_WORDS = ['本白', '大白', '黑白', '黑色']

/** 基准表：决定总表的行集合（左连接主表） */
const BASE = {
  label: '产品资料',
  columns: [
    '品名',
    '颜色',
    {
      as: '色彩',
      derive: ({ key }) =>
        MONOCHROME_WORDS.some((word) => key.includes(word)) ? '黑白' : '彩色',
    },
  ],
}

/** 分表：每张表按唯一标识并入总表 */
const JOINS = [
  {
    label: '出入库明细',
    // 出库数量=0 的行是退货/纯入库，不算订单、也不算动销月份
    rowFilter: (row) => toNumber(row['出库数量']) > 0,
    columns: [
      { field: '出库数量', as: '总出库数量' },
      // 月均条数 = 总出库数量 ÷ 单位换算系数（码→100、公斤→20；件/条等无规则的记 0）
      {
        field: '出库数量',
        as: '月均条数',
        divideBy: { field: '单位', map: { 码: 100, 公斤: 20 } },
        digits: 0,
      },
      { as: '周消耗', divideFrom: { column: '月均条数', by: 4 }, digits: 2 },
      { as: '订单总数', agg: 'rows' }, // 1 行 = 1 单
      { field: '做账日期', as: '动销月份', agg: 'months' }, // 最长连续月份数
    ],
    monthlyColumns: {
      dateField: '做账日期',
      // year 留空：按数据里最新的年份统计月份
      year: null,
      columns: [
        {
          field: '出库数量',
          as: '{月}月条数',
          divideBy: { field: '单位', map: { 码: 100, 公斤: 20 } },
          digits: 0,
        },
        {
          field: '出库数量',
          as: '{月}月重量',
          onlyUnits: { field: '单位', include: ['公斤'] },
          digits: 2,
        },
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
const MONTHLY_TOKEN = '{按月}'

const OUTPUTS = [
  {
    sheet: '总表',
    columns: ['唯一标识', ...CONFIG.columnOrder],
  },
  {
    sheet: '销售表',
    columns: [
      '唯一标识',
      '品名',
      '颜色',
      '月均条数',
      '订单总数',
      '动销月份',
      '动销客户', // 暂无数据源（出入库明细无客户字段）
      MONTHLY_TOKEN,
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
  return (keyFields || []).map((keyField) =>
    typeof keyField === 'string' ? { field: keyField, aliases: [] } : keyField,
  )
}

function normalizeSource(sourceConfig, role) {
  return {
    ...sourceConfig,
    id: sourceConfig.id ?? sourceConfig.label,
    role,
    match: sourceConfig.match ?? [sourceConfig.label],
    keyFields: normalizeKeyFields(sourceConfig.keyFields ?? CONFIG.keyFields),
    columns: [
      ...normalizeColumns(sourceConfig.columns, role),
      ...expandMonthlyColumns(sourceConfig.monthlyColumns, role),
    ],
  }
}

function normalizeSources() {
  return [
    normalizeSource(BASE, 'base'),
    ...JOINS.map((config) => normalizeSource(config, 'join')),
  ]
}

/** 页面用：分表清单（名称、文件关键字、是否基准表），与清洗配置同源 */
export function getSplitSourceRoles() {
  return normalizeSources().map((source) => ({
    id: source.id,
    label: source.label,
    isBase: source.role === 'base',
    keywords: source.match,
  }))
}

/* ================================================================
 * 三、通用工具
 * ================================================================ */

/** 单元格文本：空值 → ""，其余转字符串并去除首尾空白（含全角空格） */
function cellText(value) {
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

const NUMERIC_AGGS = new Set(['sum', 'count', 'rows', 'months', 'min', 'max'])

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

function initState(column) {
  switch (column.agg || 'sum') {
    case 'concat':
    case 'months':
      return new Set()
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
    case 'concat': {
      const text = textValue(value)
      if (text) state.add(text)
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
    if (column.divideBy?.field) fields.add(column.divideBy.field)
    if (column.onlyUnits?.field) fields.add(column.onlyUnits.field)
    if (column.monthDateField) fields.add(column.monthDateField)
  }
  return [...fields]
}

async function readSource(file, source, fields, handle, onProgress) {
  const data = await file.arrayBuffer()
  const columnOf = new Map()

  return streamSheetRows(data, {
    sheet: source.sheet ?? 0,
    onHeader: (cells) => {
      cells.forEach((cell, index) => {
        const label = cellText(cell)
        if (label && !columnOf.has(label)) columnOf.set(label, index)
      })

      const missing = source.keyFields
        .filter((keyField) => ![keyField.field, ...keyField.aliases].some((name) => columnOf.has(name)))
        .map((keyField) => keyField.field)
      const missingValueColumns = source.columns
        .filter((column) => column.sourceField && !columnOf.has(column.sourceField))
        .map((column) => column.sourceField)
      const problems = [...new Set([...missing, ...missingValueColumns])]
      if (problems.length) {
        throw new Error(
          `「${source.label}」表头缺少列：${problems.join('、')}，请确认第一行是表头且列名未改动`,
        )
      }

      const wanted = []
      for (const field of fields) {
        if (columnOf.has(field)) wanted.push(columnOf.get(field))
      }
      return new Set(wanted)
    },
    onRow: ({ cells }) => {
      const row = {}
      let hasValue = false
      for (const field of fields) {
        const index = columnOf.get(field)
        const value = index === undefined ? null : cells[index] ?? null
        row[field] = value
        if (!hasValue && cellText(value) !== '') hasValue = true
      }
      if (hasValue) handle(row)
    },
    onProgress,
  })
}

/* ================================================================
 * 五、汇总与关联
 * ================================================================ */

/** 基准表：按唯一标识去重，保留首次出现行 */
function createBaseBuilder(source) {
  const keys = []
  const index = new Map()
  const lookup = new Map()
  const looseIndex = new Map()

  const add = (row) => {
    const key = makeKey(row, source.keyFields)
    if (!key || index.has(key)) return
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
    return { keys, index, lookup, looseIndex }
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

  const add = (row) => {
    if (source.rowFilter && !source.rowFilter(row)) return
    const parts = keyParts(row, source.keyFields)
    if (parts.every((part) => part === '')) return // 合计行 / 空行
    if (source.skipIncompleteKey && parts.some((part) => part === '')) return

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
      // 由同表其它列换算出来的列（如 周消耗 = 月均条数 ÷ 4）
      for (const column of source.columns) {
        if (!column.divideFrom) continue
        const from = Number(values[column.divideFrom.column]) || 0
        values[column.as] = round(from / column.divideFrom.by, column.digits ?? 6)
      }
      summary.set(key, values)
    }
    return summary
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
        line.push(0) // 该列暂时没有数据源（如 生产中 / 周转入 / 动销客户）
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
 * @param {Record<string, File|Blob>} options.files 按数据源 label 传入的分表文件
 * @param {(progress: {percent: number, sourceId: string, sourcePercent: number, message: string}) => void} [options.onProgress]
 *   percent 是整轮清洗的进度；sourceId / sourcePercent 是当前这张分表自己的进度，供界面按行显示进度条
 * @returns {Promise<{tables: Record<string, {columns: string[], rows: Array<Array>}>, stats: object}>}
 */
export async function cleanSplitTables({ files, onProgress } = {}) {
  const sources = normalizeSources()
  const baseSource = sources[0]
  const joinSourcesList = sources.slice(1)
  const totalSteps = sources.length
  let step = 0

  const report = (source, ratio, message) =>
    onProgress?.({
      percent: Math.round(Math.min(1, (step + clampRatio(ratio)) / totalSteps) * 100),
      sourceId: source?.id ?? '',
      sourcePercent: Math.round(clampRatio(ratio) * 100),
      message,
    })

  const fileOf = (source) => {
    const file = files?.[source.id]
    if (!file) throw new Error(`缺少「${source.label}」分表文件`)
    return file
  }

  // 1. 基准表：决定总表的行集合
  const baseBuilder = createBaseBuilder(baseSource)
  await readSource(fileOf(baseSource), baseSource, sourceFields(baseSource), baseBuilder.add, (ratio) =>
    report(baseSource, ratio, `读取 ${baseSource.label}`),
  )
  const base = baseBuilder.finish()
  step += 1

  // 2. 分表：逐张按唯一标识汇总
  const joins = []
  for (const source of joinSourcesList) {
    const file = fileOf(source)
    const aggregator = createAggregator(source, base)
    const prescan = aggregator.needsYear()
    const startRatio = prescan ? 0.45 : 0

    if (prescan) {
      const dateField = source.monthlyColumns.dateField
      let latest = null
      await readSource(file, source, [dateField], (row) => {
        const parsed = toYearMonth(row[dateField])
        if (parsed && (latest === null || parsed.year > latest)) latest = parsed.year
      }, (ratio) => report(source, ratio * startRatio, `识别 ${source.label} 的统计年份`))
      aggregator.setMonthlyYear(latest)
    }

    await readSource(file, source, sourceFields(source), aggregator.add, (ratio) =>
      report(source, startRatio + ratio * (1 - startRatio), `汇总 ${source.label}`),
    )
    joins.push({ entry: { source }, summary: aggregator.finish() })
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

  const tables = {}
  for (const output of resolvedOutputs) {
    const indexes = output.columns.map((name) => {
      const at = header.indexOf(name)
      if (at < 0) throw new Error(`输出列「${name}」不存在，请检查清洗配置`)
      return at
    })
    tables[output.sheet] = {
      columns: output.columns,
      rows: lines.map((line) => indexes.map((at) => line[at])),
    }
  }

  return { tables, stats: { rowCount: lines.length } }
}
