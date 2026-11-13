// SKU 健康度评分的输入口径：主面板「评分」列与 SKU 弹窗共用，
// 避免两处各拼一份因子、算出不同的综合评分。
import { evaluateBulkScoring, evaluateScoring } from '@/stocking'
import { getSuggestedPlanned } from '@/utils/inventory'

// row 是 calculateInventoryRow 的结果（弹窗与主面板行都满足）。
export function buildScoringMetrics(row, salesEntry = null) {
  return {
    cr5: salesEntry?.cr5 ?? null,
    activeCustomers: row?.activeCustomers,
    sales: salesEntry?.sales ?? row?.monthSales,
    cumulativeSales: salesEntry?.cumulativeSales ?? row?.cumulativeSales,
    suggestedQuantity: getSuggestedPlanned(row),
    monthlySales: row?.monthlySales,
    theoreticalStock: row?.theoreticalStock,
  }
}

// 专属品 / 尾货 / 模式缺省一律按「不参与」；按量模式走 2 项专属判定，没有综合分。
export function evaluateRowHealth({ row, salesEntry = null, config, bulkHealthScoring = null }) {
  const participates = Boolean(row?.strategyAvailable) && !row?.excluded
  const metrics = buildScoringMetrics(row, salesEntry)
  if (row?.modeKey === 'bulk') {
    return evaluateBulkScoring({ metrics, participates, healthScoring: bulkHealthScoring })
  }
  return evaluateScoring({ config, participates, metrics })
}
