import { HEAT_FACTOR_FIELDS } from './quantityFields.js'

// 销售表列：品名、颜色来自主面板；动销指标取主面板导入的销售表；
// 客户CR5率与 1-12 月的销量（公斤）、订单数由「导入销售表」叠加，不在本页重新计算。
// 销量统一为公斤：码单位由出码率换算（码 ÷ 出码率），公斤单位取原值。
export const SALES_MONTH_FIELDS = Array.from({ length: 12 }, (_, index) => ({
  month: index + 1,
  index,
  countLabel: `${index + 1}月条数`,
  salesLabel: `${index + 1}月销量`,
  orderLabel: `${index + 1}月订单数`,
}))

// 比例列：品名父行不能求和，按 weightKey 对应的列加权平均（缺权重列时退回算术平均）。
// 客户CR5率 = 销量前 5 的客户占该 SKU 总销量的比例，清洗引擎按 0~1 输出，页面显示为百分比。
export const SALES_RATIO_COLUMNS = [
  { key: 'customerCr5', label: '客户CR5率', kind: 'percent', weightKey: 'cumulativeCount' },
]

export const SALES_TABLE_COLUMNS = [
  { key: 'product', label: '品名' },
  { key: 'color', label: '颜色' },
  ...HEAT_FACTOR_FIELDS.map(({ field, label }) => ({ key: field, label })),
  ...SALES_RATIO_COLUMNS,
  ...SALES_MONTH_FIELDS.flatMap(({ month, countLabel, salesLabel, orderLabel }) => [
    { key: `month${month}Count`, label: countLabel, month, kind: 'count' },
    { key: `month${month}Sales`, label: salesLabel, month, kind: 'sales' },
    { key: `month${month}Orders`, label: orderLabel, month, kind: 'order' },
  ]),
]
