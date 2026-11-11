<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import SkuDetailDialog from '@/components/SkuDetailDialog.vue'
import SkuDetailTrigger from '@/components/SkuDetailTrigger.vue'
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import { HEAT_FACTOR_FIELDS } from '@/data/quantityFields'
import { SALES_MONTH_FIELDS, SALES_RATIO_COLUMNS, SALES_TABLE_COLUMNS } from '@/data/salesFields'
import { useInventoryStore } from '@/stores/inventory'
import { groupTableRowsByProduct } from '@/utils/productGroups'

// 销售表：品名、颜色与 4 个动销指标取主面板数据，1-12 月条数与重量由“导入销售表”叠加进来。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const inventoryStore = useInventoryStore(props.panelKey)
const inventoryItems = inventoryStore.inventoryItems
const salesSheet = computed(() => inventoryStore.salesSheet)
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

const PRODUCT_INDEX = 0
const COLOR_INDEX = 1
const MONTH_START_INDEX = SALES_TABLE_COLUMNS.findIndex((column) => column.month === 1)
const MONTH_COLUMN_WIDTH = 92
const tableColumns = SALES_TABLE_COLUMNS.map((column, index) => ({
  ...column,
  index,
  width:
    index === PRODUCT_INDEX
      ? 170
      : index === 1
        ? 130
        : column.month
          ? MONTH_COLUMN_WIDTH
          : 96,
}))
// 品名、颜色之后全部是数值列，参与品名父行求和；比例列（客户CR5率）单独按权重列加权平均。
const ratioColumnIndexes = new Set(
  SALES_RATIO_COLUMNS.map((entry) =>
    tableColumns.find((column) => column.key === entry.key)?.index,
  ).filter((index) => index !== undefined),
)
const quantityColumnIndexes = tableColumns
  .map((column) => column.index)
  .filter((index) => index > 1 && !ratioColumnIndexes.has(index))
const ratioColumns = SALES_RATIO_COLUMNS.map((entry) => ({
  index: tableColumns.find((column) => column.key === entry.key)?.index ?? -1,
  weightIndex: tableColumns.find((column) => column.key === entry.weightKey)?.index ?? -1,
}))

function toCellValue(value) {
  return value === null || value === undefined ? '' : value
}

function formatValue(value, column) {
  if (value === null || value === undefined || value === '') return ''
  if (column?.kind === 'percent') {
    const ratio = Number(value)
    return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : String(value)
  }
  return String(value)
}

function formatCell(row, column) {
  return formatValue(row.cells?.[column.index], column)
}

// 搜索索引按展示文本生成，比例列也能用「82.8%」这类写法搜到。
function buildSearchText(cells) {
  return cells
    .map((value, index) => formatValue(value, tableColumns[index]))
    .join('\u0000')
    .toLocaleLowerCase('zh-CN')
}

function buildSalesCells(item, sales) {
  const cells = [
    item.product,
    item.color,
    // 动销指标保留主面板导入值，销售表文件里的同名列不参与。
    ...HEAT_FACTOR_FIELDS.map(({ field }) => toCellValue(item[field])),
    // 客户CR5率只来自销售表，不进主面板与评分。
    toCellValue(sales?.cr5 ?? null),
  ]
  for (const { index } of SALES_MONTH_FIELDS) {
    // 每月三列：条数（换算值）+ 销量（公斤）+ 订单数
    cells.push(
      toCellValue(sales?.counts[index] ?? null),
      toCellValue(sales?.sales[index] ?? null),
      toCellValue(sales?.orders[index] ?? null),
    )
  }
  return cells
}

// 3 万行量级：一次性构建普通对象数组（shallowRef），不做逐行深度响应式。
const tableRows = shallowRef([])

function rebuildRows() {
  const bySku = salesSheet.value?.bySku ?? null
  // 品名按聚合月均条数排序，与主面板一致：高动销品名在前，且同一品名不被拆散。
  const productMonthlyAvg = new Map()
  for (const item of inventoryItems) {
    productMonthlyAvg.set(
      item.product,
      (productMonthlyAvg.get(item.product) ?? 0) + (item.monthlyAvgCount ?? 0),
    )
  }

  tableRows.value = [...inventoryItems]
    .sort((first, second) => {
      const productDiff =
        (productMonthlyAvg.get(second.product) ?? 0) -
        (productMonthlyAvg.get(first.product) ?? 0)
      if (productDiff !== 0) return productDiff
      // 聚合值相同时按品名排序，保证同一品名的行连续，父行不会被拆成多段。
      const productNameDiff = productCollator.compare(first.product, second.product)
      if (productNameDiff !== 0) return productNameDiff
      const monthlyDiff = (second.monthlyAvgCount ?? 0) - (first.monthlyAvgCount ?? 0)
      if (monthlyDiff !== 0) return monthlyDiff
      return productCollator.compare(first.color, second.color) || first.id - second.id
    })
    .map((item) => {
      const cells = buildSalesCells(item, bySku?.get(item.skuId))
      return {
        id: item.id,
        // 保留原始 SKU 行，颜色单元格的详情弹窗按它现算模式与系数。
        item,
        cells,
        // 预存小写索引，搜索时只做 includes。
        searchText: buildSearchText(cells),
      }
    })
}

rebuildRows()
// 主面板导入会替换全部库存行，销售表导入会替换叠加数据，两种情况都重建。
watch(() => inventoryItems.length, rebuildRows)
watch(salesSheet, rebuildRows)

// 当前主面板中命中销售表的 SKU 数：主面板重新导入后可能与导入时不同，按实际匹配展示。
const matchedSkuCount = computed(() => {
  const bySku = salesSheet.value?.bySku
  if (!bySku) return 0
  let matched = 0
  for (const item of inventoryItems) {
    if (bySku.has(item.skuId)) matched += 1
  }
  return matched
})

// 搜索框输入防抖，避免逐键全量过滤。
const searchKeyword = ref('')
const appliedKeyword = ref('')
// 品名父行默认全部展开，只记录被收起（折叠）的品名。
const collapsedProductIds = ref(new Set())
// SKU 详情弹窗挂在页面层级，行内只放触发按钮：弹窗放在虚拟行里会随行卸载，
// 遮罩也会被列表的 transform 容器裁掉。
const skuDetailVisible = ref(false)
const skuDetailItem = ref(null)

function openSkuDetail(item) {
  skuDetailItem.value = item
  skuDetailVisible.value = true
}
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

const filteredLeafRows = computed(() => {
  const keyword = appliedKeyword.value
  const rows = tableRows.value
  if (!keyword) return rows
  return rows.filter((row) => row.searchText.includes(keyword))
})

// —— 虚拟滚动：只渲染视口内的行，DOM 节点数与数据量解耦 ——
const TABLE_ROW_HEIGHT = 34
const TABLE_OVERSCAN = 8

// 各列按自身宽度分摊剩余空间，宽屏铺满、窄屏横向滚动，右侧不留空白列。
const tableGridTemplate = computed(() =>
  tableColumns.map((column) => `minmax(${column.width}px, ${column.width}fr)`).join(' '),
)
const tableTotalWidth = computed(() =>
  tableColumns.reduce((total, column) => total + column.width, 0),
)

// 品名（SPU）汇总：父行在前，同品名的颜色行折叠在其下。
const productGroups = computed(() =>
  groupTableRowsByProduct(filteredLeafRows.value, {
    productIndex: PRODUCT_INDEX,
    quantityIndexes: quantityColumnIndexes,
    ratioColumns,
    columnCount: tableColumns.length,
  }),
)

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
  collapsedProductIds.value =
    collapsedProductIds.value.size > 0 ? new Set() : new Set(groupIds)
}

const visibleRows = computed(() => {
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
const totalRowCount = computed(() => tableRows.value.length)
const filteredRowCountText = computed(() => filteredRowCount.value.toLocaleString('zh-CN'))
const filteredProductCountText = computed(() =>
  filteredProductCount.value.toLocaleString('zh-CN'),
)
const totalRowCountText = computed(() => totalRowCount.value.toLocaleString('zh-CN'))
const monthRangeText = computed(() => {
  const months = salesSheet.value?.months ?? []
  if (!months.length) return ''
  return months.length > 1 ? `${months[0]}-${months[months.length - 1]}月` : `${months[0]}月`
})
// 销售表带动销指标列时以它为准，否则沿用总表（或上一次）的值。
const metricSourceText = computed(() =>
  salesSheet.value?.metricFields?.length ? '动销指标取自销售表' : '动销指标沿用总表',
)

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
  <main class="sales-page">
    <div class="page-sticky-header">
      <PanelNavigation />
      <div class="sales-toolbar">
        <h1 class="sales-title">销售表</h1>
        <ElInput
          v-model="searchKeyword"
          class="sales-search"
          placeholder="搜索全部列"
          aria-label="搜索全部列"
          clearable
        />
        <ElButton class="sales-toggle-groups" size="small" @click="toggleAllProductGroups">
          {{ collapsedProductIds.size > 0 ? '全部展开' : '全部收起' }}
        </ElButton>
        <span class="sales-count">
          共 {{ filteredRowCountText }} 行 · {{ filteredProductCountText }} 个品名
        </span>
        <span v-if="filteredRowCount !== totalRowCount" class="sales-total">
          总计 {{ totalRowCountText }} 行
        </span>
        <span v-if="salesSheet" class="sales-hint">
          已叠加销售表“{{ salesSheet.fileName }}”：工作表“{{ salesSheet.sheetName }}”{{
            monthRangeText
          }} · 当前匹配 {{ matchedSkuCount.toLocaleString('zh-CN') }} 个SKU；{{ metricSourceText }}
        </span>
        <span v-else class="sales-hint">
          未导入销售表：请在主面板一次性导入“总表 + 销售表”，动销指标与 1-12 月数据都来自销售表
        </span>
      </div>
    </div>

    <div
      ref="tableScrollRef"
      class="sales-vtable"
      role="table"
      aria-label="销售表数据"
      @scroll.passive="handleTableScroll"
    >
      <div class="sales-vtable__canvas" :style="{ width: `max(100%, ${tableTotalWidth}px)` }">
        <div class="sales-vtable__head">
          <div
            class="sales-vtable__row sales-vtable__row--header"
            :style="{ gridTemplateColumns: tableGridTemplate }"
          >
            <div
              v-for="column in tableColumns"
              :key="column.key"
              class="sales-vtable__head-cell"
              :class="{
                'sales-vtable__cell--divider': column.index === MONTH_START_INDEX,
                'sales-vtable__head-cell--product': column.index === PRODUCT_INDEX,
              }"
              role="columnheader"
              :title="column.label"
            >
              {{ column.label }}
            </div>
          </div>
        </div>

        <div class="sales-vtable__body" :style="{ height: `${tableBodyHeight}px` }">
          <div
            class="sales-vtable__rows"
            :style="{ transform: `translateY(${tableVirtualRows.offset}px)` }"
          >
            <div
              v-for="row in tableVirtualRows.rows"
              :key="row.id"
              class="sales-vtable__row sales-vtable__row--body"
              :class="{ 'sales-vtable__row--group': row.isProductGroup }"
              role="row"
              :aria-expanded="row.isProductGroup ? !collapsedProductIds.has(row.id) : undefined"
              :style="{
                height: `${TABLE_ROW_HEIGHT}px`,
                gridTemplateColumns: tableGridTemplate,
              }"
              @click="row.isProductGroup && toggleProductGroup(row)"
            >
              <div
                v-for="column in tableColumns"
                :key="column.key"
                class="sales-vtable__cell"
                :class="{
                  'sales-vtable__cell--divider': column.index === MONTH_START_INDEX,
                  'sales-vtable__cell--product': column.index === PRODUCT_INDEX,
                  'sales-vtable__cell--color': column.index === COLOR_INDEX,
                }"
                :title="formatCell(row, column)"
                role="cell"
              >
                <template v-if="row.isProductGroup && column.index === PRODUCT_INDEX">
                  <span
                    class="sales-vtable__caret"
                    :class="{
                      'sales-vtable__caret--expanded': !collapsedProductIds.has(row.id),
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
                  <span class="sales-vtable__product" :title="row.product">
                    {{ row.product }}
                  </span>
                </template>
                <template v-else-if="column.index === COLOR_INDEX && row.item">
                  <span class="sales-vtable__color" :title="formatCell(row, column)">
                    {{ formatCell(row, column) }}
                  </span>
                  <SkuDetailTrigger :item="row.item" @open="openSkuDetail" />
                </template>
                <template v-else>{{ formatCell(row, column) }}</template>
              </div>
            </div>
          </div>
        </div>

        <div v-if="tableVirtualRows.total === 0" class="sales-vtable__empty">
          {{ appliedKeyword ? '没有匹配的数据' : '暂无数据，请先在主面板导入总表与销售表' }}
        </div>
      </div>
    </div>

    <SkuDetailDialog
      v-model:visible="skuDetailVisible"
      :item="skuDetailItem"
      :panel-key="panelKey"
    />
  </main>
</template>

<style scoped>
.sales-page {
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

.sales-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 0 0 8px;
}

.sales-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.sales-search {
  width: 210px;
}

.sales-file-input {
  display: none;
}

.sales-count {
  color: var(--industrial-primary);
  font-size: 13px;
  font-weight: 600;
}

.sales-total {
  color: var(--industrial-muted);
  font-size: 12px;
}

.sales-hint {
  color: var(--industrial-muted);
  font-size: 12px;
}

.sales-vtable {
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

.sales-vtable__canvas {
  position: relative;
  min-width: 100%;
}

.sales-vtable__head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--industrial-header);
}

.sales-vtable__row {
  display: grid;
  align-items: stretch;
  border-bottom: 1px solid var(--industrial-grid);
}

.sales-vtable__head-cell {
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

.sales-vtable__row > :last-child {
  border-right: 0;
}

.sales-vtable__body {
  position: relative;
}

.sales-vtable__rows {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
}

.sales-vtable__row--body {
  background: var(--industrial-surface);
}

/* 动销指标与销售月份之间的粗竖线分隔 */
.sales-vtable__head-cell.sales-vtable__cell--divider,
.sales-vtable__cell.sales-vtable__cell--divider {
  border-left: 2px solid var(--industrial-text);
}

.sales-vtable__row--group {
  background: var(--industrial-header);
  font-weight: 600;
  cursor: pointer;
}

.sales-vtable__caret {
  display: inline-flex;
  flex: 0 0 14px;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--industrial-muted);
  transition: transform 120ms ease;
}

.sales-vtable__caret--expanded {
  transform: rotate(90deg);
}

.sales-vtable__caret svg {
  width: 12px;
  height: 12px;
}

.sales-vtable__product {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sales-vtable__cell {
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

.sales-vtable__cell--product,
.sales-vtable__head-cell--product {
  justify-content: flex-start;
}

.sales-vtable__cell--color {
  gap: 2px;
}

.sales-vtable__color {
  overflow: hidden;
  min-width: 0;
  text-overflow: ellipsis;
}

.sales-vtable__row--body:hover .sales-vtable__cell {
  box-shadow:
    inset 0 2px rgba(63, 113, 141, 0.58),
    inset 0 -2px rgba(63, 113, 141, 0.58);
}

.sales-vtable__empty {
  padding: 40px 0;
  color: var(--industrial-muted);
  font-size: 13px;
  text-align: center;
}

.sales-vtable {
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-bg-color: var(--industrial-surface);
  --el-fill-color-blank: var(--industrial-surface);
}
</style>
