<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, ElOption, ElSelect } from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import {
  buildOrderHistory,
  filterHistory,
  formatHistoryKg,
  formatHistoryMoment,
  percentText,
  vatTextOf,
} from '@/purchase/history'
import { exportOrderWorkbook } from '@/purchase/historyExport'

// 下单历史：标准订单列表的形制——单一表头 + 批次分组带 + 分订单行。
// 分组带是一整条横带（不重复表头），点它整组收放；子行只有一套列，不再套第二张表。
// 所有数字由订单流水派生；物理删除会同步移除该单的到货 / 改单记录。
// 它是「采购下单」页的子面板（`/purchase/history`），外壳与标签页由 PurchaseOrderView 提供。
const COLUMN_COUNT = 13

const purchaseStore = usePurchaseStore()

const keyword = ref('')
const dateScope = ref('all')
const monthFilter = ref('all')
const dayFilter = ref('')
const rangeStart = ref('')
const rangeEnd = ref('')
const statusFilter = ref('active')
const expandedKeys = ref(new Set())

const history = computed(() => buildOrderHistory(purchaseStore.orders?.orders ?? []))

function todayKey() {
  return new Date().toLocaleDateString('sv-SE')
}

// 日期筛选只认本地日：界面上的「确认时间」也是本地时间，两边必须是同一个口径。
function monthBounds(month) {
  const value = String(month ?? '').trim()
  if (!/^\d{4}-\d{2}$/.test(value)) return { from: '', to: '' }
  const [year, monthIndex] = value.split('-').map(Number)
  const lastDay = new Date(year, monthIndex, 0).getDate()
  return { from: `${value}-01`, to: `${value}-${String(lastDay).padStart(2, '0')}` }
}

const dateWindow = computed(() => {
  if (dateScope.value === 'month') return monthBounds(monthFilter.value)
  if (dateScope.value === 'day') {
    const day = String(dayFilter.value ?? '').trim()
    return { from: day, to: day }
  }
  if (dateScope.value === 'range') {
    return {
      from: String(rangeStart.value ?? '').trim(),
      to: String(rangeEnd.value ?? '').trim(),
    }
  }
  return { from: '', to: '' }
})

const dateLabel = computed(() => {
  const { from, to } = dateWindow.value
  if (!from && !to) return '全部日期'
  if (from && to && from === to) return from
  return `${from || '最早'}~${to || '最新'}`
})

watch(dateScope, (scope) => {
  if (scope === 'month' && monthFilter.value === 'all') {
    monthFilter.value = history.value.months[0] ?? 'all'
  }
  if (scope === 'day' && !dayFilter.value) dayFilter.value = todayKey()
  if (scope === 'range' && !rangeStart.value) {
    const now = new Date()
    rangeStart.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    rangeEnd.value = todayKey()
  }
})

const filtered = computed(() =>
  filterHistory(history.value, {
    keyword: keyword.value,
    from: dateWindow.value.from,
    to: dateWindow.value.to,
    status: statusFilter.value,
  }),
)
const batches = computed(() => filtered.value.batches)
const totals = computed(() => filtered.value.totals)
const allExpanded = computed(
  () => batches.value.length > 0 && batches.value.every((batch) => expandedKeys.value.has(batch.key)),
)

// 默认只展开最近一个批次：历史页要"一眼看到全貌"，但不要一屏几十行。
let seeded = false
watch(
  batches,
  (list) => {
    if (seeded) return
    seeded = true
    expandedKeys.value = new Set(list.length ? [list[0].key] : [])
  },
  { immediate: true },
)

function isExpanded(key) {
  return expandedKeys.value.has(key)
}

function toggleBatch(key) {
  const next = new Set(expandedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedKeys.value = next
}

function toggleAll() {
  expandedKeys.value = allExpanded.value ? new Set() : new Set(batches.value.map((b) => b.key))
}

// 状态一律用「圆点 + 文字」：满屏彩块会让人找不到重点。
function stateTone(entry) {
  if (entry.cancelled) return 'cancelled'
  if (entry.orderCount && entry.cancelledCount === entry.orderCount) return 'cancelled'
  return entry.receiveState
}

function ordersForBatch(batchId) {
  const key = String(batchId ?? '').trim()
  return (purchaseStore.orders?.orders ?? []).filter(
    (order) => (String(order.batchId ?? '').trim() || String(order.id ?? '').trim()) === key,
  )
}

function deletionImpact(orders) {
  const activeOrders = orders.filter((order) => order.status !== 'cancelled')
  const received = activeOrders.reduce((sum, order) => sum + (Number(order.receivedQty) || 0), 0)
  const receiptCount = orders.reduce(
    (sum, order) => sum + (Array.isArray(order.receipts) ? order.receipts.length : 0),
    0,
  )
  const revisionCount = orders.reduce(
    (sum, order) => sum + (Array.isArray(order.revisions) ? order.revisions.length : 0),
    0,
  )
  const relatedRecords =
    receiptCount || revisionCount
      ? `关联的 ${receiptCount} 条到货记录和 ${revisionCount} 条改单记录也会一并永久删除。`
      : ''
  const stockEffect = activeOrders.length
    ? '删除后会从下单统计中移除。'
    : '这些订单已作废，删除历史记录不会再次回补需安排。'
  const receivedEffect =
    received > 0
      ? `其中已登记到货 ${formatHistoryKg(received)} 公斤；删除后订单到货统计会减少，导入的在仓库存数据不会改动。`
      : ''
  return [stockEffect, receivedEffect, relatedRecords].filter(Boolean).join('\n')
}

async function handleDeleteOrder(row) {
  const order = (purchaseStore.orders?.orders ?? []).find((entry) => entry.id === row.id)
  if (!order) return
  try {
    await ElMessageBox.confirm(
      `确定永久删除「${row.product || row.skuId} ${row.color} · ${row.factoryName}」？\n${deletionImpact([order])}`,
      '删除分订单',
      { type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const removed = purchaseStore.removeOrder(row.id)
  if (!removed) {
    ElMessage.warning('该分订单已不存在')
    return
  }
  void purchaseStore.flushOrders()
  ElMessage.success('分订单及关联数据已删除')
}

async function handleDeleteBatch(batch) {
  const orders = ordersForBatch(batch.batchId)
  if (!orders.length) return
  try {
    await ElMessageBox.confirm(
      `确定永久删除批次「${batch.code}」及其全部 ${orders.length} 张分订单？\n${deletionImpact(orders)}\n同日剩余批次号会按现有流水重新顺排。`,
      '删除总订单',
      { type: 'warning', confirmButtonText: '永久删除整批', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const removed = purchaseStore.removeBatchOrders(batch.batchId)
  if (!removed.length) {
    ElMessage.warning('该批次已不存在')
    return
  }
  void purchaseStore.flushOrders()
  ElMessage.success(`已删除批次及 ${removed.length} 张分订单`)
}

function handleExport() {
  if (!batches.value.length) return

  try {
    const { batchCount, orderCount } = exportOrderWorkbook(batches.value, {
      baseName: '下单历史',
      scopeLabel: dateLabel.value === '全部日期' ? '' : dateLabel.value.replace('~', '_'),
    })
    ElMessage.success(`已导出 ${batchCount} 个批次 / ${orderCount} 张分订单`)
  } catch (error) {
    console.error('Failed to export order history', error)
    ElMessage.error(`导出失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}</script>

<template>
  <section class="history-panel">
    <div class="page-toolbar">
      <label class="field">
        <input
          v-model="keyword"
          class="input input--search history-search"
          type="search"
          placeholder="搜索批次号 / 品名 / 颜色 / 染厂"
        />
      </label>
      <ElSelect v-model="dateScope" size="small" class="history-select history-select--scope">
        <ElOption label="全部日期" value="all" />
        <ElOption label="按月" value="month" />
        <ElOption label="按日" value="day" />
        <ElOption label="自定义范围" value="range" />
      </ElSelect>
      <ElSelect v-if="dateScope === 'month'" v-model="monthFilter" size="small" class="history-select">
        <ElOption label="全部月份" value="all" />
        <ElOption v-for="month in history.months" :key="month" :label="month" :value="month" />
      </ElSelect>
      <input
        v-else-if="dateScope === 'day'"
        v-model="dayFilter"
        class="input history-date"
        type="date"
        aria-label="按日筛选"
      />
      <span v-else-if="dateScope === 'range'" class="history-range">
        <input v-model="rangeStart" class="input history-date" type="date" aria-label="开始日期" />
        <span class="history-range__dash">至</span>
        <input v-model="rangeEnd" class="input history-date" type="date" aria-label="结束日期" />
      </span>
      <ElSelect v-model="statusFilter" size="small" class="history-select">
        <ElOption label="有效单" value="active" />
        <ElOption label="已作废" value="cancelled" />
        <ElOption label="全部状态" value="all" />
      </ElSelect>
      <span class="toolbar__end history-actions">
        <button type="button" class="btn btn--text btn--sm" :disabled="!batches.length" @click="toggleAll">
          {{ allExpanded ? '收起全部' : '展开全部' }}
        </button>
        <button
          type="button"
          class="btn btn--sm btn--primary"
          :disabled="!batches.length"
          :title="`导出「${dateLabel}」的下单记录（批次汇总 + 分订单明细）`"
          @click="handleExport"
        >
          导出 Excel
        </button>
      </span>
    </div>

    <div class="history-scroll">
      <table class="score-table history-table">
        <colgroup>
          <col style="width: 200px" />
          <col style="width: 160px" />
          <col style="width: 126px" />
          <col style="width: 78px" />
          <col style="width: 126px" />
          <col style="width: 94px" />
          <col style="width: 84px" />
          <col style="width: 84px" />
          <col style="width: 100px" />
          <col style="width: 84px" />
          <col style="width: 104px" />
          <col />
          <col style="width: 84px" />
        </colgroup>
        <thead>
          <tr>
            <th>品名</th>
            <th>颜色</th>
            <th>染厂</th>
            <th>分单人员</th>
            <th>下单方式 / 缸型</th>
            <th class="is-num">下单（kg）</th>
            <th class="is-num">已到货</th>
            <th class="is-num">待收</th>
            <th>进度</th>
            <th>状态</th>
            <th class="is-num">到货 / 改动</th>
            <th>备注</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="batch in batches" :key="batch.key">
            <tr class="group-row" :class="{ 'is-open': isExpanded(batch.key) }" @click="toggleBatch(batch.key)">
              <td colspan="5">
                <div class="group-id">
                  <span class="group-caret" aria-hidden="true">▶</span>
                  <b class="group-code">{{ batch.code }}</b>
                  <span class="group-meta">
                    {{ formatHistoryMoment(batch.submittedAt) }} · {{ batch.skuCount }} SKU ·
                    {{ batch.orderCount }} 单
                    <template v-if="batch.cancelledCount"> · 作废 {{ batch.cancelledCount }}</template>
                  </span>
                </div>
              </td>
              <td class="is-num">{{ formatHistoryKg(batch.quantity) }}</td>
              <td class="is-num" :class="{ 'cell-dim': !(batch.received > 0) }">
                {{ formatHistoryKg(batch.received) }}
              </td>
              <td class="is-num" :class="{ 'cell-dim': !(batch.pending > 0) }">
                {{ formatHistoryKg(batch.pending) }}
              </td>
              <td>
                <span class="progress-value">{{ percentText(batch.progress) }}</span>
              </td>
              <td>
                <span class="state" :class="`state--${stateTone(batch)}`">
                  <i aria-hidden="true" />{{ batch.stateLabel }}
                </span>
              </td>
              <td>
                <div class="cell-rec">
                  <span v-if="batch.receiptCount">{{ batch.receiptCount }} 笔</span>
                  <span v-if="batch.voidedReceiptCount" class="rec-warn">撤 {{ batch.voidedReceiptCount }}</span>
                  <span v-if="batch.revisionCount" class="rec-warn">改 {{ batch.revisionCount }}</span>
                </div>
              </td>
              <td />
              <td class="history-action-cell">
                <button
                  type="button"
                  class="btn btn--text btn--sm history-delete"
                  aria-label="删除整个批次"
                  @click.stop="handleDeleteBatch(batch)"
                >
                  删批次
                </button>
              </td>
            </tr>

            <template v-if="isExpanded(batch.key)">
              <tr
                v-for="row in batch.orders"
                :key="row.id"
                class="order-row"
                :class="{ 'is-cancelled': row.cancelled }"
              >
                <td class="cell-product">
                  <span :title="row.product || row.skuId">{{ row.product || row.skuId || '—' }}</span>
                </td>
                <td class="cell-text" :title="row.color">{{ row.color || '—' }}</td>
                <td class="cell-text">{{ row.factoryName }}</td>
                <td class="cell-text">{{ row.assignee || '—' }}</td>
                <td class="cell-text cell-dim">{{ vatTextOf(row) }}</td>
                <td class="is-num">{{ formatHistoryKg(row.quantity) }}</td>
                <td class="is-num" :class="{ 'cell-dim': !(row.received > 0) }">
                  {{ formatHistoryKg(row.received) }}
                </td>
                <td class="is-num" :class="{ 'cell-dim': !(row.pending > 0) }">
                  {{ row.cancelled ? '—' : formatHistoryKg(row.pending) }}
                </td>
                <td>
                  <span class="progress-value">{{ row.cancelled ? '—' : percentText(row.progress) }}</span>
                </td>
                <td>
                  <span class="state" :class="`state--${stateTone(row)}`">
                    <i aria-hidden="true" />{{ row.stateLabel }}
                  </span>
                </td>
                <td>
                  <div class="cell-rec">
                    <span v-if="row.receiptCount">{{ row.receiptCount }} 笔</span>
                    <span v-if="row.voidedReceiptCount" class="rec-warn">撤 {{ row.voidedReceiptCount }}</span>
                    <span v-if="row.revisionCount" class="rec-warn">改 {{ row.revisionCount }}</span>
                  </div>
                </td>
                <td class="cell-note" :title="row.note">{{ row.note }}</td>
                <td class="history-action-cell">
                  <button
                    type="button"
                    class="btn btn--text btn--sm history-delete"
                    :aria-label="`删除 ${row.product || row.skuId} 的分订单`"
                    @click="handleDeleteOrder(row)"
                  >
                    删除
                  </button>
                </td>
              </tr>
            </template>
          </template>

          <tr v-if="!batches.length">
            <td :colspan="COLUMN_COUNT" class="history-empty">
              <b>没有符合条件的下单记录</b>
              <span>换个关键词或日期范围，或把状态切到「全部状态」看已作废的单</span>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="batches.length">
          <tr>
            <td :colspan="5">合计 · {{ totals.batchCount }} 个批次 / {{ totals.orderCount }} 张分订单</td>
            <td class="is-num">{{ formatHistoryKg(totals.quantity) }}</td>
            <td class="is-num">{{ formatHistoryKg(totals.received) }}</td>
            <td class="is-num">{{ formatHistoryKg(totals.pending) }}</td>
            <td :colspan="5" />
          </tr>
        </tfoot>
      </table>
    </div>
  </section>
</template>

<style scoped>
/* 子面板：撑满「采购下单」页剩下的高度，自己滚动 */
.history-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  color: var(--industrial-text);
}

.history-search {
  width: 280px;
  max-width: 100%;
}

.history-select {
  width: 112px;
}

.history-select--scope {
  width: 118px;
}

/* 日期用原生 input[type=date]：与这一页其它 input 同一套 .input 样式，不多引组件样式 */
.history-date {
  width: 142px;
}

.history-range {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.history-range__dash {
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.history-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.history-action-cell {
  text-align: center;
  white-space: nowrap;
}

.history-delete {
  color: var(--industrial-danger, #b5473c);
}

.history-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  border-radius: 3px;
}

.history-table {
  min-width: 1300px;
  font-size: 12.5px;
}

.history-table thead th {
  position: sticky;
  top: 0;
  z-index: 3;
  height: 32px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--industrial-muted);
}

.history-table tbody td {
  height: 34px;
}

/* 数字列一律左对齐：这一页是台账，左对齐才好逐行比数字。 */
.history-table th.is-num,
.history-table td.is-num {
  text-align: left;
}

/* ---------- 批次分组带 ---------- */
/* 分组带与子行共用同一套列：本级合计正好落在各列下面，不用再读一句"下单 X 已到 Y"。 */
.group-row {
  cursor: pointer;
}

.group-row td {
  height: 30px;
  border-top: 1px solid var(--industrial-grid);
  border-bottom: 1px solid var(--industrial-grid-light);
  background: var(--industrial-header);
}

.group-row.is-open td {
  background: #e9eff2;
}

.group-row:hover td {
  background: #e6edf1;
}

.group-row td.is-num {
  color: var(--industrial-text);
  font-weight: 600;
}

.group-id {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.group-caret {
  flex-shrink: 0;
  width: 10px;
  color: var(--industrial-muted);
  font-size: 9px;
  transition: transform 0.15s ease;
}

.group-row.is-open .group-caret {
  transform: rotate(90deg);
}

.group-code {
  flex-shrink: 0;
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.group-meta {
  overflow: hidden;
  color: var(--industrial-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 分订单行 ---------- */
.order-row {
  cursor: default;
}

.order-row td {
  background: #fff;
}

.order-row:hover td {
  background: var(--row-hover);
}

/* 子行缩进 + 左侧细引导线：一眼看出它挂在上面那个批次下 */
.order-row td:first-child {
  padding-left: 24px;
}

.order-row.is-cancelled .cell-product,
.order-row.is-cancelled .cell-text {
  color: #a9b4bb;
}

.order-row.is-cancelled td {
  background: #fbfcfc;
}

.order-row.is-cancelled td.is-num {
  color: #a9b4bb;
  font-weight: 400;
}

.cell-product {
  position: relative;
  overflow: hidden;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cell-product::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 9px;
  width: 1px;
  background: var(--industrial-grid-light);
}

.cell-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-dim {
  color: var(--industrial-muted);
}

.cell-note {
  overflow: hidden;
  color: var(--industrial-muted);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-rec {
  display: flex;
  gap: 6px;
  justify-content: flex-start;
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
}

.rec-warn {
  color: #a3803a;
}

/* ---------- 进度 / 状态 ---------- */
.progress-value {
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--industrial-muted);
  font-size: 11.5px;
  white-space: nowrap;
}

.state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c2cbd0;
}

.state--done {
  color: #3f7d5a;
}

.state--done i {
  background: #4f9a6f;
}

.state--partial {
  color: #8a6a24;
}

.state--partial i {
  background: #cba53f;
}

.state--cancelled {
  color: #a9b4bb;
}

.state--cancelled i {
  background: #c2cbd0;
}

.history-table tfoot td {
  position: sticky;
  bottom: 0;
  z-index: 2;
  height: 30px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.history-empty {
  height: 140px;
  text-align: center;
  color: var(--industrial-muted);
}

.history-empty b {
  display: block;
  margin-bottom: 4px;
  color: var(--industrial-text);
  font-size: 13px;
}

@media (max-width: 720px) {
  .history-search {
    width: 100%;
  }
}
</style>
