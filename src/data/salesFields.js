import { HEAT_FACTOR_FIELDS } from './quantityFields.js'

// 销售表列：品名、颜色来自主面板；月均条数/订单总数/动销月份/动销客户取主面板导入的动销指标；
// 1-12 月条数与重量由“导入销售表”叠加，不在本页重新计算。
export const SALES_MONTH_FIELDS = Array.from({ length: 12 }, (_, index) => ({
  month: index + 1,
  index,
  countLabel: `${index + 1}月条数`,
  weightLabel: `${index + 1}月重量`,
}))

export const SALES_TABLE_COLUMNS = [
  { key: 'product', label: '品名' },
  { key: 'color', label: '颜色' },
  ...HEAT_FACTOR_FIELDS.map(({ field, label }) => ({ key: field, label })),
  ...SALES_MONTH_FIELDS.flatMap(({ month, countLabel, weightLabel }) => [
    { key: `month${month}Count`, label: countLabel, month, kind: 'count' },
    { key: `month${month}Weight`, label: weightLabel, month, kind: 'weight' },
  ]),
]
