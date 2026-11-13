<script setup>
import { computed, ref, watch } from 'vue'
import { ElButton, ElCheckbox, ElInput, ElMessage } from 'element-plus'
import { countHiddenSkus } from '@/stocking'
import { useInventoryStore } from '@/stores/inventory'
import { useStockingConfigStore } from '@/stores/stocking'

// 屏蔽列表：主面板上「屏蔽选中」的品名与 SKU 都记在这里，解除后立即回到主面板。
// 屏蔽只是不展示，源表与销售数据不动，重新导入、刷新页面都按这份清单过滤。
const inventoryStore = useInventoryStore()
const stockingStore = useStockingConfigStore()

const searchKeyword = ref('')
const selectedProducts = ref(new Set())
const selectedSkus = ref(new Set())
const collapsedProducts = ref(new Set())

// 按品名分组的屏蔽树：
// - 品名级屏蔽（整组）：子行展示当前数据里的 SKU（只读），用来确认恢复后会回来多少；
// - SKU 级屏蔽：子行是可勾选的 SKU 快照，可逐个 / 整组解除，也能跨品名多选。
const groups = computed(() => {
  const hiddenProducts = stockingStore.hidden?.products ?? []
  const hiddenSkus = stockingStore.hidden?.skus ?? {}

  const skusByProduct = new Map()
  for (const item of inventoryStore.inventoryItems) {
    const product = String(item?.product ?? '')
    const list = skusByProduct.get(product) ?? []
    list.push({ skuId: String(item?.skuId ?? ''), color: String(item?.color ?? '') })
    skusByProduct.set(product, list)
  }

  const result = new Map()
  for (const product of hiddenProducts) {
    result.set(product, {
      product,
      whole: true,
      skus: skusByProduct.get(product) ?? [],
    })
  }
  for (const [skuId, entry] of Object.entries(hiddenSkus)) {
    const product = String(entry?.product ?? '')
    let group = result.get(product)
    if (!group) {
      group = { product, whole: false, skus: [] }
      result.set(product, group)
    }
    group.skus.push({ skuId, color: String(entry?.color ?? '') })
  }
  return [...result.values()]
})

const keyword = computed(() => searchKeyword.value.trim().toLowerCase())

// 搜索只影响展示：品名命中时展示整组，只命中颜色 / SKU 时只展示命中的子行。
const visibleGroups = computed(() => {
  if (!keyword.value) return groups.value.map((group) => ({ ...group, visibleSkus: group.skus }))

  const result = []
  for (const group of groups.value) {
    const productHit = group.product.toLowerCase().includes(keyword.value)
    const visibleSkus = productHit
      ? group.skus
      : group.skus.filter(
          (sku) =>
            sku.color.toLowerCase().includes(keyword.value) ||
            sku.skuId.toLowerCase().includes(keyword.value),
        )
    if (!productHit && visibleSkus.length === 0) continue
    result.push({ ...group, visibleSkus })
  }
  return result
})

// 角标 / 头部按 SKU 计：整组屏蔽的品名按当前数据里该品名的 SKU 数展开。
const hiddenSkuTotal = computed(() =>
  countHiddenSkus(stockingStore.hidden, inventoryStore.inventoryItems),
)

function clearSelection() {
  selectedProducts.value = new Set()
  selectedSkus.value = new Set()
}

// 清单变化（解除 / 又屏蔽）后剔除已不存在的选中项，避免「已选 3 个」却只解除 2 个。
watch(
  () => stockingStore.hidden,
  (hidden) => {
    const products = new Set(hidden?.products ?? [])
    const skus = new Set(Object.keys(hidden?.skus ?? {}))
    const nextProducts = new Set(
      [...selectedProducts.value].filter((product) => products.has(product)),
    )
    const nextSkus = new Set([...selectedSkus.value].filter((skuId) => skus.has(skuId)))
    if (nextProducts.size !== selectedProducts.value.size) selectedProducts.value = nextProducts
    if (nextSkus.size !== selectedSkus.value.size) selectedSkus.value = nextSkus
  },
)

// 搜索时强制展开命中分组，避免「搜到了却看不到子行」。
function isGroupExpanded(product) {
  if (keyword.value) return true
  return !collapsedProducts.value.has(product)
}

function toggleGroupExpanded(product) {
  if (keyword.value) return
  const next = new Set(collapsedProducts.value)
  if (next.has(product)) next.delete(product)
  else next.add(product)
  collapsedProducts.value = next
}

function groupState(group) {
  if (group.whole) return selectedProducts.value.has(group.product) ? 'all' : 'none'
  if (group.visibleSkus.length === 0) return 'none'

  let selected = 0
  for (const sku of group.visibleSkus) {
    if (selectedSkus.value.has(sku.skuId)) selected += 1
  }
  if (selected === 0) return 'none'
  return selected === group.visibleSkus.length ? 'all' : 'some'
}

function toggleGroup(group, checked) {
  if (group.whole) {
    const next = new Set(selectedProducts.value)
    if (checked) next.add(group.product)
    else next.delete(group.product)
    selectedProducts.value = next
    return
  }

  const next = new Set(selectedSkus.value)
  for (const sku of group.visibleSkus) {
    if (checked) next.add(sku.skuId)
    else next.delete(sku.skuId)
  }
  selectedSkus.value = next
}

function toggleSku(skuId, checked) {
  const next = new Set(selectedSkus.value)
  if (checked) next.add(skuId)
  else next.delete(skuId)
  selectedSkus.value = next
}

const allSelected = computed(
  () => visibleGroups.value.length > 0 && visibleGroups.value.every((group) => groupState(group) === 'all'),
)
const someSelected = computed(
  () => !allSelected.value && visibleGroups.value.some((group) => groupState(group) !== 'none'),
)
// 已选数量按 SKU 计：选中整组品名时按它当前数据里的 SKU 数累加（不在当前数据里时按 1 算）。
const selectedCount = computed(() => {
  let count = selectedSkus.value.size
  for (const group of groups.value) {
    if (!group.whole || !selectedProducts.value.has(group.product)) continue
    count += Math.max(group.skus.length, 1)
  }
  return count
})

function toggleSelectAll(checked) {
  if (!checked) {
    clearSelection()
    return
  }

  const products = new Set(selectedProducts.value)
  const skus = new Set(selectedSkus.value)
  for (const group of visibleGroups.value) {
    if (group.whole) products.add(group.product)
    else for (const sku of group.visibleSkus) skus.add(sku.skuId)
  }
  selectedProducts.value = products
  selectedSkus.value = skus
}

async function restoreSelected() {
  const products = [...selectedProducts.value]
  const skus = [...selectedSkus.value]
  if (products.length === 0 && skus.length === 0) return

  await stockingStore.restoreHiddenEntries({ products, skus })
  ElMessage.success(`已解除屏蔽 ${products.length + skus.length} 项`)
  clearSelection()
}

async function restoreGroup(group) {
  if (group.whole) {
    await stockingStore.restoreHiddenEntries({ products: [group.product] })
    ElMessage.success(`已解除品名「${group.product}」的屏蔽`)
    return
  }
  // 搜索只减少了展示的子行，解除仍按整组来：避免「筛掉的那几个 SKU」留在清单里。
  const skuIds = groups.value.find((entry) => entry.product === group.product)?.skus ?? group.skus
  if (skuIds.length === 0) return

  await stockingStore.restoreHiddenEntries({ skus: skuIds.map((sku) => sku.skuId) })
  ElMessage.success(`已解除屏蔽 ${skuIds.length} 个 SKU`)
}

async function restoreSku(sku) {
  await stockingStore.restoreHiddenEntries({ skus: [sku.skuId] })
  ElMessage.success(`已解除屏蔽「${sku.skuId}」`)
}

async function restoreAll() {
  const count = hiddenSkuTotal.value
  await stockingStore.restoreAllHidden()
  ElMessage.success(`已解除全部屏蔽（${count} 个 SKU）`)
  clearSelection()
}
</script>

<template>
  <section class="hidden-panel" aria-label="屏蔽列表">
    <div class="hidden-panel__toolbar">
      <ElInput
        v-model="searchKeyword"
        class="hidden-panel__search"
        placeholder="搜索品名 / 颜色 / SKU"
        aria-label="搜索屏蔽记录"
        clearable
      />
      <ElCheckbox
        class="hidden-panel__select-all"
        :model-value="allSelected"
        :indeterminate="someSelected"
        :disabled="visibleGroups.length === 0"
        @change="toggleSelectAll"
      >
        全选
      </ElCheckbox>
      <span class="hidden-panel__count">
        共 {{ hiddenSkuTotal }} 个 SKU，已选 {{ selectedCount }} 个
      </span>
      <div class="hidden-panel__actions">
        <ElButton size="small" :disabled="hiddenSkuTotal === 0" @click="restoreAll">
          全部解除
        </ElButton>
        <ElButton
          size="small"
          type="primary"
          :disabled="selectedCount === 0"
          @click="restoreSelected"
        >
          解除屏蔽（{{ selectedCount }}）
        </ElButton>
      </div>
    </div>

    <div class="hidden-panel__list">
      <p v-if="groups.length === 0" class="hidden-panel__empty">还没有屏蔽任何品名或 SKU</p>
      <p v-else-if="visibleGroups.length === 0" class="hidden-panel__empty">
        没有匹配「{{ searchKeyword.trim() }}」的屏蔽记录
      </p>

      <section v-for="group in visibleGroups" :key="group.product" class="hidden-skus-group">
        <div
          class="hidden-skus-group__head"
          role="button"
          tabindex="0"
          :aria-expanded="isGroupExpanded(group.product)"
          @click="toggleGroupExpanded(group.product)"
          @keydown.enter.prevent="toggleGroupExpanded(group.product)"
        >
          <ElCheckbox
            class="hidden-skus-check"
            :model-value="groupState(group) === 'all'"
            :indeterminate="groupState(group) === 'some'"
            :aria-label="`选择品名 ${group.product}`"
            @click.stop
            @change="(checked) => toggleGroup(group, checked)"
          />
          <span
            class="hidden-skus-caret"
            :class="{ 'hidden-skus-caret--open': isGroupExpanded(group.product) }"
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
          <span class="hidden-skus-name">
            <span class="hidden-skus-name__text" :title="group.product">
              {{ group.product || '（未记录品名）' }}
            </span>
            <span v-if="group.whole" class="hidden-skus-tag">整组屏蔽</span>
          </span>
          <span class="hidden-skus-meta">
            {{
              group.whole
                ? `当前数据 ${group.skus.length} 个 SKU`
                : `${group.skus.length} 个 SKU`
            }}
          </span>
          <ElButton
            size="small"
            text
            type="primary"
            class="hidden-skus-restore"
            @click.stop="restoreGroup(group)"
          >
            解除
          </ElButton>
        </div>

        <div v-if="isGroupExpanded(group.product)" class="hidden-skus-children">
          <p v-if="group.visibleSkus.length === 0" class="hidden-skus-child-empty">
            {{ group.skus.length === 0 ? '当前数据中没有该品名' : '没有匹配的 SKU' }}
          </p>
          <div v-for="sku in group.visibleSkus" :key="sku.skuId" class="hidden-skus-child">
            <ElCheckbox
              v-if="!group.whole"
              class="hidden-skus-check"
              :model-value="selectedSkus.has(sku.skuId)"
              :aria-label="`选择 SKU ${sku.skuId}`"
              @change="(checked) => toggleSku(sku.skuId, checked)"
            />
            <span v-else class="hidden-skus-child__dot" aria-hidden="true" />
            <span class="hidden-skus-child__color" :title="sku.color">{{ sku.color || '—' }}</span>
            <span class="hidden-skus-child__sku" :title="sku.skuId">{{ sku.skuId }}</span>
            <ElButton
              v-if="!group.whole"
              size="small"
              text
              type="primary"
              class="hidden-skus-restore"
              @click.stop="restoreSku(sku)"
            >
              解除
            </ElButton>
            <span v-else />
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.hidden-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  background: var(--industrial-surface);
}

.hidden-panel__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--industrial-grid);
}

.hidden-panel__search {
  flex: 1 1 220px;
  width: auto;
  max-width: 320px;
}

.hidden-panel__count {
  color: var(--industrial-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.hidden-panel__actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.hidden-panel__list {
  max-height: min(62vh, 720px);
  overflow: auto;
}

.hidden-panel__empty {
  margin: 0;
  padding: 40px 12px;
  color: var(--industrial-muted);
  font-size: 13px;
  text-align: center;
}

.hidden-skus-group {
  border-bottom: 1px solid var(--industrial-grid);
}

.hidden-skus-group:last-child {
  border-bottom: 0;
}

.hidden-skus-check {
  margin-right: 0;
}

.hidden-skus-group__head {
  display: grid;
  grid-template-columns: 20px 16px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  background: var(--industrial-header);
  cursor: pointer;
  font-size: 13px;
}

.hidden-skus-group__head:hover {
  background: #e8eff2;
}

.hidden-skus-group__head:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: -2px;
}

.hidden-skus-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--industrial-muted);
  transition: transform 120ms ease;
}

.hidden-skus-caret--open {
  transform: rotate(90deg);
}

.hidden-skus-caret svg {
  width: 12px;
  height: 12px;
}

.hidden-skus-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.hidden-skus-name__text {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hidden-skus-tag {
  flex: 0 0 auto;
  padding: 0 6px;
  color: var(--industrial-danger);
  border: 1px solid #f0dcd9;
  border-radius: 999px;
  background: #faf2f1;
  font-size: 11px;
  line-height: 16px;
}

.hidden-skus-meta {
  color: var(--industrial-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.hidden-skus-restore {
  height: 22px;
  padding: 0 6px;
  font-size: 12px;
}

.hidden-skus-children {
  padding: 3px 12px 6px 44px;
}

.hidden-skus-child {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto 44px;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 13px;
}

.hidden-skus-child + .hidden-skus-child {
  border-top: 1px dashed var(--industrial-grid-light);
}

.hidden-skus-child__dot {
  width: 6px;
  height: 6px;
  margin-left: 7px;
  border-radius: 50%;
  background: var(--industrial-muted);
  opacity: 0.45;
}

.hidden-skus-child__color {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hidden-skus-child__sku {
  color: var(--industrial-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.hidden-skus-child-empty {
  margin: 0;
  padding: 6px 0 4px;
  color: var(--industrial-muted);
  font-size: 12px;
}

@media (max-width: 720px) {
  .hidden-panel__toolbar {
    align-items: stretch;
  }

  .hidden-panel__search {
    flex-basis: 100%;
    max-width: none;
  }

  .hidden-panel__actions {
    margin-left: auto;
  }

  .hidden-skus-group__head {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
  }

  .hidden-skus-name {
    flex: 1 1 120px;
  }

  .hidden-skus-meta {
    order: 5;
    flex: 1 1 100%;
    padding-left: 24px;
  }

  .hidden-skus-restore {
    margin-left: auto;
  }

  .hidden-skus-children {
    padding-left: 28px;
  }

  .hidden-skus-child {
    grid-template-columns: 20px minmax(0, 1fr) auto 40px;
    gap: 6px;
  }
}
</style>
