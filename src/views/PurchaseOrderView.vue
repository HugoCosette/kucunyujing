<script setup>
import { computed, ref, watch } from 'vue'
import { ElButton, ElCheckbox, ElInput, ElMessage, ElMessageBox } from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import SkuOrderEditor from '@/components/SkuOrderEditor.vue'
import VirtualList from '@/components/VirtualList.vue'
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { usePurchaseStore } from '@/stores/purchase'
import { categoryForSku } from '@/purchase'
import { formatQuantity } from '@/utils/inventory'

// 采购下单：左侧是「本次采购清单」里的 SKU，右侧按染厂拆这张 SKU 的分订单。
// 数据只来自主面板已采纳的需安排；分订单以唯一标识为键，重新导入后自动保留。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const inventoryStore = useInventoryStore(props.panelKey)
const purchaseStore = usePurchaseStore()

const keyword = ref('')
const onlyUnordered = ref(false)
const selectedKey = ref(null)

const itemById = computed(() => {
  const map = new Map()
  for (const item of inventoryStore.inventoryItems) map.set(item.id, item)
  return map
})

const rows = computed(() =>
  inventoryStore.purchaseList.map((entry) => {
    const item = itemById.value.get(entry.id)
    const skuId = String(entry.skuId ?? item?.skuId ?? '').trim()
    const summary = purchaseStore.orderSummary(skuId)
    return {
      id: entry.id,
      key: entry.id,
      skuId,
      product: item?.product ?? entry.product,
      color: item?.color ?? entry.color,
      treeCategory: categoryForSku(purchaseStore.settings, skuId, item?.treeCategory),
      planned: Number(entry.planned) || 0,
      ordered: summary.total,
      orderCount: summary.count,
    }
  }),
)

const filteredRows = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (onlyUnordered.value && row.ordered > 0) return false
    if (!text) return true
    return (
      row.product.toLowerCase().includes(text) ||
      row.color.toLowerCase().includes(text) ||
      row.treeCategory.toLowerCase().includes(text)
    )
  })
})

const selectedRow = computed(
  () => rows.value.find((row) => row.key === selectedKey.value) ?? null,
)

// 选择被筛选掉或清单被清空时，自动落到第一行，避免右侧显示上一张单。
watch(
  filteredRows,
  (list) => {
    if (list.some((row) => row.key === selectedKey.value)) return
    selectedKey.value = list[0]?.key ?? null
  },
  { immediate: true },
)

const entries = computed({
  get: () => (selectedRow.value ? purchaseStore.orderEntries(selectedRow.value.skuId) : []),
  set: (value) => {
    if (selectedRow.value) purchaseStore.setOrderEntries(selectedRow.value.skuId, value)
  },
})

const stats = computed(() => {
  const orderedSkus = rows.value.filter((row) => row.ordered > 0).length
  return {
    skuCount: rows.value.length,
    planned: rows.value.reduce((sum, row) => sum + row.planned, 0),
    ordered: rows.value.reduce((sum, row) => sum + row.ordered, 0),
    pending: rows.value.length - orderedSkus,
  }
})

async function clearCurrentOrders() {
  if (!selectedRow.value) return
  try {
    await ElMessageBox.confirm(
      `确定清空「${selectedRow.value.product} ${selectedRow.value.color}」的全部分订单？`,
      '清空分订单',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  purchaseStore.clearOrderEntries(selectedRow.value.skuId)
  ElMessage.success('已清空该 SKU 的分订单')
}

function selectRow(row) {
  selectedKey.value = row.key
}
</script>

<template>
  <main class="purchase-page">
    <div class="purchase-content">
      <header class="purchase-heading">
        <PanelNavigation />
        <div class="purchase-heading__row">
          <div>
            <h1>采购下单</h1>
            <p>
              在「本次采购清单」的需安排基础上，按染厂把每个 SKU 拆成多张分订单；分订单按唯一标识保存，重新导入不丢。
            </p>
          </div>
          <dl class="purchase-stats">
            <div class="purchase-stats__item">
              <dt>待下单 SKU</dt>
              <dd>{{ stats.skuCount }}</dd>
            </div>
            <div class="purchase-stats__item">
              <dt>需安排合计</dt>
              <dd>{{ formatQuantity(stats.planned) }}</dd>
            </div>
            <div class="purchase-stats__item">
              <dt>已下单合计</dt>
              <dd>{{ formatQuantity(stats.ordered) }}</dd>
            </div>
            <div class="purchase-stats__item">
              <dt>还没下单</dt>
              <dd>{{ stats.pending }}</dd>
            </div>
          </dl>
        </div>
      </header>

      <div v-if="rows.length === 0" class="purchase-empty">
        <p>本次采购清单还是空的。</p>
        <p>回到主面板勾选 SKU、完成批量/紧急补货后，这里就会出现待下单的 SKU。</p>
        <RouterLink class="purchase-empty__link" to="/">返回主面板</RouterLink>
      </div>

      <div v-else class="purchase-body">
        <section class="purchase-panel purchase-panel--list">
          <div class="purchase-panel__head">
            <span class="purchase-panel__title">待下单 SKU</span>
            <span class="purchase-panel__count">{{ filteredRows.length }} / {{ rows.length }}</span>
          </div>
          <div class="purchase-toolbar">
            <ElInput
              v-model="keyword"
              size="small"
              placeholder="筛选品名 / 颜色 / 树形分类"
              clearable
            />
            <ElCheckbox v-model="onlyUnordered" size="small">只看未下单</ElCheckbox>
          </div>
          <VirtualList class="purchase-sku-list" :items="filteredRows" :item-height="64">
            <template #default="{ item: row }">
              <button
                type="button"
                class="purchase-sku"
                :class="{ 'purchase-sku--active': row.key === selectedKey }"
                @click="selectRow(row)"
              >
                <span class="purchase-sku__name">{{ row.product }} · {{ row.color }}</span>
                <span class="purchase-sku__meta">{{ row.treeCategory || '树形分类未维护' }}</span>
                <span class="purchase-sku__qty">
                  需安排 {{ formatQuantity(row.planned) }} · 已下单
                  <strong :class="{ 'purchase-sku__qty--done': row.ordered > 0 }">
                    {{ formatQuantity(row.ordered) }}
                  </strong>
                  <template v-if="row.orderCount">（{{ row.orderCount }} 张）</template>
                </span>
              </button>
            </template>
          </VirtualList>
        </section>

        <section class="purchase-panel purchase-panel--detail">
          <template v-if="selectedRow">
            <div class="purchase-panel__head">
              <div class="purchase-detail__title">
                <span class="purchase-panel__title">
                  {{ selectedRow.product }} · {{ selectedRow.color }}
                </span>
                <span class="purchase-panel__count">
                  {{ selectedRow.treeCategory || '树形分类未维护' }}
                </span>
              </div>
              <ElButton
                size="small"
                text
                type="danger"
                :disabled="selectedRow.orderCount === 0"
                @click="clearCurrentOrders"
              >
                清空分订单
              </ElButton>
            </div>
            <div class="purchase-detail__body">
              <SkuOrderEditor v-model="entries" :item="selectedRow" />
            </div>
          </template>
          <p v-else class="purchase-detail__placeholder">左侧选择一个 SKU 开始下单</p>
        </section>
      </div>
    </div>
  </main>
</template>

<style scoped>
.purchase-page {
  height: 100vh;
  padding: 12px;
  overflow: hidden;
  background: var(--industrial-page);
}

.purchase-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 12px 16px 16px;
  background: var(--industrial-surface);
  border: 1px solid var(--industrial-grid);
  border-radius: 6px;
}

.purchase-heading__row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.purchase-heading h1 {
  margin: 0 0 4px;
  color: var(--industrial-text);
  font-size: 20px;
}

.purchase-heading p {
  max-width: 720px;
  margin: 0;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.purchase-stats {
  display: flex;
  gap: 18px;
  margin: 0;
}

.purchase-stats__item dt {
  color: var(--industrial-muted);
  font-size: 12px;
}

.purchase-stats__item dd {
  margin: 2px 0 0;
  color: var(--industrial-text);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.purchase-body {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}

.purchase-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--industrial-surface);
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
}

.purchase-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: var(--industrial-header);
  border-bottom: 1px solid var(--industrial-grid);
}

.purchase-panel__title {
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
}

.purchase-panel__count {
  color: var(--industrial-muted);
  font-size: 12px;
}

.purchase-toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--industrial-grid-light);
}

.purchase-sku-list {
  flex: 1 1 auto;
  min-height: 0;
}

.purchase-sku {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  height: 100%;
  padding: 8px 12px;
  color: var(--industrial-text);
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--industrial-grid-light);
  cursor: pointer;
}

.purchase-sku:hover {
  background: var(--industrial-header);
}

.purchase-sku--active {
  background: var(--industrial-header);
  box-shadow: inset 3px 0 0 var(--industrial-primary);
}

.purchase-sku__name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.purchase-sku__meta {
  color: var(--industrial-muted);
  font-size: 11px;
}

.purchase-sku__qty {
  color: var(--industrial-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.purchase-sku__qty--done {
  color: var(--industrial-primary);
}

.purchase-detail__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.purchase-detail__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px;
  overflow: auto;
}

.purchase-detail__placeholder {
  margin: auto;
  color: var(--industrial-muted);
  font-size: 13px;
}

.purchase-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1 1 auto;
  color: var(--industrial-muted);
  font-size: 13px;
}

.purchase-empty p {
  margin: 0;
}

.purchase-empty__link {
  margin-top: 8px;
  color: var(--industrial-primary);
  text-decoration: none;
}

@media (max-width: 900px) {
  .purchase-body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(200px, 34%) minmax(0, 1fr);
  }
}
</style>
