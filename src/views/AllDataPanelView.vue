<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ElInput, ElButton } from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { groupTableRowsByProduct, toQuantityValue, isQuantityCell } from '@/utils/productGroups'
import { resolveInventoryField } from '@/utils/inventoryImport'

// 全面板只读：导入后展示 Excel 原始表格；未导入时按同样形态展示默认数据的全部字段。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const inventoryStore = useInventoryStore(props.panelKey)
const inventoryItems = inventoryStore.inventoryItems
const importedSheet = computed(() => inventoryStore.importedSheet)
const rawMode = computed(() => Boolean(importedSheet.value?.columns?.length))
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

// 默认数据的全部字段：与导入模板同序，末尾补面板维护的需安排与计算出的热度。
const DEFAULT_SHEET_COLUMNS = [
  { key: 'product', label: '品名' },
  { key: 'color', label: '颜色' },
  { key: 'stockingType', label: '热度' },
  { key: 'category', label: '色彩' },
  { key: 'producing', label: '生产中' },
  { key: 'backorder', label: '欠货' },
  { key: 'weeklyUsage', label: '周消耗' },
  { key: 'warehouseStock', label: '在仓库存' },
  { key: 'inTransitStock', label: '在途库存' },
  { key: 'turnoverIn', label: '周转入' },
  { key: 'monthlyAvgCount', label: '月均条数' },
  { key: 'totalOrders', label: '订单总数' },
  { key: 'activeMonths', label: '动销月份' },
  { key: 'activeCustomers', label: '动销客户' },
  { key: 'planned', label: '需安排' },
]

function toCellValue(value) {
  return value === null || value === undefined ? '' : value
}

// 3 万行量级：一次性构建普通对象数组（shallowRef），不做逐行深度响应式。
const defaultTableRows = shallowRef([])

function rebuildDefaultRows() {
  const fields = DEFAULT_SHEET_COLUMNS.map((column) => column.key)
  const productMonthlyAvg = new Map()
  for (const item of inventoryItems) {
    productMonthlyAvg.set(item.product, (productMonthlyAvg.get(item.product) ?? 0) + (item.monthlyAvgCount ?? 0))
  }
  defaultTableRows.value = [...inventoryItems]
    .sort((first, second) => {
      const productDiff =
        (productMonthlyAvg.get(second.product) ?? 0) - (productMonthlyAvg.get(first.product) ?? 0)
      if (productDiff !== 0) return productDiff
      const monthlyDiff = (second.monthlyAvgCount ?? 0) - (first.monthlyAvgCount ?? 0)
      if (monthlyDiff !== 0) return monthlyDiff
      return productCollator.compare(first.color, second.color) || first.id - second.id
    })
    .map((item) => {
      const cells = fields.map((field) => toCellValue(item[field]))
      // 预存小写索引，搜索时只做 includes。
      return {
        id: item.id,
        cells,
        searchText: cells.join('\u0000').toLocaleLowerCase('zh-CN'),
      }
    })
}

rebuildDefaultRows()
// 行数变化（导入）与热度配置变化需要重建；数值编辑由路由切换后的重新挂载兜底。
watch(() => inventoryItems.length, rebuildDefaultRows)
watch(() => inventoryStore.heatSpecs, rebuildDefaultRows, { deep: true })

// 原始表格行：导入 Excel 的全部列与全部数据行。
const rawTableRows = shallowRef([])

function rebuildRawRows() {
  const sheet = importedSheet.value
  if (!sheet?.columns?.length) {
    rawTableRows.value = []
    return
  }
  const columnCount = sheet.columns.length
  // 找品名列与月均条数列，用于导入后的默认排序（按品名聚合月均条数降序）。
  const productIndex = sheet.columns.findIndex(
    (column) => resolveInventoryField(column.label) === 'product',
  )
  const monthlyIndex = sheet.columns.findIndex(
    (column) => resolveInventoryField(column.label) === 'monthlyAvgCount',
  )
  const rows = sheet.rows.map((row, index) => {
    const cells = Array.from(
      { length: columnCount },
      (_, cellIndex) => row.cells[cellIndex] ?? '',
    )
    return {
      id: index + 1,
      cells,
      searchText: cells.join('\u0000').toLocaleLowerCase('zh-CN'),
    }
  })
  if (productIndex >= 0 && monthlyIndex >= 0) {
    const productMonthlyAvg = new Map()
    for (const row of rows) {
      const product = String(row.cells[productIndex] ?? '').trim()
      const monthly = Number(row.cells[monthlyIndex])
      if (product && Number.isFinite(monthly)) {
        productMonthlyAvg.set(product, (productMonthlyAvg.get(product) ?? 0) + monthly)
      }
    }
    rows.sort((first, second) => {
      const firstProduct = String(first.cells[productIndex] ?? '').trim()
      const secondProduct = String(second.cells[productIndex] ?? '').trim()
      const productDiff =
        (productMonthlyAvg.get(secondProduct) ?? 0) - (productMonthlyAvg.get(firstProduct) ?? 0)
      if (productDiff !== 0) return productDiff
      const monthlyDiff = (Number(second.cells[monthlyIndex]) || 0) - (Number(first.cells[monthlyIndex]) || 0)
      if (monthlyDiff !== 0) return monthlyDiff
      return first.id - second.id
    })
  }
  rawTableRows.value = rows
}

rebuildRawRows()

// 搜索框输入防抖，避免 3 万行逐键全量过滤。
const searchKeyword = ref('')
const appliedKeyword = ref('')
// 品名父行默认全部展开，只记录被收起（折叠）的品名。
const collapsedProductIds = ref(new Set())
let searchDebounceTimer = 0

function applySearch() {
  searchDebounceTimer = 0
  appliedKeyword.value = searchKeyword.value.trim().toLocaleLowerCase('zh-CN')
}

watch(searchKeyword, () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  if (!searchKeyword.value.trim()) {
    applySearch()
    return
  }
  searchDebounceTimer = window.setTimeout(applySearch, 250)
})

// 重新导入后清空搜索并回到顶部，避免停留在旧表格的滚动位置。
watch(importedSheet, () => {
  rebuildRawRows()
  searchKeyword.value = ''
  appliedKeyword.value = ''
  collapsedProductIds.value = new Set()
  tableScrollTop.value = 0
  if (tableScrollRef.value) tableScrollRef.value.scrollTop = 0
})

const activeRows = computed(() => (rawMode.value ? rawTableRows.value : defaultTableRows.value))

const filteredLeafRows = computed(() => {
  const keyword = appliedKeyword.value
  const rows = activeRows.value
  if (!keyword) return rows
  return rows.filter((row) => row.searchText.includes(keyword))
})

// —— 虚拟滚动：只渲染视口内的行，DOM 节点数与数据量解耦 ——
const TABLE_ROW_HEIGHT = 34
const TABLE_OVERSCAN = 8

// 两种模式都是原始列，按表头文字估算列宽：长表头不截断，短表头不占宽。
function estimateColumnWidth(label) {
  return Math.min(240, Math.max(84, label.length * 14 + 24))
}

const defaultColumns = DEFAULT_SHEET_COLUMNS.map((column, index) => ({
  key: column.key,
  label: column.label,
  width: estimateColumnWidth(column.label),
  format: 'raw',
  index,
  field: column.key,
}))

const rawColumns = computed(() =>
  (importedSheet.value?.columns ?? []).map((column, index) => ({
    key: column.key,
    label: column.label,
    width: estimateColumnWidth(column.label),
    format: 'raw',
    index,
    field: resolveInventoryField(column.label),
  })),
)

const tableColumns = computed(() => (rawMode.value ? rawColumns.value : defaultColumns))
// 各列按自身宽度分摊剩余空间，宽屏铺满、窄屏横向滚动，右侧不留空白列。
const tableGridTemplate = computed(() =>
  tableColumns.value
    .map((column) => `minmax(${column.width}px, ${column.width}fr)`)
    .join(' '),
)
const tableTotalWidth = computed(() =>
  tableColumns.value.reduce((total, column) => total + column.width, 0),
)

// —— 品名（SPU）汇总：与主面板一致，父行在前、同品名的颜色行折叠在其下 ——
const productColumnIndex = computed(() =>
  tableColumns.value.findIndex((column) => column.field === 'product'),
)
const quantityColumnIndexes = computed(() => {
  const rows = activeRows.value
  return tableColumns.value
    .filter((column) => {
      // 已知文本列不参与汇总
      if (['category', 'product', 'color', 'stockingType'].includes(column.field)) return false
      if (['色彩', '品名', '颜色', '热度'].includes(column.label)) return false
      // 该列所有非空值都必须是数字（或空/占位），且至少有一个数字
      let hasNumber = false
      for (const row of rows) {
        if (!isQuantityCell(row.cells[column.index])) return false
        if (toQuantityValue(row.cells[column.index]) !== null) hasNumber = true
      }
      return hasNumber
    })
    .map((column) => column.index)
})

const productGroups = computed(() => {
  const productIndex = productColumnIndex.value
  if (productIndex < 0) return []
  return groupTableRowsByProduct(filteredLeafRows.value, {
    productIndex,
    quantityIndexes: quantityColumnIndexes.value,
    columnCount: tableColumns.value.length,
  })
})

// 默认全部展开，只记录被收起（折叠）的品名。
function toggleProductGroup(row) {
  const next = new Set(collapsedProductIds.value)
  if (next.has(row.id)) next.delete(row.id)
  else next.add(row.id)
  collapsedProductIds.value = next
}

function toggleAllProductGroups() {
  const groupIds = productGroups.value
    .filter((group) => group.isProductGroup)
    .map((group) => group.id)
  if (collapsedProductIds.value.size > 0) {
    collapsedProductIds.value = new Set()
  } else {
    collapsedProductIds.value = new Set(groupIds)
  }
}

const visibleRows = computed(() => {
  if (productColumnIndex.value < 0) return filteredLeafRows.value
  const collapsed = collapsedProductIds.value
  const rows = []
  for (const group of productGroups.value) {
    if (!group.isProductGroup) {
      rows.push(group)
      continue
    }
    rows.push(group)
    if (collapsed.has(group.id)) continue
    for (const child of group.children) rows.push(child)
  }
  return rows
})

const tableScrollRef = ref(null)
const tableScrollTop = ref(0)
const tableViewportHeight = ref(600)
let tableScrollFrame = 0
let tableResizeObserver = null

function handleTableScroll() {
  if (tableScrollFrame) return
  tableScrollFrame = requestAnimationFrame(() => {
    tableScrollFrame = 0
    tableScrollTop.value = tableScrollRef.value?.scrollTop ?? 0
  })
}

// 筛选后回到顶部，避免停留在旧滚动位置看到空白。
watch(appliedKeyword, () => {
  tableScrollTop.value = 0
  if (tableScrollRef.value) tableScrollRef.value.scrollTop = 0
})

const tableVirtualRows = computed(() => {
  const rows = visibleRows.value
  const total = rows.length
  if (total === 0) return { rows: [], offset: 0, total: 0 }

  const start = Math.max(0, Math.floor(tableScrollTop.value / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN)
  const count = Math.ceil(tableViewportHeight.value / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN * 2
  const end = Math.min(total, start + count)

  return {
    rows: rows.slice(start, end),
    offset: start * TABLE_ROW_HEIGHT,
    total,
  }
})
const tableBodyHeight = computed(() => tableVirtualRows.value.total * TABLE_ROW_HEIGHT)
const filteredRowCount = computed(() => filteredLeafRows.value.length)
const filteredProductCount = computed(
  () => productGroups.value.filter((row) => row.isProductGroup).length,
)
const totalRowCount = computed(() => activeRows.value.length)
const filteredRowCountText = computed(() => filteredRowCount.value.toLocaleString('zh-CN'))
const filteredProductCountText = computed(() =>
  filteredProductCount.value.toLocaleString('zh-CN'),
)
const totalRowCountText = computed(() => totalRowCount.value.toLocaleString('zh-CN'))

function formatCell(row, column) {
  return String(row.cells?.[column.index] ?? '')
}

onMounted(() => {
  const element = tableScrollRef.value
  if (!element) return
  tableViewportHeight.value = element.clientHeight || tableViewportHeight.value
  if (typeof ResizeObserver === 'undefined') return

  tableResizeObserver = new ResizeObserver((entries) => {
    tableViewportHeight.value = entries[0]?.contentRect.height ?? tableViewportHeight.value
  })
  tableResizeObserver.observe(element)
})

onBeforeUnmount(() => {
  if (tableScrollFrame) cancelAnimationFrame(tableScrollFrame)
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  tableResizeObserver?.disconnect()
})
</script>

<template>
  <main class="all-data-page">
    <div class="page-sticky-header">
      <PanelNavigation />
      <div class="all-data-toolbar">
        <h1 class="all-data-title">全部数据</h1>
        <ElInput
          v-model="searchKeyword"
          class="all-data-search"
          placeholder="搜索全部列"
          aria-label="搜索全部列"
          clearable
        />
        <ElButton
          class="all-data-toggle-groups"
          size="small"
          @click="toggleAllProductGroups"
        >
          {{ collapsedProductIds.size > 0 ? '全部展开' : '全部收起' }}
        </ElButton>
        <span class="all-data-count">
          共 {{ filteredRowCountText }} 行 · {{ filteredProductCountText }} 个品名
        </span>
        <span v-if="filteredRowCount !== totalRowCount" class="all-data-total">
          总计 {{ totalRowCountText }} 行
        </span>
        <span v-if="rawMode" class="all-data-hint">
          工作表“{{ importedSheet.sheetName }}”：Excel 全部 {{ tableColumns.length }}
          列原样只读展示，并按品名汇总
        </span>
        <span v-else class="all-data-hint">
          默认数据：未导入 Excel，按全部 {{ tableColumns.length }} 个字段只读展示，并按品名汇总
        </span>
      </div>
    </div>

    <div
      ref="tableScrollRef"
      class="all-data-vtable"
      role="table"
      aria-label="全部库存数据"
      @scroll.passive="handleTableScroll"
    >
      <div class="all-data-vtable__canvas" :style="{ width: `max(100%, ${tableTotalWidth}px)` }">
        <div class="all-data-vtable__head">
          <div
            class="all-data-vtable__row all-data-vtable__row--header"
            :style="{ gridTemplateColumns: tableGridTemplate }"
          >
            <div
              v-for="column in tableColumns"
              :key="column.key"
              class="all-data-vtable__head-cell"
              :class="{ 'all-data-vtable__cell--divider': column.field === 'monthlyAvgCount' }"
              role="columnheader"
              :title="column.label"
            >
              {{ column.label }}
            </div>
          </div>
        </div>

        <div class="all-data-vtable__body" :style="{ height: `${tableBodyHeight}px` }">
          <div
            class="all-data-vtable__rows"
            :style="{ transform: `translateY(${tableVirtualRows.offset}px)` }"
          >
            <div
              v-for="row in tableVirtualRows.rows"
              :key="row.id"
              class="all-data-vtable__row all-data-vtable__row--body"
              :class="{ 'all-data-vtable__row--group': row.isProductGroup }"
              role="row"
              :aria-expanded="
                row.isProductGroup ? !collapsedProductIds.has(row.id) : undefined
              "
              :style="{
                height: `${TABLE_ROW_HEIGHT}px`,
                gridTemplateColumns: tableGridTemplate,
              }"
              @click="row.isProductGroup && toggleProductGroup(row)"
            >
              <div
                v-for="column in tableColumns"
                :key="column.key"
                class="all-data-vtable__cell"
                :class="{ 'all-data-vtable__cell--divider': column.field === 'monthlyAvgCount' }"
                :title="formatCell(row, column)"
                role="cell"
              >
                <template v-if="row.isProductGroup && column.index === productColumnIndex">
                  <span
                    class="all-data-vtable__caret"
                    :class="{
                      'all-data-vtable__caret--expanded': !collapsedProductIds.has(row.id),
                    }"
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 12 12">
                      <path
                        d="M4 2.5 8 6l-4 3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.4"
                      />
                    </svg>
                  </span>
                  <span class="all-data-vtable__product" :title="row.product">
                    {{ row.product }}
                  </span>
                </template>
                <template v-else>{{ formatCell(row, column) }}</template>
              </div>
            </div>
          </div>
        </div>

        <div v-if="tableVirtualRows.total === 0" class="all-data-vtable__empty">
          {{ appliedKeyword ? '没有匹配的数据' : '暂无数据，请先在主面板导入 Excel' }}
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.all-data-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 12px;
  overflow: hidden;
  color: var(--industrial-text);
  background: var(--industrial-page);
}

.page-sticky-header {
  position: relative;
  z-index: 20;
  flex: 0 0 auto;
  margin: -12px -12px 0;
  padding: 12px 12px 0;
  background: var(--industrial-page);
  box-shadow: 0 6px 12px -10px rgba(34, 57, 69, 0.45);
}

.all-data-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 0 0 8px;
}

.all-data-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.all-data-search {
  width: 210px;
}

.all-data-count {
  color: var(--industrial-primary);
  font-size: 13px;
  font-weight: 600;
}

.all-data-total {
  color: var(--industrial-muted);
  font-size: 12px;
}

.all-data-hint {
  color: var(--industrial-muted);
  font-size: 12px;
}

.all-data-vtable {
  --vtable-border: var(--industrial-grid);
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--industrial-grid);
  background: var(--industrial-surface);
  color: var(--industrial-text);
  font-size: 13px;
}

.all-data-vtable__canvas {
  position: relative;
  min-width: 100%;
}

.all-data-vtable__head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--industrial-header);
}

.all-data-vtable__row {
  display: grid;
  align-items: stretch;
  border-bottom: 1px solid var(--industrial-grid);
}

.all-data-vtable__head-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 3px 4px;
  overflow: hidden;
  color: var(--industrial-text);
  border-right: 1px solid var(--industrial-grid);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.all-data-vtable__row > :last-child {
  border-right: 0;
}

.all-data-vtable__body {
  position: relative;
}

.all-data-vtable__rows {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
}

.all-data-vtable__row--body {
  background: var(--industrial-surface);
}

/* 周转入与月均条数之间的粗竖线分隔 */
.all-data-vtable__head-cell.all-data-vtable__cell--divider,
.all-data-vtable__cell.all-data-vtable__cell--divider {
  border-left: 2px solid var(--industrial-text);
}

.all-data-vtable__row--group {
  background: var(--industrial-header);
  font-weight: 600;
  cursor: pointer;
}

.all-data-vtable__caret {
  display: inline-flex;
  flex: 0 0 14px;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--industrial-muted);
  transition: transform 120ms ease;
}

.all-data-vtable__caret--expanded {
  transform: rotate(90deg);
}

.all-data-vtable__caret svg {
  width: 12px;
  height: 12px;
}

.all-data-vtable__product {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.all-data-vtable__cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 0 4px;
  overflow: hidden;
  border-right: 1px solid var(--industrial-grid-light);
  line-height: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.all-data-vtable__row--body:hover .all-data-vtable__cell {
  box-shadow:
    inset 0 2px rgba(63, 113, 141, 0.58),
    inset 0 -2px rgba(63, 113, 141, 0.58);
}

.all-data-vtable__empty {
  padding: 40px 0;
  color: var(--industrial-muted);
  font-size: 13px;
  text-align: center;
}

.all-data-vtable {
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-bg-color: var(--industrial-surface);
  --el-fill-color-blank: var(--industrial-surface);
}
</style>
