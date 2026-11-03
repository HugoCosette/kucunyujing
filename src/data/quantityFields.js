// 导入的数值字段定义：导入解析与热度因子共用，新增列时只补充这里即可。
export const QUANTITY_FIELDS = [
  { field: 'producing', label: '生产中' },
  { field: 'backorder', label: '欠货' },
  { field: 'weeklyUsage', label: '周消耗' },
  { field: 'warehouseStock', label: '在仓库存' },
  { field: 'inTransitStock', label: '在途库存' },
  { field: 'turnoverIn', label: '周转入' },
]
