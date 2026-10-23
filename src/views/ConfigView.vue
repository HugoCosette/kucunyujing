<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElOption, ElSelect, ElTable, ElTableColumn } from 'element-plus'
import { stockingRules } from '@/data/stockingRules'
import { useInventoryStore } from '@/stores/inventory'
import { groupRowsByProduct } from '@/utils/productGroups'
import {
  calculateInventoryRow,
  formatFactors,
  formatQuantity,
} from '@/utils/inventory'

const inventoryItems = useInventoryStore().inventoryItems
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
      <nav class="page-navigation" aria-label="页面导航">
        <RouterLink to="/" class="page-navigation-link">主面板</RouterLink>
        <RouterLink to="/config" class="page-navigation-link">配置信息</RouterLink>
      </nav>

      <header class="config-heading">
        <div>
          <h1>配置信息</h1>
          <p>维护备货类型和色彩类别；备货策略根据规则自动计算。</p>
        </div>
        <span class="config-record-count">{{ inventoryLeafRows.length }} 条库存记录</span>
      </header>

      <ElTable
        ref="configTableRef"
        class="config-table"
        :data="inventoryRows"
        row-key="id"
        :expand-row-keys="expandedProductKeys"
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
          <ElTableColumn prop="product" label="品名/颜色" width="140" align="center">
            <template #default="{ row }">
              <span v-if="row.isProductGroup" class="config-product-name">
                {{ row.product }}
              </span>
              <span v-else>{{ row.color }}</span>
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

.page-navigation {
  display: flex;
  gap: 6px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--industrial-grid);
}

.page-navigation-link {
  padding: 9px 16px;
  color: var(--industrial-muted);
  border-bottom: 2px solid transparent;
  text-decoration: none;
}

.page-navigation-link:hover,
.page-navigation-link.router-link-active {
  color: var(--industrial-primary);
}

.page-navigation-link.router-link-active {
  border-bottom-color: var(--industrial-primary);
  font-weight: 600;
}

.config-heading {
  width: 552px;
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

.config-table {
  width: 552px;
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
