import { HEAT_METRIC_FIELDS } from '@/stocking/constants'

// 唯一标识：总表与销售表共有的 SKU 关联键，不参与任何因子。
export const SKU_ID_FIELD = 'skuId'
export const SKU_ID_LABEL = '唯一标识'

// 导入的数值字段定义：主面板数量列，导入解析与导出共用。
export const QUANTITY_FIELDS = [
  { field: 'producing', label: '生产中' },
  { field: 'backorder', label: '欠货' },
  { field: 'weeklySales', label: '周销量' },
  { field: 'warehouseStock', label: '在仓库存' },
  { field: 'inTransitStock', label: '在途库存' },
  { field: 'turnoverIn', label: '周转入' },
  { field: 'totalOutbound', label: '总出库数量' },
]

// 动销指标：由销售表提供；其中月均条数决定模式归属，其余仅展示与统计。
export const HEAT_FACTOR_FIELDS = HEAT_METRIC_FIELDS
