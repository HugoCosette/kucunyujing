<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import SkuOrderEditor from '@/components/SkuOrderEditor.vue'
import { useInventoryStore } from '@/stores/inventory'
import { usePurchaseStore } from '@/stores/purchase'
import { categoryForSku, planOrderQuantity, resolveVatRule } from '@/purchase'
import { formatQuantity } from '@/utils/inventory'

// 采购下单：左侧是「本次采购清单」里的 SKU，右侧按染厂拆这张 SKU 的分订单。
// 数据只来自主面板已采纳的需安排；分订单以唯一标识为键，重新导入后自动保留。
const inventoryStore = useInventoryStore()
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
    const planned = Number(entry.planned) || 0
    const product = item?.product ?? entry.product
    const rule = resolveVatRule(purchaseStore.settings, { skuId, product })
    return {
      id: entry.id,
      key: entry.id,
      skuId,
      product,
      color: item?.color ?? entry.color,
      treeCategory: categoryForSku(purchaseStore.settings, skuId, item?.treeCategory),
      planned,
      ordered: summary.total,
      orderCount: summary.counted,
      vats: summary.vats,
      monthlyAvgCount: item?.monthlyAvgCount,
      // 建议下单量已按品名绑定的缸规则换算（缸数 × 每缸公斤）。
      suggestion: planOrderQuantity(planned, rule, {
        planned,
        monthlyAvgCount: item?.monthlyAvgCount,
      }),
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
    vats: rows.value.reduce((sum, row) => sum + row.vats, 0),
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

// 撤销下单（确认前）：清空草稿，并把主面板该行的需安排清零、解除锁定。
function clearPlannedFor(skuId) {
  const item = inventoryStore.inventoryItems.find(
    (entry) => String(entry.skuId ?? '').trim() === skuId,
  )
  if (!item) return
  item.planned = 0
  delete inventoryStore.plannedUndoHistory[item.id]
  const purchaseItem = inventoryStore.purchaseList.find(
    (entry) => String(entry.skuId ?? '').trim() === skuId,
  )
  if (purchaseItem) purchaseItem.planned = 0
}

async function revokeRow(row) {
  const label = `${row.product} ${row.color}`
  const hasOrdered = purchaseStore.orderEntries(row.skuId).length > 0
  try {
    await ElMessageBox.confirm(
      hasOrdered
        ? `确定撤销「${label}」？将从本次采购清单剔除，清空它的全部分订单，并把需安排清零解锁。`
        : `确定撤销「${label}」？将从本次采购清单剔除，并把需安排清零解锁。`,
      '撤销下单',
      { type: 'warning', confirmButtonText: '撤销', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  if (hasOrdered) purchaseStore.clearOrderEntries(row.skuId)
  clearPlannedFor(row.skuId)
  const index = inventoryStore.purchaseList.findIndex((entry) => entry.id === row.id)
  if (index !== -1) inventoryStore.purchaseList.splice(index, 1)
  ElMessage.success(`已从采购清单剔除「${label}」`)
}

// 确认下单：草稿变成订单，主面板需安排清零并解锁；已下单由订单流水接管预计库存。
function submitRows(targets) {
  const prepared = targets
    .map((row) => ({
      skuId: row.skuId,
      product: row.product,
      color: row.color,
      entries: purchaseStore.orderEntries(row.skuId),
    }))
    .filter((target) => target.entries.length > 0)
  if (prepared.length === 0) return null

  const result = purchaseStore.submitOrders(prepared)
  if (!result.items.length) return result

  const submitted = new Set(result.items.map((item) => item.skuId))
  for (const skuId of submitted) {
    clearPlannedFor(skuId)
    const index = inventoryStore.purchaseList.findIndex(
      (entry) => String(entry.skuId ?? '').trim() === skuId,
    )
    if (index !== -1) inventoryStore.purchaseList.splice(index, 1)
  }
  void purchaseStore.flushOrders()
  return result
}

const draftSkuCount = computed(
  () => rows.value.filter((row) => purchaseStore.orderEntries(row.skuId).length > 0).length,
)

async function confirmSelectedRow() {
  if (!selectedRow.value) return
  const label = `${selectedRow.value.product} ${selectedRow.value.color}`
  const result = submitRows([selectedRow.value])
  if (!result?.items.length) {
    ElMessage.warning('这张单还没有填染厂或公斤数，先补全再确认')
    return
  }
  ElMessage.success(`已下单：${label}`)
  selectedKey.value = null
}

async function confirmAllDrafts() {
  const targets = rows.value.filter((row) => purchaseStore.orderEntries(row.skuId).length > 0)
  if (targets.length === 0) {
    ElMessage.warning('还没有可提交的下单草稿')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定提交 ${targets.length} 个 SKU 的分订单？提交后需安排清零并解锁，要改单只能在主面板「订单」弹窗里撤销重下。`,
      '一键确认全部',
      { type: 'warning', confirmButtonText: '确认下单', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  const result = submitRows(targets)
  if (!result?.items.length) {
    ElMessage.warning('没有可提交的分订单（缺染厂或公斤数）')
    return
  }
  ElMessage.success(`已确认下单：${result.items.length} 张分订单`)
}

function selectRow(row) {
  selectedKey.value = row.key
}
</script>

<template>
  <main class="purchase-page">
    <PanelNavigation />

    <div class="page-head">
      <h1 class="page-title">采购下单</h1>
      <dl class="po-stats">
        <div class="po-stats__item">
          <dt>SKU</dt>
          <dd>{{ stats.skuCount }}</dd>
        </div>
        <div class="po-stats__item">
          <dt>需安排</dt>
          <dd>{{ formatQuantity(stats.planned) }}</dd>
        </div>
        <div class="po-stats__item">
          <dt>已下单</dt>
          <dd class="is-accent">{{ formatQuantity(stats.ordered) }}</dd>
        </div>
        <div class="po-stats__item">
          <dt>缸数</dt>
          <dd>{{ formatQuantity(stats.vats) }}</dd>
        </div>
        <div
          class="po-stats__item is-clickable"
          title="只看未下单"
          @click="onlyUnordered = true"
        >
          <dt>未下单</dt>
          <dd class="is-warn">{{ stats.pending }}</dd>
        </div>
      </dl>
    </div>

    <div v-if="rows.length === 0" class="purchase-empty">
      <p>本次采购清单还是空的。</p>
      <p>回到主面板勾选 SKU、完成批量/紧急补货后，这里就会出现待下单的 SKU。</p>
      <RouterLink class="purchase-empty__link" to="/">返回主面板</RouterLink>
    </div>

    <div v-else class="po-layout">
      <!-- 左：待下单 SKU 清单 -->
      <section class="po-panel po-panel--list">
        <div class="po-panel__head">
          <span class="po-panel__title">待下单 SKU</span>
          <span class="po-panel__count">{{ filteredRows.length }} / {{ rows.length }}</span>
          <span class="po-panel__spacer"></span>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            :disabled="draftSkuCount === 0"
            title="把所有已填的分订单一次性确认下单"
            @click="confirmAllDrafts"
          >
            一键确认全部{{ draftSkuCount > 0 ? `（${draftSkuCount}）` : '' }}
          </button>
        </div>
        <div class="po-tools">
          <label class="field">
            <svg class="field__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.3" />
              <path
                d="m10.4 10.4 3 3"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
            <input
              v-model="keyword"
              class="input input--search po-tools__search"
              placeholder="搜索品名 / 颜色"
            />
          </label>
          <label class="po-check">
            <input v-model="onlyUnordered" type="checkbox" />
            只看未下单
          </label>
        </div>
        <div class="po-list__scroll">
          <table class="po-mini">
            <colgroup>
              <col />
              <col style="width: 76px" />
              <col style="width: 76px" />
              <col style="width: 48px" />
            </colgroup>
            <thead>
              <tr>
                <th>品名 · 颜色</th>
                <th class="is-num">需安排</th>
                <th class="is-num">已下单</th>
                <th class="is-num">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in filteredRows"
                :key="row.key"
                :class="{ 'is-active': row.key === selectedKey }"
                @click="selectRow(row)"
              >
                <td class="po-mini__name" :title="`${row.product} · ${row.color}`">
                  <span class="po-mini__product">{{ row.product }}</span>
                  <span class="po-mini__sep">·</span>{{ row.color }}
                </td>
                <td class="is-num">{{ formatQuantity(row.planned) }}</td>
                <td class="is-num" :class="row.ordered > 0 ? 'is-done' : 'is-zero'">
                  {{ row.ordered > 0 ? formatQuantity(row.ordered) : '—' }}
                </td>
                <td class="is-num">
                  <button
                    type="button"
                    class="btn btn--text btn--sm po-mini__revoke"
                    title="从本次采购清单剔除该 SKU"
                    @click.stop="revokeRow(row)"
                  >
                    撤销
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="filteredRows.length === 0" class="po-empty">没有匹配的 SKU</p>
        </div>
      </section>

      <!-- 右：该 SKU 的分订单 -->
      <section class="po-panel po-panel--detail">
        <template v-if="selectedRow">
          <div class="po-panel__head">
            <h2 class="po-detail__title">{{ selectedRow.product }} · {{ selectedRow.color }}</h2>
            <span class="tag tag--muted">
              {{ selectedRow.treeCategory || '树形分类未维护' }}
            </span>
            <span class="po-panel__spacer"></span>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              :disabled="purchaseStore.orderEntries(selectedRow.skuId).length === 0"
              title="把这张 SKU 的分订单确认为订单，回写主面板「已下单」"
              @click="confirmSelectedRow"
            >
              确认下单
            </button>
            <button
              type="button"
              class="btn btn--text btn--sm"
              :disabled="purchaseStore.orderEntries(selectedRow.skuId).length === 0"
              @click="clearCurrentOrders"
            >
              清空分订单
            </button>
          </div>
          <div class="po-order__scroll">
            <SkuOrderEditor v-model="entries" :item="selectedRow" />
          </div>
        </template>
        <p v-else class="po-empty">左侧选择一个 SKU 开始下单</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.purchase-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-width: 900px;
  padding: 8px 14px 12px;
  color: var(--industrial-text);
}

.page-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 30px;
  margin-bottom: 8px;
}

.page-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
}

/* 顶部统计：label + 数字横向排，竖线分隔 */
.po-stats {
  display: flex;
  align-items: baseline;
  margin: 0 0 0 auto;
}

.po-stats__item {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 0 11px;
  border-left: 1px solid var(--industrial-grid-light);
}

.po-stats__item:first-child {
  padding-left: 0;
  border-left: 0;
}

.po-stats__item dt {
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
}

.po-stats__item dd {
  margin: 0;
  color: var(--industrial-text);
  font-size: 13.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.po-stats__item dd.is-accent {
  color: var(--industrial-primary);
}

.po-stats__item dd.is-warn {
  color: var(--industrial-replenish);
}

.po-stats__item.is-clickable {
  cursor: pointer;
  border-radius: 2px;
}

.po-stats__item.is-clickable:hover dt,
.po-stats__item.is-clickable:hover dd {
  color: var(--industrial-primary);
}

.po-layout {
  display: grid;
  grid-template-columns: 322px minmax(0, 1fr);
  gap: 24px;
  flex: 1 1 auto;
  min-height: 0;
}

.po-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: var(--industrial-surface);
}

.po-panel__head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 31px;
  padding: 0 10px;
  border-bottom: 1px solid var(--industrial-grid);
  background: var(--industrial-header);
}

.po-panel__title {
  font-size: 12.5px;
  font-weight: 600;
}

.po-panel__count {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.po-panel__spacer {
  margin-left: auto;
}

.po-tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--industrial-grid-light);
}

.po-tools__search {
  width: 100%;
  height: 26px;
  font-size: 12px;
}

.po-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--industrial-muted);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}

.po-check input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--industrial-primary);
}

.po-list__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* 左侧清单：一行一个 SKU，像表格而不是卡片 */
.po-mini {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
}

.po-mini th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 25px;
  padding: 0 8px;
  border-bottom: 1px solid var(--industrial-grid-light);
  background: #eef2f4;
  color: var(--industrial-muted);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
}

.po-mini th.is-num {
  text-align: right;
}

.po-mini td {
  height: 31px;
  padding: 0 8px;
  overflow: hidden;
  border-bottom: 1px solid var(--line-soft);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.po-mini tbody tr {
  cursor: pointer;
}

.po-mini tbody tr:hover td {
  background: #f2f6f8;
}

.po-mini tbody tr.is-active td {
  background: var(--industrial-header);
}

.po-mini tbody tr.is-active td:first-child {
  box-shadow: inset 3px 0 0 var(--industrial-primary);
}

.po-mini__name {
  color: var(--industrial-text);
}

.po-mini__product {
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.po-mini__sep {
  margin: 0 4px;
  color: #98a4ab;
}

/* 撤销列很窄：去掉单元格左右内边距，按钮压到刚好放下两个字 */
.po-mini th:last-child,
.po-mini td:last-child {
  padding: 0 2px;
}

.po-mini__revoke {
  height: 22px;
  padding: 0 4px;
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.po-mini__revoke:hover:not(:disabled) {
  color: var(--industrial-danger);
  background: #f7e9e7;
}

.is-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.is-zero {
  color: #a9b4bb;
}

.is-done {
  color: var(--industrial-primary);
  font-weight: 600;
}

.po-detail__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.po-order__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* 分订单表铺满面板：表格自己的外框交给面板，指标条只留一条底边 */
.po-order__scroll :deep(.so-editor) {
  gap: 0;
}

.po-order__scroll :deep(.so-bar) {
  padding: 7px 10px;
  border-bottom: 1px solid var(--industrial-grid-light);
}

.po-order__scroll :deep(.so-table-wrap) {
  border: 0;
  border-radius: 0;
}

.po-order__scroll :deep(.so-table th:first-child),
.po-order__scroll :deep(.so-table td:first-child) {
  padding-left: 10px;
}

.po-order__scroll :deep(.so-table th) {
  position: sticky;
  top: 0;
  z-index: 1;
}

.po-empty {
  margin: auto;
  padding: 40px 0;
  color: var(--industrial-muted);
  font-size: 12.5px;
  text-align: center;
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
  .po-layout {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(200px, 34%) minmax(0, 1fr);
  }
}
</style>
