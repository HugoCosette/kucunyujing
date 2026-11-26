<script setup>
import { computed, ref, watch } from 'vue'
import { ElButton, ElDialog, ElInput } from 'element-plus'
import { saveWorkbook } from '@/utils/xlsxWrite'

// 「SKU 数据变动」：每次导入后跟上一份比出来的差异，回答「今天到底变了什么」。
// 主面板是全量数据，逐行看是看不出变化的；这里只列变过的 SKU，未变的只在汇总里报个数。
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  entries: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue'])

// 明细先渲染这么多行，再多就靠筛选 / 导出 —— 20 万行 SKU 直接铺进弹窗会把主线程卡住。
const ROW_LIMIT = 200

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'changed', label: '有变化' },
  { key: 'added', label: '新增' },
  { key: 'removed', label: '消失' },
  { key: 'warehouseKg', label: '在仓' },
  { key: 'weeklySales', label: '周销量' },
  { key: 'producing', label: '排单' },
  { key: 'producedIn', label: '入库' },
  { key: 'renamed', label: '改名' },
]

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const index = ref(0)
const filter = ref('all')
const keyword = ref('')

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    index.value = 0
    filter.value = 'all'
    keyword.value = ''
  },
)

const current = computed(() => props.entries[index.value] ?? null)
const summary = computed(() => current.value?.summary ?? null)
const rows = computed(() => current.value?.rows ?? [])

function matchesFilter(row, key) {
  if (key === 'all' || key === 'changed') return true
  if (key === 'added' || key === 'removed') return row.kind === key
  if (key === 'renamed') return Boolean(row.renamed)
  return Array.isArray(row.changes) && row.changes.some((change) => change.key === key)
}

const counts = computed(() => {
  const result = {}
  for (const item of FILTERS) {
    result[item.key] = rows.value.filter((row) => matchesFilter(row, item.key)).length
  }
  result.changed = rows.value.length
  return result
})

const filteredRows = computed(() => {
  const key = filter.value
  const word = keyword.value.trim().toLocaleLowerCase('zh-CN')
  return rows.value.filter((row) => {
    if (!matchesFilter(row, key)) return false
    if (!word) return true
    return (
      String(row.product ?? '').toLocaleLowerCase('zh-CN').includes(word) ||
      String(row.color ?? '').toLocaleLowerCase('zh-CN').includes(word) ||
      String(row.skuId ?? '').toLocaleLowerCase('zh-CN').includes(word)
    )
  })
})

const visibleRows = computed(() => filteredRows.value.slice(0, ROW_LIMIT))
const hiddenRowCount = computed(() => Math.max(0, filteredRows.value.length - ROW_LIMIT))

const entryOptions = computed(() =>
  props.entries.map((entry, position) => ({
    value: position,
    label: labelOf(entry, position),
  })),
)

function labelOf(entry, position) {
  const when = formatFullMoment(entry?.at)
  return position === 0 ? `最新 · ${when}` : when
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatFullMoment(value) {
  const stamp = Date.parse(value ?? '')
  if (!Number.isFinite(stamp)) return '时间未知'
  const date = new Date(stamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

// 变动是相对量：不写死 0 / 缺省，空值用「—」区分「本来没有」和「变成 0」。
function formatValue(value) {
  if (value === null || value === undefined) return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function formatDelta(change) {
  if (change.delta === null || change.delta === undefined) return ''
  const amount = Number(change.delta)
  if (!Number.isFinite(amount)) return ''
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '±'
  return `${sign}${Math.abs(amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
}

function deltaClass(change) {
  if (change.delta === null || change.delta === undefined) return ''
  if (change.delta > 0) return 'is-up'
  if (change.delta < 0) return 'is-down'
  return ''
}

function rowTitle(row) {
  if (row.kind === 'added') return '这次导入才出现的 SKU'
  if (row.kind === 'removed') return '这次导入里没有这个 SKU 了'
  if (row.renamed) {
    return `品名 / 颜色有改动：${row.previousProduct ?? ''} ${row.previousColor ?? ''}`
  }
  return ''
}

function exportRows() {
  if (!rows.value.length) return
  const header = ['唯一标识', '品名', '颜色', '变化类型', '字段', '旧值', '新值', '差值']
  const lines = [header]
  for (const row of rows.value) {
    const kind = row.kind === 'added' ? '新增' : row.kind === 'removed' ? '消失' : '变化'
    if (!row.changes.length) {
      lines.push([row.skuId, row.product, row.color, kind, kind === '消失' ? '整行消失' : '整行新增', '', '', ''])
      continue
    }
    for (const change of row.changes) {
      lines.push([
        row.skuId,
        row.product,
        row.color,
        kind,
        `${change.label}${change.unit ? `（${change.unit}）` : ''}`,
        formatValue(change.from),
        formatValue(change.to),
        formatDelta(change),
      ])
    }
  }
  saveWorkbook(
    [{ name: 'SKU数据变动', rows: lines, widths: [22, 18, 16, 10, 18, 12, 12, 12] }],
    `SKU数据变动-${formatFullMoment(current.value?.at).replace(/[: ]/g, '-')}.xlsx`,
  )
}
</script>

<template>
  <ElDialog
    v-model="visible"
    class="diff-dialog"
    width="min(1180px, calc(100vw - 32px))"
    append-to-body
    align-center
  >
    <template #header>
      <div class="diff-head">
        <h2 class="diff-head__title">SKU 数据变动</h2>
        <span v-if="summary" class="diff-head__meta">{{ formatFullMoment(current.at) }}</span>
        <select v-if="entryOptions.length > 1" v-model.number="index" class="diff-head__picker" aria-label="选择导入批次">
          <option v-for="option in entryOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>
    </template>

    <div v-if="summary" class="diff-body">
      <div class="diff-files">
        <span v-if="current.files?.inventory">总表：{{ current.files.inventory }}</span>
        <span v-if="current.files?.sales">销售表：{{ current.files.sales }}</span>
      </div>

      <div class="diff-overview">
        <span class="diff-stat">当前 <b>{{ formatValue(summary.total) }}</b> 个 SKU</span>
        <span class="diff-stat">有变化 <b class="is-up">{{ formatValue(summary.changedRows) }}</b></span>
        <span class="diff-stat">新增 <b>{{ formatValue(summary.added) }}</b></span>
        <span class="diff-stat">消失 <b>{{ formatValue(summary.removed) }}</b></span>
        <span class="diff-stat">未变 <b>{{ formatValue(summary.unchanged) }}</b></span>
        <span v-if="summary.renamed" class="diff-stat">改名 <b>{{ formatValue(summary.renamed) }}</b></span>
      </div>

      <div class="diff-toolbar">
        <div class="diff-chips" role="group" aria-label="变动筛选">
          <button
            v-for="item in FILTERS"
            :key="item.key"
            type="button"
            class="diff-chip"
            :class="{ 'diff-chip--active': filter === item.key }"
            :aria-pressed="filter === item.key"
            @click="filter = item.key"
          >
            {{ item.label }}
            <span class="diff-chip__count">{{ counts[item.key] }}</span>
          </button>
        </div>
        <ElInput
          v-model="keyword"
          class="diff-search"
          placeholder="品名 / 颜色 / SKU"
          aria-label="按品名或颜色搜索变动"
          clearable
        />
      </div>

      <div class="diff-table">
        <div class="diff-table__head">
          <span>商品</span>
          <span>变动（旧 → 新）</span>
        </div>
        <div class="diff-table__body">
          <div v-if="!visibleRows.length" class="diff-empty">
            这个筛选下没有变动的 SKU
          </div>
          <div v-for="row in visibleRows" :key="row.skuId" class="diff-row">
            <div class="diff-row__sku" :title="row.skuId">
              <span class="diff-row__product">{{ row.product || '—' }}</span>
              <span class="diff-row__color">{{ row.color || '—' }}</span>
            </div>
            <div class="diff-row__changes" :title="rowTitle(row)">
              <span v-if="row.kind === 'added'" class="diff-tag diff-tag--added">新增</span>
              <span v-else-if="row.kind === 'removed'" class="diff-tag diff-tag--removed">消失</span>
              <span v-else>
                <span v-if="row.renamed" class="diff-change">
                  <em class="diff-change__label">名称</em>
                  <b>{{ row.previousProduct }} {{ row.previousColor }}</b>
                  <i>→</i>
                  <b>{{ row.product }} {{ row.color }}</b>
                </span>
                <span
                  v-for="change in row.changes"
                  :key="change.key"
                  class="diff-change"
                >
                  <em class="diff-change__label">{{ change.label }}</em>
                  <b>{{ formatValue(change.from) }}</b>
                  <i>→</i>
                  <b>{{ formatValue(change.to) }}</b>
                  <u v-if="formatDelta(change)" :class="deltaClass(change)">{{ formatDelta(change) }}</u>
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="diff-foot">
        <span v-if="hiddenRowCount">
          已显示前 {{ ROW_LIMIT }} 行，还有 {{ formatValue(hiddenRowCount) }} 行没列出 —— 收窄筛选或导出 Excel 看全部
        </span>
        <span v-else>共 {{ formatValue(filteredRows.length) }} 行</span>
        <ElButton size="small" class="diff-export" :disabled="!rows.length" @click="exportRows">
          导出 Excel
        </ElButton>
      </div>
    </div>
    <div v-else class="diff-empty diff-empty--page">还没有导入记录，导入一次分表后这里会有变动明细</div>
  </ElDialog>
</template>

<style scoped>
:global(.el-dialog.diff-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-padding-primary: 0;
  --el-dialog-bg-color: var(--industrial-surface);
  padding: 0;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  height: auto;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

:global(.diff-dialog .el-dialog__header) {
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid var(--industrial-grid);
  background: var(--industrial-header);
}

:global(.diff-dialog .el-dialog__body) {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.diff-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.diff-head__title {
  margin: 0;
  color: var(--industrial-text);
  font-size: 13.5px;
  font-weight: 600;
}

.diff-head__meta {
  color: var(--industrial-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.diff-head__picker {
  margin-left: auto;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: #fff;
  color: var(--industrial-text);
  font-size: 11.5px;
}

.diff-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
}

.diff-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--industrial-grid-light);
  color: var(--industrial-muted);
  font-size: 10.5px;
}

.diff-overview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--industrial-grid-light);
  background: #fbfcfd;
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.diff-stat b {
  margin-left: 3px;
  color: var(--industrial-text);
  font-variant-numeric: tabular-nums;
}

.diff-stat b.is-up {
  color: var(--industrial-primary);
}

.diff-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--industrial-grid);
}

.diff-chips {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.diff-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: #fff;
  color: var(--industrial-text);
  font-size: 11.5px;
  cursor: pointer;
}

.diff-chip:hover {
  border-color: var(--industrial-primary);
  color: var(--industrial-primary);
}

.diff-chip--active {
  border-color: var(--industrial-primary);
  background: rgba(63, 113, 141, 0.1);
  color: var(--industrial-primary);
  font-weight: 600;
}

.diff-chip__count {
  color: var(--industrial-muted);
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

.diff-chip--active .diff-chip__count {
  color: var(--industrial-primary);
}

.diff-search {
  flex: 0 0 190px;
  width: 190px;
  margin-left: auto;
}

.diff-table {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  flex-direction: column;
}

.diff-table__head {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 10px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--industrial-grid);
  background: #f5f8f9;
  color: var(--industrial-muted);
  font-size: 10.5px;
  font-weight: 600;
}

.diff-table__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.diff-row {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--industrial-grid-light);
  font-size: 11.5px;
}

.diff-row:hover {
  background: #f8fafb;
}

.diff-row__sku {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.diff-row__product {
  overflow: hidden;
  color: var(--industrial-text);
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.diff-row__color {
  flex: 0 0 auto;
  color: var(--industrial-text);
  white-space: nowrap;
}

.diff-row__changes {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  min-width: 0;
}

.diff-change {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  white-space: nowrap;
}

.diff-change__label {
  color: var(--industrial-muted);
  font-size: 10.5px;
  font-style: normal;
}

.diff-change b {
  color: var(--industrial-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.diff-change i {
  color: #a4b0b7;
  font-style: normal;
}

.diff-change u {
  margin-left: 2px;
  padding: 0 4px;
  border-radius: 2px;
  background: #eef3f6;
  font-size: 10.5px;
  text-decoration: none;
  font-variant-numeric: tabular-nums;
}

.diff-change u.is-up {
  background: rgba(63, 113, 141, 0.12);
  color: var(--industrial-primary);
}

.diff-change u.is-down {
  background: rgba(176, 74, 62, 0.1);
  color: var(--industrial-danger);
}

.diff-tag {
  padding: 0 6px;
  border-radius: 2px;
  font-size: 10.5px;
}

.diff-tag--added {
  background: rgba(63, 127, 79, 0.12);
  color: var(--industrial-normal);
}

.diff-tag--removed {
  background: rgba(176, 74, 62, 0.1);
  color: var(--industrial-danger);
}

.diff-empty {
  padding: 24px 12px;
  color: var(--industrial-muted);
  font-size: 11.5px;
  text-align: center;
}

.diff-empty--page {
  padding: 40px 12px;
}

.diff-foot {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-top: 1px solid var(--industrial-grid);
  background: #fbfcfd;
  color: var(--industrial-muted);
  font-size: 10.5px;
}

.diff-export {
  margin-left: auto;
}
</style>
