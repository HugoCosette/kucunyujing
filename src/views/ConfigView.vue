<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElButton, ElOption, ElSelect, ElTable, ElTableColumn } from 'element-plus'
import { stockingRules } from '@/data/stockingRules'
import {
  DEFAULT_PANEL_KEY,
  getPanelConfigLabel,
  isExamplePanel,
} from '@/data/panels'
import PanelNavigation from '@/components/PanelNavigation.vue'
import { useInventoryStore } from '@/stores/inventory'
import { groupRowsByProduct } from '@/utils/productGroups'
import {
  calculateInventoryRow,
  formatFactors,
  formatQuantity,
} from '@/utils/inventory'

// 示例配置（/example/config）复用同一份组件与计算逻辑，仅作对照演示，勿改示例数据。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const inventoryItems = useInventoryStore(props.panelKey).inventoryItems
const examplePanel = isExamplePanel(props.panelKey)
const configLabel = getPanelConfigLabel(props.panelKey)
const panelDescription = examplePanel
  ? '示例配置：维护示例面板的备货类型和色彩类别，仅供对照演示，请勿修改。'
  : '维护主面板的备货类型和色彩类别；备货策略根据规则自动计算。'
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const selectedRowId = ref(null)
const configTableRef = ref(null)
const collapsingProductKeys = ref(new Set())
const expandingProductKeys = ref(new Set())

const inventoryLeafRows = computed(() =>
  inventoryItems
    .map((item) => calculateInventoryRow(item, stockingRules))
    .sort(
      (first, second) =>
        productCollator.compare(first.product, second.product) ||
        Number(second.color === '黑色') - Number(first.color === '黑色') ||
        productCollator.compare(first.color, second.color) ||
        first.id - second.id,
    ),
)

const inventoryRows = computed(() => groupRowsByProduct(inventoryLeafRows.value))

// 配置信息页仍用 ElTable（含展开行与下拉），3 万行无法一次渲染：
// 行数小保持品名树形；行数大改为扁平分页，避免每个 SKU 两个下拉的渲染开销。
const CONFIG_FLAT_LIMIT = 500
const CONFIG_FLAT_PAGE_SIZE = 60
const CONFIG_PAGE_ROW_BUDGET = 300
const configFlat = computed(() => inventoryLeafRows.value.length > CONFIG_FLAT_LIMIT)
const configLeafPageCount = computed(() =>
  Math.max(1, Math.ceil(inventoryLeafRows.value.length / CONFIG_FLAT_PAGE_SIZE)),
)
const pagedLeafRows = computed(() => {
  const start = (configPage.value - 1) * CONFIG_FLAT_PAGE_SIZE
  return inventoryLeafRows.value.slice(start, start + CONFIG_FLAT_PAGE_SIZE)
})
const configPage = ref(1)
const configPages = computed(() => {
  const pages = []
  let currentPage = []
  let rowCount = 0

  for (const group of inventoryRows.value) {
    const groupRowCount = group.children.length
    if (currentPage.length > 0 && rowCount + groupRowCount > CONFIG_PAGE_ROW_BUDGET) {
      pages.push(currentPage)
      currentPage = []
      rowCount = 0
    }
    currentPage.push(group)
    rowCount += groupRowCount
  }
  if (currentPage.length > 0) pages.push(currentPage)
  return pages.length > 0 ? pages : [[]]
})
const configPageCount = computed(() =>
  configFlat.value ? configLeafPageCount.value : configPages.value.length,
)
const configTableRows = computed(() =>
  configFlat.value
    ? pagedLeafRows.value
    : configPages.value[Math.min(configPage.value, configPages.value.length) - 1] ?? [],
)

watch(configPageCount, (pageCount) => {
  if (configPage.value > pageCount) configPage.value = pageCount
})
const expandedProductKeys = ref(inventoryRows.value.map((row) => row.id))
let knownProductKeys = new Set(expandedProductKeys.value)
const productTransitionTimers = new Map()
const productTransitionDuration = 120

function clearProductTransition(productKey) {
  const timer = productTransitionTimers.get(productKey)
  if (timer) clearTimeout(timer)
  productTransitionTimers.delete(productKey)
  collapsingProductKeys.value.delete(productKey)
  expandingProductKeys.value.delete(productKey)
}

function animateProductExpansion(productKey) {
  clearProductTransition(productKey)
  expandingProductKeys.value.add(productKey)
  productTransitionTimers.set(
    productKey,
    setTimeout(() => {
      expandingProductKeys.value.delete(productKey)
      productTransitionTimers.delete(productKey)
    }, productTransitionDuration),
  )
}

function animateProductCollapse(row) {
  const productKey = row.id
  clearProductTransition(productKey)
  collapsingProductKeys.value.add(productKey)
  productTransitionTimers.set(
    productKey,
    setTimeout(() => {
      configTableRef.value?.toggleRowExpansion(row, false)
      collapsingProductKeys.value.delete(productKey)
      productTransitionTimers.delete(productKey)
    }, productTransitionDuration),
  )
}

watch(inventoryRows, (groups) => {
  const currentKeys = new Set(groups.map((row) => row.id))
  const expandedKeys = new Set(expandedProductKeys.value.filter((key) => currentKeys.has(key)))
  for (const group of groups) {
    if (!knownProductKeys.has(group.id)) expandedKeys.add(group.id)
  }
  knownProductKeys = currentKeys
  expandedProductKeys.value = [...expandedKeys]
})

function handleExpandChange(row, expanded) {
  if (!row.isProductGroup) return
  const keys = new Set(expandedProductKeys.value)
  if (expanded) keys.add(row.id)
  else keys.delete(row.id)
  expandedProductKeys.value = [...keys]
  if (expanded) animateProductExpansion(row.id)
}

function handleCellClick(row, column) {
  if (!row.isProductGroup || column.property !== 'product') return

  if (collapsingProductKeys.value.has(row.id)) {
    clearProductTransition(row.id)
    animateProductExpansion(row.id)
    return
  }

  const isExpanded = expandedProductKeys.value.includes(row.id)
  if (isExpanded) {
    animateProductCollapse(row)
    return
  }

  configTableRef.value?.toggleRowExpansion(row, true)
}

onBeforeUnmount(() => {
  productTransitionTimers.forEach((timer) => clearTimeout(timer))
})

function getCellClassName({ row, column }) {
  return row.isProductGroup && column.property === 'product'
    ? 'product-cell-clickable'
    : ''
}

function getRowClassName({ row }) {
  return [
    row.isProductGroup ? 'product-group-row' : 'product-color-row',
    collapsingProductKeys.value.has(`product:${row.product}`)
      ? 'product-group-collapsing'
      : '',
    expandingProductKeys.value.has(`product:${row.product}`)
      ? 'product-group-expanding'
      : '',
    !row.isProductGroup && row.id === selectedRowId.value ? 'inventory-row-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function handleRowClick(row) {
  if (row.isProductGroup) {
    selectedRowId.value = null
    return
  }

  selectedRowId.value = row.id
}

function updateValue(id, field, value) {
  if (value === null) return
  const item = inventoryItems.find((entry) => entry.id === id)
  if (item) item[field] = value
}
</script>

<template>
  <main class="config-page">
    <div class="config-content">
      <PanelNavigation />

      <header class="config-heading">
        <div>
          <h1>{{ configLabel }}</h1>
          <p>{{ panelDescription }}</p>
        </div>
        <span class="config-record-count">{{ inventoryLeafRows.length }} 条库存记录</span>
      </header>

      <ElTable
        ref="configTableRef"
        class="config-table"
        :data="configTableRows"
        row-key="id"
        :expand-row-keys="configFlat ? [] : expandedProductKeys"
        @expand-change="handleExpandChange"
        :tree-props="{ children: 'children' }"
        :cell-class-name="getCellClassName"
        :row-class-name="getRowClassName"
        @cell-click="handleCellClick"
        @row-click="handleRowClick"
        border
        table-layout="fixed"
      >
        <ElTableColumn label="商品" align="center">
          <ElTableColumn prop="product" label="品名" width="100" align="center">
            <template #default="{ row }">
              <span v-if="row.isProductGroup" class="config-product-name">{{ row.product }}</span>
              <span v-else class="config-product-text" :title="row.product">
                {{ row.product }}
              </span>
            </template>
          </ElTableColumn>
          <ElTableColumn prop="color" label="颜色" width="140" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-color-text" :title="row.color">
                {{ row.color }}
              </span>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="信息" align="center">
          <ElTableColumn label="备货类型" width="76" align="center">
            <template #default="{ row }">
              <ElSelect
                v-if="!row.isProductGroup"
                :model-value="row.stockingType"
                size="small"
                class="config-select"
                aria-label="备货类型"
                @update:model-value="updateValue(row.id, 'stockingType', $event)"
              >
                <ElOption label="热销" value="热销" />
                <ElOption label="常规" value="常规" />
              </ElSelect>
            </template>
          </ElTableColumn>
          <ElTableColumn label="色彩" width="64" align="center">
            <template #default="{ row }">
              <ElSelect
                v-if="!row.isProductGroup"
                :model-value="row.category"
                size="small"
                class="config-select"
                aria-label="色彩"
                @update:model-value="updateValue(row.id, 'category', $event)"
              >
                <ElOption label="黑白" value="黑白" />
                <ElOption label="彩色" value="彩色" />
              </ElSelect>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="备货策略" align="center">
          <ElTableColumn label="红线库存" width="68" align="center">
            <template #default="{ row }">
              {{ formatQuantity(row.redLineStock) }}
            </template>
          </ElTableColumn>
          <ElTableColumn label="正常库存" width="68" align="center">
            <template #default="{ row }">{{ formatQuantity(row.normalStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="峰值库存" width="68" align="center">
            <template #default="{ row }">{{ formatQuantity(row.peakStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="系数" width="68" align="center">
            <template #default="{ row }">
              <span
                v-if="!row.isProductGroup"
                :title="row.strategyAvailable ? '红线 / 正常 / 峰值' : '备货系数缺省'"
              >{{ formatFactors(row) }}</span>
            </template>
          </ElTableColumn>
        </ElTableColumn>
      </ElTable>

      <div v-if="configPageCount > 1" class="config-pager">
        <ElButton size="small" :disabled="configPage <= 1" @click="configPage -= 1">
          上一页
        </ElButton>
        <span class="config-pager-info">第 {{ configPage }} / {{ configPageCount }} 页</span>
        <ElButton
          size="small"
          :disabled="configPage >= configPageCount"
          @click="configPage += 1"
        >
          下一页
        </ElButton>
      </div>
    </div>
  </main>
</template>

<style scoped>
.config-page {
  min-height: 100vh;
  padding: 12px;
  color: var(--industrial-text);
  background: var(--industrial-page);
}

.config-content {
  width: 760px;
  max-width: 100%;
  margin: 0 auto;
}

.config-heading {
  width: 652px;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.config-heading h1 {
  margin: 0 0 4px;
  font-size: 20px;
}

.config-heading p {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 13px;
}

.config-record-count {
  flex: 0 0 auto;
  color: var(--industrial-muted);
  font-size: 13px;
}

.config-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 10px 0 0;
}

.config-pager-info {
  color: var(--industrial-muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.config-table {
  width: 652px;
  --el-color-primary: var(--industrial-primary);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-table-border-color: var(--industrial-grid);
  --el-table-header-bg-color: var(--industrial-header);
  --el-table-tr-bg-color: var(--industrial-surface);
  --el-table-row-hover-bg-color: var(--industrial-surface);
  --el-bg-color: var(--industrial-surface);
  --el-fill-color-blank: var(--industrial-surface);
  color: var(--industrial-text);
  font-size: 13px;
}

.config-table :deep(td.el-table__cell) {
  background-color: var(--industrial-surface) !important;
  padding: 2px 0;
}

.config-table :deep(.el-table__body tr.product-group-row > td.el-table__cell) {
  background-color: var(--industrial-header) !important;
  font-weight: 600;
}

.config-table :deep(td.product-cell-clickable) {
  cursor: pointer;
}

.config-table :deep(td.product-cell-clickable .el-table__expand-icon) {
  pointer-events: none;
}

.config-table :deep(tr.product-color-row.product-group-expanding > td) {
  animation: sku-row-enter 120ms ease-out both;
}

.config-table :deep(tr.product-color-row.product-group-collapsing > td) {
  animation: sku-row-leave 120ms ease-in forwards;
  pointer-events: none;
}

@keyframes sku-row-enter {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes sku-row-leave {
  to {
    opacity: 0;
    transform: translateY(-3px);
  }
}

.config-table :deep(th.el-table__cell) {
  padding: 2px 0;
  color: var(--industrial-text);
  background: var(--industrial-header) !important;
  font-weight: 500;
}

.config-table :deep(.cell) {
  padding: 0 2px;
  line-height: 20px;
  white-space: nowrap;
}

.config-table :deep(.el-table__body td.el-table__cell) {
  position: relative;
}

.config-table :deep(.el-table__body tr.inventory-row-selected > td.el-table__cell) {
  box-shadow: inset 0 2px rgba(63, 113, 141, 0.82), inset 0 -2px rgba(63, 113, 141, 0.82);
}

.config-table :deep(.el-table__body tr.inventory-row-selected > td.el-table__cell:first-child) {
  box-shadow:
    inset 2px 0 rgba(63, 113, 141, 0.82),
    inset 0 2px rgba(63, 113, 141, 0.82),
    inset 0 -2px rgba(63, 113, 141, 0.82);
}

.config-table :deep(.el-table__body tr.inventory-row-selected > td.el-table__cell:last-child) {
  box-shadow:
    inset -2px 0 rgba(63, 113, 141, 0.82),
    inset 0 2px rgba(63, 113, 141, 0.82),
    inset 0 -2px rgba(63, 113, 141, 0.82);
}

.config-product-name {
  display: inline-block;
  white-space: nowrap;
}

.config-product-text,
.config-color-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-select {
  width: 100%;
}

.config-select :deep(.el-select__wrapper) {
  min-height: 22px;
  padding: 0 2px;
  background: transparent;
  box-shadow: none;
}

.config-select :deep(.el-select__selected-item) {
  color: var(--industrial-text);
  font-size: 13px;
}

@media (max-width: 780px) {
  .config-content {
    width: 760px;
    max-width: none;
  }

  .config-page {
    overflow-x: auto;
  }
}
</style>
