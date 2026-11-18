<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElOption, ElSelect } from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import { buildOrderHistory, filterHistory } from '@/purchase/history'
import { saveWorkbook } from '@/utils/xlsxWrite'

// 下单历史（只读）：标准订单列表的形制——单一表头 + 批次分组带 + 分订单行。
// 分组带是一整条横带（不重复表头），点它整组收放；子行只有一套列，不再套第二张表。
// 所有数字由订单流水派生；到货 / 改单 / 作废只在主面板的订单弹窗里做，这一页不提供写入口。
// 它是「采购下单」页的子面板（`/purchase/history`），外壳与标签页由 PurchaseOrderView 提供。
const COLUMN_COUNT = 12

const purchaseStore = usePurchaseStore()

const keyword = ref('')
const monthFilter = ref('all')
const statusFilter = ref('active')
const expandedKeys = ref(new Set())

const history = computed(() => buildOrderHistory(purchaseStore.orders?.orders ?? []))
const filtered = computed(() =>
  filterHistory(history.value, {
    keyword: keyword.value,
    month: monthFilter.value,
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

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatMoment(value) {
  const stamp = Date.parse(value ?? '')
  if (!Number.isFinite(stamp)) return '—'
  const date = new Date(stamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function formatNumber(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function percentOf(progress) {
  return `${Math.round(Math.min(1, Math.max(0, Number(progress) || 0)) * 100)}%`
}

function vatText(row) {
  if (row.vatCount && row.kgPerVat) return `${row.vatCount} 缸 × ${row.kgPerVat}`
  if (row.vatCount) return `${row.vatCount} 缸`
  if (row.kgPerVat) return `${row.kgPerVat} kg/缸`
  return '—'
}

// 状态一律用「圆点 + 文字」：满屏彩块会让人找不到重点。
function stateTone(entry) {
  if (entry.cancelled) return 'cancelled'
  if (entry.orderCount && entry.cancelledCount === entry.orderCount) return 'cancelled'
  return entry.receiveState
}

function handleExport() {
  if (!batches.value.length) return

  const batchRows = [
    ['批次号', '确认时间', '月份', 'SKU 数', '分订单', '作废单', '下单（kg）', '已到货（kg）', '待收（kg）', '到货进度', '状态'],
    ...batches.value.map((batch) => [
      batch.code,
      formatMoment(batch.submittedAt),
      batch.month,
      batch.skuCount,
      batch.orderCount,
      batch.cancelledCount,
      batch.quantity,
      batch.received,
      batch.pending,
      percentOf(batch.progress),
      batch.stateLabel,
    ]),
  ]

  const orderRows = [
    ['批次号', '确认时间', '品名', '颜色', '唯一标识', '染厂', '分单人员', '缸', '下单（kg）', '已到货（kg）', '待收（kg）', '状态', '到货记录', '撤回记录', '改单次数', '备注'],
  ]
  for (const batch of batches.value) {
    for (const row of batch.orders) {
      orderRows.push([
        batch.code,
        formatMoment(row.submittedAt),
        row.product,
        row.color,
        row.skuId,
        row.factoryName,
        row.assignee,
        vatText(row),
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

  try {
    const timestamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')
    saveWorkbook(
      [
        { name: '批次汇总', rows: batchRows, widths: [18, 18, 10, 8, 9, 9, 12, 12, 12, 10, 16] },
        {
          name: '分订单明细',
          rows: orderRows,
          widths: [18, 18, 22, 16, 20, 16, 12, 12, 12, 12, 12, 14, 10, 10, 10, 24],
        },
      ],
      `下单历史-${timestamp}.xlsx`,
    )
    ElMessage.success(`已导出 ${batches.value.length} 个批次 / ${totals.value.orderCount} 张分订单`)
  } catch (error) {
    console.error('Failed to export order history', error)
    ElMessage.error(`导出失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}
</script>

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
      <ElSelect v-model="monthFilter" size="small" class="history-select">
        <ElOption label="全部月份" value="all" />
        <ElOption v-for="month in history.months" :key="month" :label="month" :value="month" />
      </ElSelect>
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
          <col style="width: 88px" />
          <col style="width: 94px" />
          <col style="width: 84px" />
          <col style="width: 84px" />
          <col style="width: 100px" />
          <col style="width: 84px" />
          <col style="width: 104px" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>品名</th>
            <th>颜色</th>
            <th>染厂</th>
            <th>分单人员</th>
            <th>缸</th>
            <th class="is-num">下单（kg）</th>
            <th class="is-num">已到货</th>
            <th class="is-num">待收</th>
            <th>进度</th>
            <th>状态</th>
            <th class="is-num">到货 / 改动</th>
            <th>备注</th>
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
                    {{ formatMoment(batch.submittedAt) }} · {{ batch.skuCount }} SKU ·
                    {{ batch.orderCount }} 单
                    <template v-if="batch.cancelledCount"> · 作废 {{ batch.cancelledCount }}</template>
                  </span>
                </div>
              </td>
              <td class="is-num">{{ formatNumber(batch.quantity) }}</td>
              <td class="is-num" :class="{ 'cell-dim': !(batch.received > 0) }">
                {{ formatNumber(batch.received) }}
              </td>
              <td class="is-num" :class="{ 'cell-dim': !(batch.pending > 0) }">
                {{ formatNumber(batch.pending) }}
              </td>
              <td>
                <span class="progress-value">{{ percentOf(batch.progress) }}</span>
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
                <td class="cell-text cell-dim">{{ vatText(row) }}</td>
                <td class="is-num">{{ formatNumber(row.quantity) }}</td>
                <td class="is-num" :class="{ 'cell-dim': !(row.received > 0) }">
                  {{ formatNumber(row.received) }}
                </td>
                <td class="is-num" :class="{ 'cell-dim': !(row.pending > 0) }">
                  {{ row.cancelled ? '—' : formatNumber(row.pending) }}
                </td>
                <td>
                  <span class="progress-value">{{ row.cancelled ? '—' : percentOf(row.progress) }}</span>
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
              </tr>
            </template>
          </template>

          <tr v-if="!batches.length">
            <td :colspan="COLUMN_COUNT" class="history-empty">
              <b>没有符合条件的下单记录</b>
              <span>换个关键词，或把状态切到「全部状态」看已作废的单</span>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="batches.length">
          <tr>
            <td :colspan="5">合计 · {{ totals.batchCount }} 个批次 / {{ totals.orderCount }} 张分订单</td>
            <td class="is-num">{{ formatNumber(totals.quantity) }}</td>
            <td class="is-num">{{ formatNumber(totals.received) }}</td>
            <td class="is-num">{{ formatNumber(totals.pending) }}</td>
            <td :colspan="4" />
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

.history-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
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
