<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  ElButton,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElSelect,
  ElIcon,
  ElTable,
  ElTableColumn,
} from 'element-plus'
import { Delete } from '@element-plus/icons-vue'
import {
  COEFFICIENT_FIELDS,
  HEAT_CATEGORIES,
  HEAT_OPERATORS,
  HEAT_TYPES,
  cloneHeatSpecs,
  createHeatSpec,
  getHeatFieldLabel,
  toCoefficientMap,
} from '@/data/heatRules'
import { HEAT_FACTOR_FIELDS } from '@/data/quantityFields'
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
import { applyHeatSpecsToItems } from '@/utils/heatRules'

// 示例配置（/example/config）复用同一份组件与计算逻辑，仅作对照演示，勿改示例数据。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const inventoryStore = useInventoryStore(props.panelKey)
const inventoryItems = inventoryStore.inventoryItems
// 热度规格同时承载因子与系数，两块配置共用同一份草稿，确认后一起生效。
const specDraft = ref(cloneHeatSpecs(inventoryStore.heatSpecs))
const specDirty = computed(
  () => JSON.stringify(specDraft.value) !== JSON.stringify(inventoryStore.heatSpecs),
)
const examplePanel = isExamplePanel(props.panelKey)
const configLabel = getPanelConfigLabel(props.panelKey)
const panelDescription = examplePanel
  ? '示例配置：维护示例面板的热度和色彩类别，仅供对照演示，请勿修改。'
  : '维护主面板的热度和色彩类别；备货策略根据规则自动计算。'
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const selectedRowId = ref(null)
const configTableRef = ref(null)
const collapsingProductKeys = ref(new Set())
const expandingProductKeys = ref(new Set())

const inventoryLeafRows = computed(() => {
  const coefficientMap = toCoefficientMap(inventoryStore.heatSpecs)
  return inventoryItems
    .map((item) => calculateInventoryRow(item, coefficientMap))
    .sort(
      (first, second) =>
        productCollator.compare(first.product, second.product) ||
        Number(second.color === '黑色') - Number(first.color === '黑色') ||
        productCollator.compare(first.color, second.color) ||
        first.id - second.id,
    )
})

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

function availableFactorFields(spec) {
  const used = new Set(spec.factors.map((factor) => factor.field))
  return HEAT_FACTOR_FIELDS.filter((entry) => !used.has(entry.field))
}

function addFactor(spec, field) {
  if (!field) return
  if (spec.factors.some((factor) => factor.field === field)) return
  spec.factors.push({ field, operator: HEAT_OPERATORS[0].value, value: 0 })
}

function removeFactor(spec, field) {
  const index = spec.factors.findIndex((factor) => factor.field === field)
  if (index >= 0) spec.factors.splice(index, 1)
}

function addHeatSpec(type) {
  const spec = createHeatSpec(specDraft.value, type)
  const lastSameTypeIndex = specDraft.value
    .map((entry) => entry.type)
    .lastIndexOf(type)
  if (lastSameTypeIndex >= 0) {
    specDraft.value.splice(lastSameTypeIndex + 1, 0, spec)
    return
  }
  specDraft.value.push(spec)
}

function removeHeatSpec(id) {
  if (specDraft.value.length <= 1) return
  const index = specDraft.value.findIndex((spec) => spec.id === id)
  if (index >= 0) specDraft.value.splice(index, 1)
}

function resetSpecDraft() {
  specDraft.value = cloneHeatSpecs(inventoryStore.heatSpecs)
}

function confirmSpecConfig() {
  const labels = specDraft.value.map((spec) => spec.label.trim())
  if (labels.some((label) => !label)) {
    ElMessage.error('热度规格名称不能为空')
    return
  }
  if (new Set(labels).size !== labels.length) {
    ElMessage.error('热度规格名称不能重复')
    return
  }

  const nextSpecs = cloneHeatSpecs(specDraft.value)
  inventoryStore.heatSpecs = nextSpecs
  applyHeatSpecsToItems(inventoryItems, nextSpecs)
  specDraft.value = cloneHeatSpecs(nextSpecs)
  ElMessage.success('热度与系数配置已应用')
}
</script>

<template>
  <main class="config-page">
    <div class="config-content">
      <PanelNavigation />

      <header v-if="examplePanel" class="config-heading">
        <div>
          <h1>{{ configLabel }}</h1>
          <p>{{ panelDescription }}</p>
        </div>
      </header>

      <div class="config-top-grid">
      <section class="heat-config-section" aria-labelledby="heat-config-title">
        <div class="heat-config-heading">
          <h2 id="heat-config-title">热度配置</h2>
          <span class="heat-config-hint">
            按动销指标（月均条数 / 订单总数 / 动销月份 / 动销客户）依次匹配规格，第一个全部条件满足的规格生效；都不满足时兜底到最后一个规格。
          </span>
        </div>

        <div class="heat-config-groups">
          <section
            v-for="spec in specDraft"
            :key="spec.id"
            class="heat-config-group"
          >
            <div class="heat-config-group-heading">
              <ElInput
                v-model="spec.label"
                size="small"
                class="heat-spec-label"
                aria-label="热度规格名称"
              />
              <span class="heat-config-group-note">{{ spec.type }}规格</span>
              <ElButton
                size="small"
                text
                type="danger"
                class="heat-spec-remove"
                :disabled="specDraft.length <= 1"
                aria-label="删除热度规格"
                @click="removeHeatSpec(spec.id)"
              >
                <ElIcon><Delete /></ElIcon>
              </ElButton>
            </div>

            <div class="heat-factor-list">
              <div
                v-for="factor in spec.factors"
                :key="factor.field"
                class="heat-factor-row"
              >
                <span class="heat-factor-label">{{ getHeatFieldLabel(factor.field) }}</span>
                <ElSelect
                  v-model="factor.operator"
                  size="small"
                  class="heat-factor-operator"
                  aria-label="比较符"
                >
                  <ElOption
                    v-for="operator in HEAT_OPERATORS"
                    :key="operator.value"
                    :label="operator.label"
                    :value="operator.value"
                  />
                </ElSelect>
                <ElInputNumber
                  v-model="factor.value"
                  :min="0"
                  size="small"
                  class="heat-factor-value"
                  aria-label="阈值"
                />
                <ElButton
                  size="small"
                  text
                  type="danger"
                  class="heat-factor-remove"
                  aria-label="移除因子"
                  @click="removeFactor(spec, factor.field)"
                >
                  <ElIcon><Delete /></ElIcon>
                </ElButton>
              </div>
              <p v-if="!spec.factors.length" class="heat-factor-empty">
                尚未配置因子，该规格不会命中。
              </p>
            </div>

            <ElDropdown
              trigger="click"
              :disabled="!availableFactorFields(spec).length"
              @command="(field) => addFactor(spec, field)"
            >
              <ElButton size="small" text class="heat-factor-add">＋ 添加因子</ElButton>
              <template #dropdown>
                <ElDropdownMenu>
                  <ElDropdownItem
                    v-for="field in availableFactorFields(spec)"
                    :key="field.field"
                    :command="field.field"
                  >
                    {{ field.label }}
                  </ElDropdownItem>
                </ElDropdownMenu>
              </template>
            </ElDropdown>
          </section>
        </div>

        <div class="heat-config-add">
          <ElButton size="small" text @click="addHeatSpec(HEAT_TYPES[0])">
            ＋ {{ HEAT_TYPES[0] }}规格
          </ElButton>
          <ElButton size="small" text @click="addHeatSpec(HEAT_TYPES[1])">
            ＋ {{ HEAT_TYPES[1] }}规格
          </ElButton>
        </div>
      </section>

      <section class="coefficient-config-section" aria-labelledby="coefficient-config-title">
        <div class="coefficient-config-heading">
          <h2 id="coefficient-config-title">系数配置</h2>
          <span class="coefficient-config-hint">
            按热度 × 色彩类别维护红线 / 正常 / 峰值系数（单位：周）。
          </span>
        </div>

        <div class="coefficient-config-types">
          <section
            v-for="spec in specDraft"
            :key="spec.id"
            class="coefficient-config-type"
          >
            <h3>{{ spec.label }}系数</h3>
            <div class="coefficient-config-type-grid">
              <section
                v-for="category in HEAT_CATEGORIES"
                :key="category"
                class="coefficient-config-group"
              >
                <h4>{{ category }}</h4>
                <div
                  v-for="field in COEFFICIENT_FIELDS"
                  :key="field.key"
                  class="coefficient-config-row"
                >
                  <span>{{ field.label }}</span>
                  <ElInputNumber
                    v-model="spec.coefficients[category][field.key]"
                    :min="0"
                    size="small"
                    class="coefficient-config-input"
                    :aria-label="`${field.label}系数`"
                  />
                </div>
              </section>
            </div>
          </section>
        </div>
      </section>
      </div>

      <div class="config-actions">
        <span class="config-dirty">{{ specDirty ? '有未保存的修改' : '' }}</span>
        <ElButton size="small" :disabled="!specDirty" @click="resetSpecDraft">
          重置
        </ElButton>
        <ElButton
          size="small"
          type="primary"
          :disabled="!specDirty"
          @click="confirmSpecConfig"
        >
          确定
        </ElButton>
      </div>

      <div class="config-table-heading">
        <h2>备货详情</h2>
        <span class="config-record-count">{{ inventoryLeafRows.length }} 条库存记录</span>
      </div>

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
        table-layout="auto"
      >
        <ElTableColumn label="商品" align="center">
          <ElTableColumn prop="product" label="品名" align="center">
            <template #default="{ row }">
              <span v-if="row.isProductGroup" class="config-product-name">{{ row.product }}</span>
              <span v-else class="config-product-text" :title="row.product">
                {{ row.product }}
              </span>
            </template>
          </ElTableColumn>
          <ElTableColumn prop="color" label="颜色" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-color-text" :title="row.color">
                {{ row.color }}
              </span>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="信息" align="center">
          <ElTableColumn label="热度" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-heat-text">
                {{ row.stockingType }}
              </span>
            </template>
          </ElTableColumn>
          <ElTableColumn label="色彩" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-color-text" :title="row.category">
                {{ row.category }}
              </span>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="备货策略" align="center">
          <ElTableColumn label="红线库存" align="center">
            <template #default="{ row }">
              {{ formatQuantity(row.redLineStock) }}
            </template>
          </ElTableColumn>
          <ElTableColumn label="正常库存" align="center">
            <template #default="{ row }">{{ formatQuantity(row.normalStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="峰值库存" align="center">
            <template #default="{ row }">{{ formatQuantity(row.peakStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="系数" align="center">
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
  width: 100%;
  max-width: 100%;
  margin: 0 auto;
  padding: 0 12px;
  box-sizing: border-box;
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

.config-top-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  width: 100%;
  max-width: 100%;
  margin-bottom: 12px;
  align-items: stretch;
}

.heat-config-section {
  width: 100%;
  max-width: 100%;
  margin-bottom: 0;
  padding: 10px 12px;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  background: var(--industrial-surface);
}

.heat-config-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 8px;
}

.heat-config-heading h2 {
  margin: 0;
  font-size: 15px;
}

.heat-config-hint {
  color: var(--industrial-muted);
  font-size: 12px;
}

.heat-config-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.heat-config-group {
  padding: 8px 10px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
  background: var(--industrial-page);
}

.heat-config-group-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.heat-config-group-heading h3 {
  margin: 0;
  font-size: 13px;
}

.heat-config-group-note {
  color: var(--industrial-muted);
  font-size: 12px;
}

.heat-factor-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.heat-factor-row {
  display: grid;
  grid-template-columns: 56px 52px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 4px;
}

.heat-factor-label {
  font-size: 13px;
}

.heat-factor-operator,
.heat-factor-value {
  width: 100%;
}

.heat-factor-remove {
  padding: 0;
  color: var(--industrial-danger);
  font-size: 16px;
}

.heat-factor-empty {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
}

.heat-factor-add {
  margin-top: 4px;
  padding: 0;
  color: var(--industrial-primary);
}

.heat-config-add {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.heat-spec-label {
  width: 88px;
}

.heat-spec-label :deep(.el-input__wrapper) {
  background: var(--industrial-surface);
  box-shadow: 0 0 0 1px var(--industrial-grid-light) inset;
}

.heat-spec-remove {
  margin-left: auto;
  padding: 0;
  font-size: 15px;
}

.coefficient-config-section {
  width: 100%;
  max-width: 100%;
  margin-bottom: 0;
  padding: 10px 12px;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  background: var(--industrial-surface);
}

.coefficient-config-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 8px;
}

.coefficient-config-heading h2 {
  margin: 0;
  font-size: 15px;
}

.coefficient-config-hint {
  color: var(--industrial-muted);
  font-size: 12px;
}

.coefficient-config-types {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.coefficient-config-type h3 {
  margin: 0 0 4px;
  font-size: 13px;
}

.coefficient-config-type-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.coefficient-config-group {
  padding: 6px 8px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
  background: var(--industrial-page);
}

.coefficient-config-group h4 {
  margin: 0 0 4px;
  font-size: 12px;
}

.coefficient-config-row {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.coefficient-config-row:last-child {
  margin-bottom: 0;
}

.coefficient-config-input {
  width: 100%;
}

.config-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
  margin: 8px 0 12px;
}

.config-dirty {
  margin-right: auto;
  color: var(--industrial-muted);
  font-size: 12px;
}

.config-table-heading {
  width: 100%;
  max-width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
}

.config-table-heading h2 {
  margin: 0;
  font-size: 16px;
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
  width: 100%;
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

.config-heat-text {
  color: var(--industrial-text);
}

@media (max-width: 600px) {
  .config-top-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
