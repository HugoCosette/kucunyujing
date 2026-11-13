<script setup>
import { computed, ref, watch } from 'vue'
import { ElCheckbox, ElMessage, ElMessageBox } from 'element-plus'
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
  if (!count) return
  const confirmed = await ElMessageBox.confirm(
    `解除全部 ${count} 个 SKU 的屏蔽？解除后会立即回到主面板。`,
    '全部解除屏蔽',
    { confirmButtonText: '全部解除', cancelButtonText: '取消', type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return

  await stockingStore.restoreAllHidden()
  ElMessage.success(`已解除全部屏蔽（${count} 个 SKU）`)
  clearSelection()
}
</script>

<template>
  <section class="hidden-panel" aria-label="屏蔽列表">
    <div class="page-head">
      <h1 class="page-title">屏蔽列表</h1>
      <div class="page-head__actions">
        <span class="meta">{{ groups.length }} 个品名 · {{ hiddenSkuTotal }} 个 SKU</span>
      </div>
    </div>

    <div class="page-toolbar" role="search">
      <label class="field hidden-search">
        <svg class="field__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4" />
          <path d="m10.2 10.2 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <input
          v-model="searchKeyword"
          class="input input--search hidden-search__input"
          type="text"
          placeholder="搜索品名 / 颜色 / SKU"
          aria-label="搜索屏蔽记录"
          @keydown.esc="searchKeyword = ''"
        />
        <button
          v-if="searchKeyword"
          class="icon-btn hidden-search__clear"
          type="button"
          aria-label="清空搜索"
          @click="searchKeyword = ''"
        >
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </label>

      <ElCheckbox
        class="hidden-check"
        :model-value="allSelected"
        :indeterminate="someSelected"
        :disabled="visibleGroups.length === 0"
        @change="toggleSelectAll"
      >
        全选
      </ElCheckbox>
      <span class="toolbar__sep" />
      <span class="meta">共 {{ hiddenSkuTotal }} 个 SKU，已选 {{ selectedCount }} 个</span>

      <div class="toolbar__end">
        <button
          class="btn btn--sm"
          type="button"
          :disabled="hiddenSkuTotal === 0"
          @click="restoreAll"
        >
          全部解除
        </button>
        <button
          class="btn btn--primary btn--sm"
          type="button"
          :disabled="selectedCount === 0"
          @click="restoreSelected"
        >
          解除屏蔽（{{ selectedCount }}）
        </button>
      </div>
    </div>

    <div class="table-card">
      <div class="hidden-list">
        <p v-if="groups.length === 0" class="hidden-empty">
          还没有屏蔽任何品名或 SKU
          <span class="hidden-empty__hint">
            在主面板勾选 SKU 后点右下角「屏蔽选中」即可记进这份清单，重新导入或刷新后仍然隐藏；解除后会立即回到主面板。
          </span>
        </p>
        <p v-else-if="visibleGroups.length === 0" class="hidden-empty">
          没有匹配「{{ searchKeyword.trim() }}」的屏蔽记录
        </p>

        <section v-for="group in visibleGroups" :key="group.product" class="hidden-group">
          <div
            class="hidden-group__head"
            role="button"
            tabindex="0"
            :aria-expanded="isGroupExpanded(group.product)"
            @click="toggleGroupExpanded(group.product)"
            @keydown.enter.prevent="toggleGroupExpanded(group.product)"
          >
            <ElCheckbox
              class="hidden-check"
              :model-value="groupState(group) === 'all'"
              :indeterminate="groupState(group) === 'some'"
              :aria-label="`选择品名 ${group.product}`"
              @click.stop
              @change="(checked) => toggleGroup(group, checked)"
            />
            <span
              class="hidden-caret"
              :class="{ 'is-open': isGroupExpanded(group.product) }"
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
            <span class="hidden-group__name">
              <span class="hidden-group__text" :title="group.product">
                {{ group.product || '（未记录品名）' }}
              </span>
              <span v-if="group.whole" class="tag">整组屏蔽</span>
            </span>
            <span class="hidden-group__meta">
              {{
                group.whole
                  ? `当前数据 ${group.skus.length} 个 SKU`
                  : `${group.skus.length} 个 SKU`
              }}
            </span>
            <button
              class="btn btn--text btn--sm"
              type="button"
              @click.stop="restoreGroup(group)"
            >
              解除
            </button>
          </div>

          <div v-if="isGroupExpanded(group.product)" class="hidden-group__body">
            <p v-if="group.visibleSkus.length === 0" class="hidden-empty hidden-empty--inline">
              {{ group.skus.length === 0 ? '当前数据中没有该品名' : '没有匹配的 SKU' }}
            </p>
            <div v-for="sku in group.visibleSkus" :key="sku.skuId" class="hidden-child">
              <ElCheckbox
                v-if="!group.whole"
                class="hidden-check"
                :model-value="selectedSkus.has(sku.skuId)"
                :aria-label="`选择 SKU ${sku.skuId}`"
                @change="(checked) => toggleSku(sku.skuId, checked)"
              />
              <span v-else class="hidden-child__dot" aria-hidden="true" />
              <span class="hidden-child__color" :title="sku.color">{{ sku.color || '—' }}</span>
              <span class="hidden-child__sku" :title="sku.skuId">{{ sku.skuId }}</span>
              <button
                v-if="!group.whole"
                class="btn btn--text btn--sm"
                type="button"
                @click.stop="restoreSku(sku)"
              >
                解除
              </button>
              <span v-else />
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.hidden-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.hidden-panel > .page-head {
  flex: none;
}

/* ---------- 工具条 ---------- */
.hidden-search {
  width: 232px;
}

.hidden-search__input {
  width: 100%;
  height: 26px;
  font-size: 12px;
}

.hidden-search__clear {
  position: absolute;
  right: 3px;
  width: 18px;
  height: 18px;
}

.hidden-search__clear svg {
  width: 11px;
  height: 11px;
}

.hidden-check {
  height: 20px;
  margin-right: 0;
}

.hidden-check :deep(.el-checkbox__label) {
  padding-left: 5px;
  color: var(--industrial-muted);
  font-size: 12px;
}

/* ---------- 清单 ---------- */
.table-card {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: var(--industrial-surface);
}

.hidden-list {
  flex: 1;
  min-height: 0;
  padding: 4px 0 8px;
  overflow: auto;
}

.hidden-group + .hidden-group {
  border-top: 1px solid var(--industrial-grid-light);
}

.hidden-group__head {
  display: grid;
  grid-template-columns: 16px 14px minmax(0, 1fr) 130px 56px;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  cursor: pointer;
}

.hidden-group__head:hover {
  background: var(--row-hover);
}

.hidden-group__head:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: -2px;
}

.hidden-caret {
  display: inline-flex;
  color: var(--industrial-muted);
  transition: transform 0.12s ease;
}

.hidden-caret svg {
  width: 12px;
  height: 12px;
}

.hidden-caret.is-open {
  transform: rotate(90deg);
}

.hidden-group__name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
}

.hidden-group__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hidden-group__name .tag {
  flex-shrink: 0;
  font-weight: 400;
}

.hidden-group__meta {
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
}

.hidden-group__body {
  padding: 0 12px 6px 62px;
}

.hidden-child {
  display: grid;
  grid-template-columns: 16px 210px minmax(0, 1fr) 56px;
  align-items: center;
  gap: 8px;
  height: 28px;
  border-top: 1px solid var(--line-soft);
}

.hidden-child__dot {
  justify-self: center;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--industrial-grid);
}

.hidden-child__color {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hidden-child__sku {
  overflow: hidden;
  color: var(--industrial-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hidden-empty {
  margin: 0;
  padding: 24px 12px;
  color: var(--industrial-muted);
  font-size: 12.5px;
  text-align: center;
}

.hidden-empty__hint {
  display: block;
  max-width: 560px;
  margin: 4px auto 0;
  font-size: 11.5px;
  line-height: 1.6;
  opacity: 0.85;
}

.hidden-empty--inline {
  padding: 6px 0 4px;
  font-size: 12px;
  text-align: left;
}

@media (max-width: 720px) {
  .hidden-search {
    width: 100%;
  }

  .hidden-group__head {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    padding: 6px 10px;
  }

  .hidden-group__name {
    flex: 1 1 120px;
  }

  .hidden-group__meta {
    order: 5;
    flex: 1 1 100%;
    padding-left: 24px;
    text-align: left;
  }

  .hidden-group__head .btn--text {
    margin-left: auto;
  }

  .hidden-group__body {
    padding: 0 10px 6px 34px;
  }

  .hidden-child {
    grid-template-columns: 16px 120px minmax(0, 1fr) 44px;
    gap: 6px;
  }
}
</style>