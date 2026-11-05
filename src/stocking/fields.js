// 备货规则的因子字段注册表：所有可选因子都来自导入列，1-12 月销售数据不参与任何因子。
// 唯一标识只作跨表关联键，不登记为因子。
export const HEAT_METRIC_FIELDS = [
  { field: 'monthlyAvgCount', label: '月均条数' },
  { field: 'totalOrders', label: '订单总数' },
  { field: 'activeMonths', label: '动销月份' },
  { field: 'activeCustomers', label: '动销客户' },
]

// 下拉分组：销售数据置顶展开，其余字段默认折叠。
export const FIELD_GROUPS = [
  { key: 'sales', label: '销售数据', collapsed: false },
  { key: 'inventory', label: '更多字段', collapsed: true },
]

export const STOCKING_FIELDS = [
  ...HEAT_METRIC_FIELDS.map((entry) => ({ ...entry, group: 'sales', kind: 'number' })),
  { field: 'producing', label: '生产中', group: 'inventory', kind: 'number' },
  { field: 'backorder', label: '欠货', group: 'inventory', kind: 'number' },
  { field: 'weeklyUsage', label: '周消耗', group: 'inventory', kind: 'number' },
  { field: 'turnoverIn', label: '周转入', group: 'inventory', kind: 'number' },
  { field: 'inTransitStock', label: '在途库存', group: 'inventory', kind: 'number' },
  { field: 'warehouseStock', label: '在仓库存', group: 'inventory', kind: 'number' },
  { field: 'totalOutbound', label: '总出库数量', group: 'inventory', kind: 'number' },
  {
    field: 'category',
    label: '色彩',
    group: 'inventory',
    kind: 'enum',
    options: ['黑白', '彩色'],
  },
  { field: 'product', label: '品名', group: 'inventory', kind: 'text' },
  { field: 'color', label: '颜色', group: 'inventory', kind: 'text' },
]

const FIELD_INDEX = new Map(STOCKING_FIELDS.map((entry) => [entry.field, entry]))

export function getFieldMeta(field) {
  return FIELD_INDEX.get(field) ?? null
}

export function getFieldLabel(field) {
  return FIELD_INDEX.get(field)?.label ?? field
}

export function getFieldsByGroup(groupKey) {
  return STOCKING_FIELDS.filter((entry) => entry.group === groupKey)
}

// 文本/枚举字段只能做等值判断，数值字段支持区间。
export const COMPARE_OPERATORS = [
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
  { value: 'eq', label: '=' },
]

const EQUAL_ONLY_OPERATORS = COMPARE_OPERATORS.filter((entry) => entry.value === 'eq')

export function operatorsFor(field) {
  return getFieldMeta(field)?.kind === 'number' ? COMPARE_OPERATORS : EQUAL_ONLY_OPERATORS
}

export function operatorLabel(value) {
  return COMPARE_OPERATORS.find((entry) => entry.value === value)?.label ?? value
}

export const GRADES = ['S', 'A', 'B', 'C']
export const UNGRADED = 'Z'
export const ALL_GRADES = [...GRADES, UNGRADED]

// 动销指标给出常用阈值；其余数值字段默认留空，未配置阈值的因子一律记 Z。
const DEFAULT_THRESHOLDS = {
  monthlyAvgCount: { S: 120, A: 90, B: 30, C: 1 },
  totalOrders: { S: 100, A: 50, B: 20, C: 1 },
  activeMonths: { S: 12, A: 9, B: 6, C: 1 },
  activeCustomers: { S: 10, A: 5, B: 2, C: 1 },
}

export function createThresholds(field) {
  const preset = DEFAULT_THRESHOLDS[field] ?? {}
  return {
    S: preset.S ?? null,
    A: preset.A ?? null,
    B: preset.B ?? null,
    C: preset.C ?? null,
  }
}
