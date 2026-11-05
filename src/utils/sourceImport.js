import { HEAT_FACTOR_FIELDS, QUANTITY_FIELDS, SKU_ID_LABEL } from '@/data/quantityFields'
import { getFieldMeta } from '@/stocking/fields'

// 一次只能导入总表 + 销售表两个文件：按表头识别角色，销售标识统一是“唯一标识”。
const PRODUCT_HEADERS = new Set(['品名', '产品名称'])
const COLOR_HEADERS = new Set(['颜色', '色号'])
const SKU_ID_HEADERS = new Set([SKU_ID_LABEL, '唯一编码'])
const METRIC_HEADERS = new Set(HEAT_FACTOR_FIELDS.map((entry) => entry.label))
// 总表特有的库存列：出现任意一列即视为库存数据。
const INVENTORY_HEADERS = new Set([
  '色彩',
  '色彩类别',
  ...QUANTITY_FIELDS.map((entry) => entry.label),
])
const MONTH_COLUMN_PATTERN = /^(\d{1,2})月(条数|重量)$/
const HEADER_SCAN_ROWS = 10

function normalizeHeader(value) {
  return String(value ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[*＊]/g, '')
}

// 返回该工作表可承担的导入角色；无法识别时返回 null。
export function analyzeSourceSheet(rows) {
  for (let index = 0; index < Math.min(rows.length, HEADER_SCAN_ROWS); index += 1) {
    const labels = rows[index].cells.map(normalizeHeader)
    if (!labels.some((label) => PRODUCT_HEADERS.has(label))) continue
    if (!labels.some((label) => COLOR_HEADERS.has(label))) continue

    const hasSkuId = labels.some((label) => SKU_ID_HEADERS.has(label))
    const hasInventoryColumns = labels.some((label) => INVENTORY_HEADERS.has(label))
    const hasMonthColumns = labels.some((label) => MONTH_COLUMN_PATTERN.test(label))
    const hasMetricColumns = labels.some((label) => METRIC_HEADERS.has(label))

    return {
      hasSkuId,
      hasInventoryColumns,
      // 月份列是销售表的标志；只有动销指标、没有库存列的文件同样按销售表处理。
      hasSalesColumns: hasMonthColumns || (!hasInventoryColumns && hasMetricColumns),
    }
  }
  return null
}

// 表头校验提示：缺唯一标识时两个表都不可导入。
export function describeMissingColumns(roles) {
  if (!roles) {
    return `无法识别：表头需包含“${getFieldMeta('product').label}”“${getFieldMeta('color').label}”`
  }
  if (!roles.hasSkuId) return `缺少“${SKU_ID_LABEL}”列，总表与销售表都必须提供`
  if (!roles.hasInventoryColumns && !roles.hasSalesColumns) {
    return '无法识别：总表需要库存列，销售表需要“N月条数”等月份列或动销指标列'
  }
  return ''
}
