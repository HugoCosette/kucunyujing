// 下单历史的 Excel 导出：批次汇总 + 分订单明细。
// 历史页与采购下单页共用这一份口径，导出的是「筛选后屏幕上看得到的那些行」。
import { saveWorkbook } from '../utils/xlsxWrite.js'
import { formatHistoryMoment, percentText, vatTextOf } from './history.js'

const BATCH_HEADERS = [
  '批次号',
  '确认时间',
  '月份',
  'SKU 数',
  '分订单',
  '作废单',
  '下单（kg）',
  '已到货（kg）',
  '待收（kg）',
  '到货进度',
  '状态',
]

const ORDER_HEADERS = [
  '批次号',
  '确认时间',
  '品名',
  '颜色',
  '唯一标识',
  '染厂',
  '分单人员',
  '下单方式 / 缸型',
  '下单（kg）',
  '已到货（kg）',
  '待收（kg）',
  '状态',
  '到货记录',
  '撤回记录',
  '改单次数',
  '备注',
]

/** batches: filterHistory() 返回的批次数组。数量字段保持数字，方便在 Excel 里再算。 */
export function buildHistoryExportSheets(batches) {
  const list = Array.isArray(batches) ? batches : []
  const batchRows = [BATCH_HEADERS]
  const orderRows = [ORDER_HEADERS]

  for (const batch of list) {
    batchRows.push([
      batch.code,
      formatHistoryMoment(batch.submittedAt),
      batch.month,
      batch.skuCount,
      batch.orderCount,
      batch.cancelledCount,
      batch.quantity,
      batch.received,
      batch.pending,
      percentText(batch.progress),
      batch.stateLabel,
    ])
    for (const row of batch.orders ?? []) {
      orderRows.push([
        batch.code,
        formatHistoryMoment(row.submittedAt),
        row.product,
        row.color,
        row.skuId,
        row.factoryName,
        row.assignee,
        vatTextOf(row),
        row.quantity,
        row.received,
        row.pending,
        row.stateLabel,
        row.receiptCount,
        row.voidedReceiptCount,
        row.revisionCount,
        row.note,
      ])
    }
  }

  return [
    {
      name: '批次汇总',
      rows: batchRows,
      widths: [18, 18, 10, 8, 9, 9, 12, 12, 12, 10, 16],
    },
    {
      name: '分订单明细',
      rows: orderRows,
      widths: [18, 18, 22, 16, 20, 16, 12, 20, 12, 12, 12, 14, 10, 10, 10, 24],
    },
  ]
}

/** scopeLabel 写明导出范围（如 2026-11 / 2026-11-23 / 2026-11-01_2026-11-23）。 */
export function buildHistoryExportFileName(scopeLabel = '', baseName = '下单历史') {
  const timestamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')
  const scope = String(scopeLabel ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
  return `${baseName}${scope ? `-${scope}` : ''}-${timestamp}.xlsx`
}

export function exportOrderWorkbook(batches, { baseName = '下单历史', scopeLabel = '' } = {}) {
  const list = Array.isArray(batches) ? batches : []
  saveWorkbook(buildHistoryExportSheets(list), buildHistoryExportFileName(scopeLabel, baseName))
  return {
    batchCount: list.length,
    orderCount: list.reduce((sum, batch) => sum + (batch.orders?.length ?? 0), 0),
  }
}
