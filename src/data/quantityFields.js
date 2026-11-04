// 导入的数值字段定义：主面板数量列，导入解析与导出共用。
export const QUANTITY_FIELDS = [
  { field: 'producing', label: '生产中' },
  { field: 'backorder', label: '欠货' },
  { field: 'weeklyUsage', label: '周消耗' },
  { field: 'warehouseStock', label: '在仓库存' },
  { field: 'inTransitStock', label: '在途库存' },
  { field: 'turnoverIn', label: '周转入' },
]

// 热度因子的可选数值字段：动销指标，同样由 Excel 导入，新增指标时只补这里。
export const HEAT_FACTOR_FIELDS = [
  { field: 'monthlyAvgCount', label: '月均条数' },
  { field: 'totalOrders', label: '订单总数' },
  { field: 'activeMonths', label: '动销月份' },
  { field: 'activeCustomers', label: '动销客户' },
]
