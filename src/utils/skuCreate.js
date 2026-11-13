import { HEAT_FACTOR_FIELDS, QUANTITY_FIELDS } from '@/data/quantityFields'
import { CATEGORIES } from '@/stocking/constants'
import { normalizeProductName } from './inventory.js'

// 手动添加 SKU 与导入走同一套字段：数量列取 QUANTITY_FIELDS，动销指标取 HEAT_FACTOR_FIELDS。
// 唯一标识与公斤换算不让人填：唯一标识按 MANUAL-0001 递增生成，库存一律按公斤录入（公斤系数 = 1）。
export const SKU_QUANTITY_INPUTS = QUANTITY_FIELDS
export const SKU_METRIC_INPUTS = HEAT_FACTOR_FIELDS

const MANUAL_SKU_PREFIX = 'MANUAL-'
const MANUAL_KG_FACTOR = 1

// 表单提交的是字符串或数字，这里统一收敛成数字；空值按 null 返回，由调用方决定兜底。
function toNumber(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim().replace(/,/g, '')
  if (text === '') return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

// 空数量按 0 落库，与导入时「缺省列 / 空格子记 0」一致，主面板不会出现 NaN。
function toQuantity(value) {
  return toNumber(value) ?? 0
}

// 唯一标识仍是总表 / 销售表 / 屏蔽清单 / 采购分单的关联键，手动添加时按 MANUAL-#### 递增生成。
// 必须同时避开「屏蔽清单」里用过的标识：被屏蔽的旧 SKU 不在当前数据里，只按现有行算会撞号，
// 新加的 SKU 就会因为命中屏蔽列表而直接不显示。
function nextManualSkuId(inventoryItems, reservedSkuIds) {
  const used = new Set(reservedSkuIds ?? [])
  for (const item of inventoryItems) used.add(String(item.skuId ?? ''))

  for (let index = 1; ; index += 1) {
    const candidate = `${MANUAL_SKU_PREFIX}${String(index).padStart(4, '0')}`
    if (!used.has(candidate)) return candidate
  }
}

function validateDraft(draft) {
  const product = normalizeProductName(String(draft.product ?? ''))
  const color = String(draft.color ?? '').trim()
  if (!product || !color) throw new Error('请填写品名与颜色')

  const category = String(draft.category ?? '').trim()
  if (category && !CATEGORIES.includes(category)) {
    throw new Error(`色彩只能是 ${CATEGORIES.join(' / ')}`)
  }

  return { product, color, category: category || CATEGORIES[0] }
}

// 主面板新增行：「品名 + 颜色」不能与现有行重复，id 取当前最大值 + 1。
// reservedSkuIds 传入屏蔽清单等「看不见但已占用」的标识，避免自动生成的标识撞号。
export function addInventorySku(store, draft, { reservedSkuIds = null } = {}) {
  const { product, color, category } = validateDraft(draft)
  const inventoryItems = store.inventoryItems

  let maxId = 0
  for (const item of inventoryItems) {
    if (item.product === product && item.color === color) {
      throw new Error(`品名 + 颜色已存在：${product} / ${color}`)
    }
    const id = Number(item.id)
    if (Number.isFinite(id) && id > maxId) maxId = id
  }

  const quantities = {}
  for (const { field } of QUANTITY_FIELDS) {
    quantities[field] = toQuantity(draft[field])
  }

  // 动销指标来自销售表，缺值记 null（评分按无数据处理），月均条数缺省时按「累积条数 ÷ 动销月份」现算。
  const metrics = {}
  for (const { field } of HEAT_FACTOR_FIELDS) {
    metrics[field] = toNumber(draft[field])
  }
  if (!Number.isFinite(metrics.monthlyAvgCount)) {
    const cumulative = metrics.cumulativeCount
    const months = metrics.activeMonths
    metrics.monthlyAvgCount =
      Number.isFinite(cumulative) && Number.isFinite(months) && months > 0
        ? Math.round((cumulative / months) * 100) / 100
        : 0
  }

  const item = {
    id: maxId + 1,
    skuId: nextManualSkuId(inventoryItems, reservedSkuIds),
    product,
    color,
    category,
    treeCategory: String(draft.treeCategory ?? '').trim(),
    planned: null,
    ...quantities,
    // 库存按公斤录入：公斤系数 = 1，在仓库存原样参与公斤口径的备货计算。
    kgFactor: MANUAL_KG_FACTOR,
    unitRate: null,
    monthSales: null,
    monthCounts: null,
    cumulativeSales: null,
    ...metrics,
  }

  inventoryItems.push(item)
  return item
}
