// 备货模式的常量：色彩类别、系数三键、动销指标与销量权重。
// 库存与销量统一用「公斤」比较：库存（码或公斤）× 公斤系数 = 公斤。

export const CATEGORIES = ['黑白', '彩色']

export const COEFFICIENT_KEYS = [
  { key: 'redLine', label: '红线' },
  { key: 'normal', label: '正常' },
  { key: 'peak', label: '峰值' },
]

// 动销指标：销售表与主面板共用的 5 个字段，其中只有月均条数参与模式判定。
export const HEAT_METRIC_FIELDS = [
  { field: 'monthlyAvgCount', label: '月均条数' },
  { field: 'totalOrders', label: '订单总数' },
  { field: 'activeMonths', label: '动销月份' },
  { field: 'activeCustomers', label: '累计客户' },
  { field: 'cumulativeCount', label: '累积条数' },
]

// 旧表头兼容：列名改过之后，历史导出文件里的旧列名仍按同一字段解析。
export const LEGACY_METRIC_LABELS = new Map([['动销客户', 'activeCustomers']])

// 客户类别：热销 / 常规 按「累计客户是否为 1」分流。
export const CUSTOMER_FLOW = '流通品'
export const CUSTOMER_EXCLUSIVE = '专属品'

// 模式固定顺序（判定优先级从高到低），模式本身不可增删。
export const MODE_KEYS = ['hot', 'normal', 'bulk', 'tail', 'slow']

export const MODE_METRICS = {
  days: { label: '天', hint: '按「够卖多少天」比较系数' },
  stock: { label: '公斤', hint: '按库存公斤数直接比较系数' },
  none: { label: '—', hint: '不参与计算，仅做标记' },
}

// 销量加权：近 1 个月 / 近 3 个月月均 / 近 12 个月月均，权重之和为 1。
export const SALES_WINDOW_DEFAULTS = { m1: 0.5, m3: 0.3, m12: 0.2 }

// 把三档窗口权重展开成 12 个月各自的权重，仅用于配置页展示与核对。
export function expandMonthWeights(weights) {
  const merged = { ...SALES_WINDOW_DEFAULTS, ...(weights ?? {}) }
  const share3 = merged.m3 / 3
  const share12 = merged.m12 / 12
  return Array.from({ length: 12 }, (_, index) => {
    let value = share12
    if (index < 3) value += share3
    if (index === 0) value += merged.m1
    return value
  })
}
