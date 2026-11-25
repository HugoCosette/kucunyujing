// 下单历史视图模型：把订单流水聚成「批次 → 分订单」两级，页面数字只做派生计算。
//
// 批次 = 一次「确认下单」产生的 batchId（可能含多个 SKU、多个染厂）；
// 分订单 = 订单流水的一行（SKU × 染厂），到货与待收由 receipts 派生，不单独存。

import { quantityModeOf } from './validate.js'

const STATUS_CANCELLED = 'cancelled'

const RECEIVE_LABELS = {
  done: '已收齐',
  partial: '部分到货',
  idle: '未到货',
}

export const ORDER_STATE_LABELS = {
  cancelled: '已作废',
  done: '已收齐',
  partial: '部分到货',
  idle: '未到货',
}

function text(value) {
  return String(value ?? '').trim()
}

function num(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

function padded(value) {
  return String(value).padStart(2, '0')
}

// submittedAt 是 UTC ISO，界面上的「确认时间」按本地时区显示；
// 日期筛选与批次号都用本地日，否则凌晨确认的单会被算到前一天。
function localDayOf(stamp) {
  const value = text(stamp)
  const time = Date.parse(value)
  if (!Number.isFinite(time)) {
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : ''
  }
  const date = new Date(time)
  return `${date.getFullYear()}-${padded(date.getMonth() + 1)}-${padded(date.getDate())}`
}

function localMonthOf(stamp) {
  return localDayOf(stamp).slice(0, 7)
}

// 导出与历史页共用同一套文案口径，避免文件里的时间和屏幕上对不上。
export function formatHistoryMoment(value) {
  const stamp = Date.parse(value ?? '')
  if (!Number.isFinite(stamp)) return '—'
  const date = new Date(stamp)
  return `${date.getFullYear()}-${padded(date.getMonth() + 1)}-${padded(date.getDate())} ${padded(
    date.getHours(),
  )}:${padded(date.getMinutes())}`
}

export function formatHistoryKg(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

export function percentText(progress) {
  return `${Math.round(Math.min(1, Math.max(0, Number(progress) || 0)) * 100)}%`
}

export function vatTextOf(row) {
  if (row.quantityMode === 'kg') return '按公斤'
  if (row.quantityMode === 'vat') {
    if (row.vatCount && row.kgPerVat) return `${row.vatCount} 缸 × ${row.kgPerVat} 公斤/缸`
    return '按缸（缸规未完整）'
  }
  if (row.vatCount && row.kgPerVat) return `按缸 · ${row.vatCount} × ${row.kgPerVat}`
  return '—'
}

function receiveTone(quantity, received, pending) {
  if (!(quantity > 0)) return 'idle'
  if (pending <= 1e-9) return 'done'
  return received > 0 ? 'partial' : 'idle'
}

function rowOf(order) {
  const quantity = num(order?.quantity)
  const received = num(order?.receivedQty)
  const pending = Math.max(0, quantity - received)
  const receipts = Array.isArray(order?.receipts) ? order.receipts : []
  const activeReceipts = receipts.filter((receipt) => receipt && !receipt.voidedAt)
  const cancelled = order?.status === STATUS_CANCELLED
  const receiveState = receiveTone(quantity, received, pending)

  return {
    id: text(order?.id),
    batchId: text(order?.batchId) || text(order?.id),
    skuId: text(order?.skuId),
    product: text(order?.product),
    color: text(order?.color),
    factoryName: text(order?.factoryName) || '未指定染厂',
    assignee: text(order?.assignee),
    quantityMode: quantityModeOf(order),
    vatCount: num(order?.vatCount) || null,
    kgPerVat: num(order?.kgPerVat) || null,
    quantity,
    received,
    pending,
    progress: quantity > 0 ? Math.min(1, received / quantity) : 0,
    note: text(order?.note),
    submittedAt: text(order?.submittedAt),
    day: localDayOf(order?.submittedAt),
    month: localMonthOf(order?.submittedAt) || text(order?.month),
    cancelled,
    cancelledAt: text(order?.cancelledAt) || null,
    revisionCount: Array.isArray(order?.revisions) ? order.revisions.length : 0,
    receiptCount: activeReceipts.length,
    voidedReceiptCount: receipts.length - activeReceipts.length,
    lastReceiptAt: activeReceipts.reduce(
      (latest, receipt) => (text(receipt.at) > latest ? text(receipt.at) : latest),
      '',
    ),
    receiveState,
    stateLabel: cancelled ? ORDER_STATE_LABELS.cancelled : RECEIVE_LABELS[receiveState],
  }
}

// 批次合计只算有效单：作废的行留在列表里给人看，但不进任何和。
function summarize(rows, base) {
  const activeRows = rows.filter((row) => !row.cancelled)
  const quantity = activeRows.reduce((sum, row) => sum + row.quantity, 0)
  const received = activeRows.reduce((sum, row) => sum + row.received, 0)
  const pending = activeRows.reduce((sum, row) => sum + row.pending, 0)
  const cancelledCount = rows.length - activeRows.length
  const receiveState = receiveTone(quantity, received, pending)
  const skuIds = new Set(rows.map((row) => row.skuId).filter(Boolean))

  return {
    ...base,
    orders: rows,
    orderCount: rows.length,
    skuCount: skuIds.size,
    cancelledCount,
    quantity,
    received,
    pending,
    progress: quantity > 0 ? Math.min(1, received / quantity) : 0,
    receiptCount: activeRows.reduce((sum, row) => sum + row.receiptCount, 0),
    voidedReceiptCount: activeRows.reduce((sum, row) => sum + row.voidedReceiptCount, 0),
    revisionCount: activeRows.reduce((sum, row) => sum + row.revisionCount, 0),
    receiveState,
    stateLabel:
      rows.length > 0 && cancelledCount === rows.length
        ? ORDER_STATE_LABELS.cancelled
        : cancelledCount > 0
          ? `部分作废 · ${RECEIVE_LABELS[receiveState]}`
          : RECEIVE_LABELS[receiveState],
  }
}

/**
 * orders: 订单流水的原始数组（含 active 与 cancelled）。
 * 返回 { batches, months }：batches 按确认时间倒序，months 是可用月份（倒序）。
 */
export function buildOrderHistory(orders) {
  const rows = (orders ?? []).map(rowOf).filter((row) => row.batchId)
  const grouped = new Map()
  for (const row of rows) {
    const list = grouped.get(row.batchId) ?? []
    list.push(row)
    grouped.set(row.batchId, list)
  }

  const batches = []
  for (const [batchId, list] of grouped) {
    list.sort(
      (first, second) =>
        first.submittedAt.localeCompare(second.submittedAt) || first.id.localeCompare(second.id),
    )
    batches.push(
      summarize(list, {
        key: batchId,
        batchId,
        submittedAt: list[0].submittedAt,
        month: localMonthOf(list[0].submittedAt) || text(list[0].month),
        code: '',
      }),
    )
  }

  batches.sort(
    (first, second) =>
      second.submittedAt.localeCompare(first.submittedAt) || first.batchId.localeCompare(second.batchId),
  )

  // 批次号按本地日期顺排成 PO-20261116-01：同一天的先后与流水一致，换筛选也不会变。
  const dayCounters = new Map()
  for (const batch of [...batches].sort((first, second) =>
    first.submittedAt.localeCompare(second.submittedAt),
  )) {
    const day = localDayOf(batch.submittedAt).replace(/-/g, '') || '00000000'
    const sequence = (dayCounters.get(day) ?? 0) + 1
    dayCounters.set(day, sequence)
    batch.code = `PO-${day.replace(/-/g, '')}-${String(sequence).padStart(2, '0')}`
  }

  const months = [...new Set(batches.map((batch) => batch.month).filter(Boolean))].sort((a, b) =>
    b.localeCompare(a),
  )
  return { batches, months }
}

function matchesKeyword(row, needle) {
  return [
    row.id,
    row.skuId,
    row.product,
    row.color,
    row.factoryName,
    row.assignee,
    row.note,
  ].some((field) => field.toLowerCase().includes(needle))
}

/**
 * 筛选：keyword 命中任意字段（或批次号）；from / to 是本地日期 YYYY-MM-DD，两端都含；
 * batchId 只取某一批；status 取 active / cancelled / all。
 * 命中后批次只保留命中的分订单，合计也跟着重算，界面上的数字始终等于看到的行。
 */
export function filterHistory(
  history,
  { keyword = '', from = '', to = '', status = 'active', batchId = '' } = {},
) {
  const needle = text(keyword).toLowerCase()
  const start = text(from)
  const end = text(to)
  const onlyBatch = text(batchId)
  const batches = []

  for (const batch of history?.batches ?? []) {
    if (onlyBatch && text(batch.batchId) !== onlyBatch) continue
    const codeHit = needle !== '' && batch.code.toLowerCase().includes(needle)
    const orders = batch.orders.filter((row) => {
      if (status === 'active' && row.cancelled) return false
      if (status === 'cancelled' && !row.cancelled) return false
      if (start || end) {
        // 日期比不了的单（没有可解析的确认时间）在限定范围时一律排除。
        if (!row.day) return false
        if (start && row.day < start) return false
        if (end && row.day > end) return false
      }
      if (!needle || codeHit) return true
      return matchesKeyword(row, needle)
    })
    if (!orders.length) continue
    batches.push(summarize(orders, batch))
  }

  const totals = {
    batchCount: batches.length,
    orderCount: batches.reduce((sum, batch) => sum + batch.orderCount, 0),
    skuCount: new Set(batches.flatMap((batch) => batch.orders.map((row) => row.skuId)).filter(Boolean)).size,
    quantity: batches.reduce((sum, batch) => sum + batch.quantity, 0),
    received: batches.reduce((sum, batch) => sum + batch.received, 0),
    pending: batches.reduce((sum, batch) => sum + batch.pending, 0),
    cancelledCount: batches.reduce((sum, batch) => sum + batch.cancelledCount, 0),
  }

  return { batches, totals }
}
