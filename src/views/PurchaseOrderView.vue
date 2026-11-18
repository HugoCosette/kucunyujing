<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElDropdown, ElDropdownItem, ElDropdownMenu, ElMessage, ElMessageBox } from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import OrderHistoryPanel from '@/components/OrderHistoryPanel.vue'
import SkuOrderEditor from '@/components/SkuOrderEditor.vue'
import { useInventoryStore } from '@/stores/inventory'
import { usePurchaseStore } from '@/stores/purchase'
import { schedulePlanPersist } from '@/data/persistence'
import { MAIN_PANEL } from '@/data/panels'
import { categoryForSku, FILL_LOW_RATIO, fillTone, planOrderQuantity, resolveVatRule } from '@/purchase'

// 采购下单页 = 两个子面板：下单面板（拆单 + 确认）与下单历史（只读流水）。
// 数据只来自主面板已采纳的需安排；分订单以唯一标识为键，重新导入后自动保留。
const inventoryStore = useInventoryStore()
const purchaseStore = usePurchaseStore()
const route = useRoute()

const activePanel = computed(() =>
  route.name === MAIN_PANEL.purchaseHistoryRouteName ? 'history' : 'order',
)

const keyword = ref('')
const onlyUnordered = ref(false)
const selectedKey = ref(null)

// 公斤数统一带千分位：一屏里出现多个五位数时更容易对齐着读。
const kgFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
function fmtKg(value) {
  return kgFormat.format(Math.round((Number(value) || 0) * 100) / 100)
}

const itemById = computed(() => {
  const map = new Map()
  for (const item of inventoryStore.inventoryItems) map.set(item.id, item)
  return map
})

// 左列表「下单数量」= 这一刻已填分订单的实际公斤数，颜色与右侧进度条同一套口径
// （`src/purchase/fillTone.js`）：未下单灰、< 80% 黄、80% ~ 100% 绿、超一缸内绿、超过一缸红。
function statusOf(filledKg, plannedKg, perVatKg) {
  return { tone: fillTone(filledKg, plannedKg, perVatKg), label: fmtKg(filledKg) }
}

const rows = computed(() =>
  inventoryStore.purchaseList.map((entry) => {
    const item = itemById.value.get(entry.id)
    const skuId = String(entry.skuId ?? item?.skuId ?? '').trim()
    const planned = Number(entry.planned) || 0
    const product = item?.product ?? entry.product
    const rule = resolveVatRule(purchaseStore.settings, { skuId, product })
    const entries = purchaseStore.orderEntries(skuId)
    const filled = entries.reduce((sum, one) => sum + (Number(one?.quantity) || 0), 0)
    // 建议下单量已按品名绑定的缸规则换算（缸数 × 每缸公斤）。
    const suggestion = planOrderQuantity(planned, rule, {
      planned,
      monthlyAvgCount: item?.monthlyAvgCount,
    })
    // 「一缸以内」按实际下单用的缸型判断：分订单里有快照就取最大的那档，没有就退回规则建议的缸型。
    const perVat = Math.max(
      Number(suggestion?.kgPerVat) || 0,
      entries.reduce((max, one) => Math.max(max, Number(one?.kgPerVat) || 0), 0),
    )
    return {
      id: entry.id,
      key: entry.id,
      skuId,
      product,
      color: item?.color ?? entry.color,
      treeCategory: categoryForSku(purchaseStore.settings, skuId, item?.treeCategory),
      planned,
      rule,
      entries,
      filled,
      perVat,
      status: statusOf(filled, planned, perVat),
      monthlyAvgCount: item?.monthlyAvgCount,
      suggestion,
    }
  }),
)

const filteredRows = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (onlyUnordered.value && row.entries.length > 0) return false
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
// 只是被筛选挡住（SKU 还在清单里）时标记 autoSelected：这种情况不预填建议单，
// 否则一开「未下单」筛选就会把回落到的每一行都预填一遍、把它们逐条筛掉，连锁填满整张清单。
const autoSelected = ref(false)
watch(
  filteredRows,
  (list) => {
    if (list.some((row) => row.key === selectedKey.value)) return
    const previous = selectedKey.value
    const blockedByFilter = previous !== null && rows.value.some((row) => row.key === previous)
    autoSelected.value = blockedByFilter
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

// 顶部全局进度：按「已下单订单数 / 总订单数」算（一个 SKU 算一单），
// 填满 8 成 SKU 就是绿、不足就是黄（阈值与左列表「下单数量」的颜色线共用 `FILL_LOW_RATIO`）。
// 公斤合计只放 hover，条本身不再按公斤算 —— 单数进度才是"还剩几单没下"的那个数。
const progress = computed(() => {
  const total = rows.value.length
  const filled = rows.value.filter((row) => row.entries.length > 0).length
  const plannedKg = rows.value.reduce((sum, row) => sum + row.planned, 0)
  const filledKg = rows.value.reduce((sum, row) => sum + row.filled, 0)
  const ratio = total > 0 ? filled / total : 0
  return {
    total,
    filled,
    pending: total - filled,
    plannedKg,
    filledKg,
    tone: total === 0 ? 'idle' : ratio >= FILL_LOW_RATIO - 1e-6 ? 'ok' : 'low',
    pct: ratio * 100,
  }
})

// 右侧单 SKU 进度：一条读得懂的线，替代原来并排的五个短语（差额不再写字，颜色已经说明问题）。
const detail = computed(() => {
  const row = selectedRow.value
  if (!row) return null
  return {
    planned: row.planned,
    filled: row.filled,
    pct: row.planned > 0 ? Math.min(100, (row.filled / row.planned) * 100) : 0,
    tone: row.status.tone,
  }
})

// 缸规则判定（原来贴在进度条尾部的「建议 N 缸 · 每缸 X 公斤」）收进 hover，不再占一行版面。
const figureTitle = computed(() => {
  const rule = ruleTitleOf(selectedRow.value)
  return rule ? `${toneRuleTitle} · ${rule}` : toneRuleTitle
})

// 悬停缸规则那行灰字时给出完整判定（缸型 / 建议缸数 / 告警），不占版面。
function ruleTitleOf(row) {
  if (!row) return ''
  const parts = [row.rule?.name]
  const suggestion = row.suggestion ?? {}
  if (suggestion.bandText) parts.push(suggestion.bandText)
  if (Number(suggestion.vatCount) > 0 && suggestion.rounded > 0) {
    parts.push(`建议 ${fmtKg(suggestion.vatCount)} 缸 ＝ ${fmtKg(suggestion.rounded)} 公斤`)
  }
  for (const warning of suggestion.warnings ?? []) parts.push(warning)
  return parts.filter(Boolean).join(' · ')
}

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

async function revokeRowWithConfirm(row) {
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
  revokeRowNow(row)
}

// 列表里的「撤销」不弹窗：第一次点变成「确认撤销」，再点一次才真撤销，
// 点别的地方（或切到别的行）自动取消，等于把二次确认做在按钮自己身上。
const revokingKey = ref(null)

function requestRevoke(row, event) {
  event?.stopPropagation()
  if (revokingKey.value === row.key) {
    revokingKey.value = null
    revokeRowNow(row)
    return
  }
  revokingKey.value = row.key
}

function revokeRowNow(row) {
  const label = `${row.product} ${row.color}`
  if (purchaseStore.orderEntries(row.skuId).length > 0) {
    purchaseStore.clearOrderEntries(row.skuId)
  }
  clearPlannedFor(row.skuId)
  const index = inventoryStore.purchaseList.findIndex((entry) => entry.id === row.id)
  if (index !== -1) inventoryStore.purchaseList.splice(index, 1)
  schedulePlanPersist(inventoryStore)
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
  schedulePlanPersist(inventoryStore)
  void purchaseStore.flushOrders()
  return result
}

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
  const targets = rows.value.filter((row) => row.entries.length > 0)
  if (targets.length === 0) {
    ElMessage.warning('还没有可提交的下单草稿')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定提交 ${targets.length} 个已填写的分订单？提交后可在订单弹窗改单`,
      '下单全部已填',
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
  autoSelected.value = false
  selectedKey.value = row.key
}

// 左侧选中行 → 右侧明细之间的连接件：高度取面板高度的 1/4，窄口始终对准选中行，
// 两边都夹在框内（贴边时改开口偏移，而不是把扇形顶出去）。量不到就隐藏，绝不硬画。
const layoutEl = ref(null)
const activeRowEl = ref(null)
const linkStyle = ref(null)

function setRowRef(key, el) {
  if (el && key === selectedKey.value) activeRowEl.value = el
}

function syncPoLink() {
  const layout = layoutEl.value
  const row = activeRowEl.value
  if (!layout || !row || !row.isConnected) {
    linkStyle.value = null
    return
  }

  const layoutRect = layout.getBoundingClientRect()
  if (layoutRect.height < 60) return

  const listPanel = layout.querySelector('.po-panel--list')
  const detailPanel = layout.querySelector('.po-panel--detail')
  if (!listPanel || !detailPanel) return

  const listRect = listPanel.getBoundingClientRect()
  const detailRect = detailPanel.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const rowHeight = Math.round(rowRect.height) || 32
  const height = Math.round(layoutRect.height / 4)
  const center = rowRect.top - layoutRect.top + rowHeight / 2

  let top = Math.round(center - height / 2)
  top = Math.max(0, Math.min(top, Math.round(layoutRect.height - height)))
  const openCenter = Math.max(0, Math.min(Math.round(center - top), height))
  const half = rowHeight / 2

  linkStyle.value = {
    left: `${Math.round(listRect.right - layoutRect.left)}px`,
    width: `${Math.max(8, Math.round(detailRect.left - listRect.right) + 1)}px`,
    top: `${top}px`,
    height: `${height}px`,
    clipPath: `polygon(0 ${Math.max(0, openCenter - half)}px, 100% 0, 100% 100%, 0 ${Math.min(
      height,
      openCenter + half,
    )}px)`,
  }
}

watch([selectedKey, activePanel, filteredRows], () => nextTick(syncPoLink))

// 点了撤销按钮以外的地方就取消「确认撤销」待确认状态。
function handleDocumentClick(event) {
  if (!revokingKey.value) return
  if (event.target?.closest?.('.po-mini__revoke')) return
  revokingKey.value = null
}

onMounted(() => {
  window.addEventListener('resize', syncPoLink)
  document.addEventListener('click', handleDocumentClick)
  nextTick(syncPoLink)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', syncPoLink)
  document.removeEventListener('click', handleDocumentClick)
})

// 标题栏只留一个主操作（确认下单）：「添加分订单」在表格底部那一行已经有了，
// 而且进面板会自动带一张建议单，上面再放一次是重复入口。
function handleDetailMenu(command) {
  if (command === 'clear') void clearCurrentOrders()
  if (command === 'revoke' && selectedRow.value) void revokeRowWithConfirm(selectedRow.value)
}

// 颜色规则不画图例，悬停在数字 / 进度条上直接读（口径实现在 src/purchase/fillTone.js）。
const toneRuleTitle =
  '颜色规则：未下单灰 · 不足 80% 黄 · 80% ~ 100% 绿 · 超出但在一缸以内绿 · 超过一缸红（一缸 = 该 SKU 的缸型）'

// 顶部那条按单数：8 成 SKU 填了单就绿，公斤合计放这里看。
const progressTitle = computed(() => {
  const one = progress.value
  return `填满 8 成 SKU 即为绿（当前 ${one.filled}/${one.total}）· 公斤合计 ${fmtKg(one.filledKg)} / ${fmtKg(one.plannedKg)}`
})
</script>

<template>
  <main class="purchase-page">
    <PanelNavigation />

    <!-- 页面标题「采购下单」不再单独占一行（顶部导航已经有入口），子面板 tab 直接接在导航下 -->
    <!-- 子面板切换：下单面板（拆单 + 确认）/ 下单历史（只读流水） -->
    <nav class="purchase-tabs" aria-label="采购下单子面板">
      <RouterLink
        class="purchase-tabs__item"
        :class="{ 'is-active': activePanel === 'order' }"
        :to="{ name: MAIN_PANEL.purchaseRouteName }"
      >
        {{ MAIN_PANEL.purchaseOrderTabLabel }}
      </RouterLink>
      <RouterLink
        class="purchase-tabs__item"
        :class="{ 'is-active': activePanel === 'history' }"
        :to="{ name: MAIN_PANEL.purchaseHistoryRouteName }"
      >
        {{ MAIN_PANEL.purchaseHistoryTabLabel }}
      </RouterLink>
    </nav>

    <template v-if="activePanel === 'order'">
      <div v-if="rows.length === 0" class="purchase-empty">
        <p>本次采购清单还是空的。</p>
        <p>回到需求表勾选 SKU、完成批量/紧急补货后，这里就会出现待下单的 SKU。</p>
        <RouterLink class="purchase-empty__link" to="/">返回需求表</RouterLink>
      </div>

      <div v-else ref="layoutEl" class="po-layout">
        <div v-if="linkStyle" class="po-link" :style="linkStyle" aria-hidden="true"></div>

        <!-- 左：下单列表 -->
        <section class="po-panel po-panel--list">
          <!-- 总进度（单数）就在标题行：9/9 紧跟「下单列表」，进度条撑满整行剩余宽度 -->
          <div class="po-panel__head">
            <span class="po-panel__title">下单列表</span>
            <span class="po-head-progress" :title="progressTitle">
              <b :class="`is-${progress.tone}`">{{ progress.filled }}/{{ progress.total }}</b> 单
              <span class="po-head-progress__track" :class="`is-${progress.tone}`">
                <i :style="{ width: `${progress.pct.toFixed(1)}%` }"></i>
              </span>
            </span>
          </div>
          <div class="po-tools">
            <label class="po-search">
              <svg
                viewBox="0 0 14 14"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                aria-hidden="true"
              >
                <circle cx="6.2" cy="6.2" r="4.2" />
                <path d="M9.4 9.4 12.2 12.2" stroke-linecap="round" />
              </svg>
              <input v-model="keyword" placeholder="搜索品名 / 颜色" aria-label="搜索品名或颜色" />
            </label>
            <!-- 「未下单」既是筛选也是计数，比一个光秃秃的复选框信息量大 -->
            <button
              type="button"
              class="po-filter"
              :aria-pressed="onlyUnordered"
              @click="onlyUnordered = !onlyUnordered"
            >
              未下单
              <b>{{ progress.pending }}</b>
            </button>
          </div>
          <div class="po-list__scroll" @scroll="syncPoLink">
            <table class="po-mini">
              <colgroup>
                <col />
                <col style="width: 130px" />
                <col style="width: 56px" />
                <col style="width: 62px" />
                <col style="width: 64px" />
              </colgroup>
              <thead>
                <tr>
                  <th>品名</th>
                  <th>颜色</th>
                  <th class="is-num">需安排</th>
                  <th class="is-num">下单数量</th>
                  <th class="is-op">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in filteredRows"
                  :key="row.key"
                  :ref="(el) => setRowRef(row.key, el)"
                  :class="{ 'is-active': row.key === selectedKey }"
                  @click="selectRow(row)"
                >
                  <td class="po-mini__product" :title="row.product">{{ row.product }}</td>
                  <td class="po-mini__color" :title="row.color">{{ row.color }}</td>
                  <td class="is-num">{{ fmtKg(row.planned) }}</td>
                  <!-- 「下单数量」显示这一刻已填分订单的实际公斤数，颜色标出下够了没 -->
                  <td class="is-num" :title="toneRuleTitle">
                    <span class="po-mini__qty" :class="`is-${row.status.tone}`">
                      {{ row.status.label }}
                    </span>
                  </td>
                  <!-- 撤销常驻在行上：右边 ⋯ 菜单里也有同一个动作，但藏起来就没人找得到 -->
                  <td class="is-op">
                    <button
                      type="button"
                      class="po-mini__revoke"
                      :class="{ 'is-confirming': revokingKey === row.key }"
                      :title="
                        revokingKey === row.key
                          ? '再点一次就从本次采购清单剔除，并把需安排清零'
                          : '从本次采购清单剔除该 SKU（需再点一次确认）'
                      "
                      @click.stop="requestRevoke(row, $event)"
                    >
                      {{ revokingKey === row.key ? '确认撤销' : '撤销' }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="filteredRows.length === 0" class="po-empty">没有匹配的 SKU</p>
          </div>
          <!-- 只有填了分订单才出现：没东西可确认时不占版面（单数进度已经在标题行） -->
          <div v-if="progress.filled > 0" class="po-list__foot">
            <button
              type="button"
              class="btn btn--primary btn--sm"
              title="把所有已填的分订单一次性确认下单"
              @click="confirmAllDrafts"
            >
              下单全部已填
            </button>
          </div>
        </section>

        <!-- 右：该 SKU 的分订单 -->
        <section class="po-panel po-panel--detail">
          <template v-if="selectedRow">
            <div class="po-panel__head po-panel__head--detail">
              <h2 class="po-detail__title" :title="`${selectedRow.product} · ${selectedRow.color}`">
                {{ selectedRow.product }} · {{ selectedRow.color }}
              </h2>
              <span class="tag tag--muted">{{ selectedRow.treeCategory || '树形分类未维护' }}</span>
              <span class="po-panel__spacer"></span>
              <ElDropdown trigger="click" placement="bottom-end" @command="handleDetailMenu">
                <button type="button" class="po-more" aria-label="更多操作">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <circle cx="3.2" cy="8" r="1.2" />
                    <circle cx="8" cy="8" r="1.2" />
                    <circle cx="12.8" cy="8" r="1.2" />
                  </svg>
                </button>
                <template #dropdown>
                  <ElDropdownMenu>
                    <ElDropdownItem command="clear" :disabled="selectedRow.entries.length === 0">
                      清空分订单
                    </ElDropdownItem>
                    <ElDropdownItem command="revoke" divided>
                      从采购清单撤销
                    </ElDropdownItem>
                  </ElDropdownMenu>
                </template>
              </ElDropdown>
            </div>

            <!-- 单 SKU 进度：已下单 / 需安排 + 进度条 + 还差多少（缸规则悬停了看） -->
            <div class="po-figure">
              <span class="po-figure__lead" :title="figureTitle">
                已下单 <b :class="`is-${detail.tone}`">{{ fmtKg(detail.filled) }}</b> /
                {{ fmtKg(detail.planned) }} 公斤
              </span>
              <span class="po-figure__track" :class="`is-${detail.tone}`" :title="figureTitle">
                <i :style="{ width: `${detail.pct.toFixed(1)}%` }"></i>
              </span>
            </div>

            <div class="po-order__scroll">
              <SkuOrderEditor
                v-model="entries"
                :item="selectedRow"
                :auto-seed="!autoSelected"
                variant="panel"
              />
            </div>

            <!-- 底部只留右下角的「确认下单」：张数 / 缸数 / 公斤已经在编辑器表格与进度条里 -->
            <div class="po-foot">
              <button
                type="button"
                class="btn btn--sm btn--primary po-foot__confirm"
                :disabled="selectedRow.entries.length === 0"
                title="把这张 SKU 的分订单确认为订单，并从本次采购清单移出"
                @click="confirmSelectedRow"
              >
                确认下单
              </button>
            </div>
          </template>
          <p v-else class="po-empty">左侧选择一个 SKU 开始下单</p>
        </section>
      </div>
    </template>

    <OrderHistoryPanel v-else />
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

/* ---------- 左面板标题行：标题 + 单数进度（条撑满整行） ---------- */
.po-head-progress {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
}

.po-head-progress b {
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--industrial-muted);
}

.po-head-progress b.is-low {
  color: var(--industrial-replenish);
}

.po-head-progress b.is-ok {
  color: var(--industrial-normal);
}

.po-head-progress b.is-idle {
  color: #a9b4bb;
}

.po-head-progress__track {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: #dde5e9;
}

.po-head-progress__track i {
  position: absolute;
  inset: 0 auto 0 0;
  display: block;
  border-radius: 999px;
  background: #c3ced4;
  transition: width 0.2s ease;
}

.po-head-progress__track.is-low i {
  background: var(--industrial-replenish);
}

.po-head-progress__track.is-ok i {
  background: var(--industrial-normal);
}

/* 子面板标签：比顶部导航轻一级，只在本页内切换 */
.purchase-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--industrial-grid);
}

.purchase-tabs__item {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 14px;
  border-bottom: 2px solid transparent;
  color: var(--industrial-muted);
  font-size: 13px;
  text-decoration: none;
}

.purchase-tabs__item:hover {
  color: var(--industrial-primary);
}

.purchase-tabs__item.is-active {
  border-bottom-color: var(--industrial-primary);
  color: var(--industrial-primary);
  font-weight: 600;
}

/* ---------- 两栏骨架 ---------- */
.po-layout {
  position: relative;
  display: grid;
  overflow: hidden;
  grid-template-columns: 460px minmax(0, 1fr);
  gap: 24px;
  flex: 1 1 auto;
  min-height: 0;
}

/* 连接件：从左侧选中行「开口」流向右侧明细，位置与开口由 syncPoLink() 实测后覆盖，
   配色从标签端（深）到面板端（浅）渐隐，末端与面板自然融合 */
.po-link {
  position: absolute;
  z-index: 2;
  background: linear-gradient(
    90deg,
    rgba(63, 113, 141, 0.72) 0%,
    rgba(63, 113, 141, 0.64) 12%,
    rgba(63, 113, 141, 0.5) 25%,
    rgba(63, 113, 141, 0.34) 40%,
    rgba(63, 113, 141, 0.21) 55%,
    rgba(63, 113, 141, 0.11) 72%,
    rgba(63, 113, 141, 0.04) 88%,
    rgba(63, 113, 141, 0) 100%
  );
  pointer-events: none;
}

/* 扇形撞到右侧面板的左框线时，把这一段框线擦掉，接缝才不留色差 */
.po-link::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 1px;
  height: 100%;
  background: linear-gradient(
    to bottom,
    rgba(245, 247, 248, 0) 0%,
    var(--industrial-surface) 22%,
    var(--industrial-surface) 78%,
    rgba(245, 247, 248, 0) 100%
  );
  pointer-events: none;
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

/* 右面板头只剩 标题 + 分类 tag + ⋯，比左面板高 3px 给 tag 留呼吸 */
.po-panel__head--detail {
  height: 34px;
}

.po-panel__title {
  flex: none;
  font-size: 12.5px;
  font-weight: 600;
}

.po-panel__spacer {
  margin-left: auto;
}

/* ---------- 左：搜索 + 未下单筛选 ---------- */
.po-tools {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--industrial-grid-light);
}

.po-search {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 5px;
  min-width: 0;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: #fff;
  color: var(--industrial-muted);
  cursor: text;
}

.po-search:focus-within {
  border-color: var(--industrial-primary);
}

.po-search input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--industrial-text);
  font: inherit;
  font-size: 12px;
  outline: none;
}

.po-search input::placeholder {
  color: #a9b4bb;
}

.po-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: var(--industrial-surface);
  color: var(--industrial-muted);
  font: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}

.po-filter b {
  color: var(--industrial-replenish);
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.po-filter:hover {
  border-color: var(--industrial-replenish);
  color: var(--industrial-text);
}

.po-filter[aria-pressed='true'] {
  border-color: var(--industrial-replenish);
  background: #fbf3e4;
  color: #8a6a2f;
}

.po-list__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* 左面板底部：只有填了分订单才出现，避免空按钮常驻 */
.po-list__foot {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 8px;
  border-top: 1px solid var(--industrial-grid);
  background: #eef2f4;
}

.po-list__foot .btn {
  margin-left: auto;
}

/* ---------- 左：SKU 清单 ---------- */
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

.po-mini td {
  height: 32px;
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

/* 品名与颜色分列：品名重复多、压灰一点，颜色才是每次要认的那个字 */
.po-mini__product {
  color: var(--industrial-muted);
}

.po-mini__color {
  color: var(--industrial-text);
}

/* 下单数量：未下单灰、不到八成黄、八成到超一缸内绿、超过一缸红 —— 与右侧进度条同一套口径 */
.po-mini__qty {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.po-mini__qty.is-idle {
  color: #a9b4bb;
}

.po-mini__qty.is-low {
  color: var(--industrial-replenish);
}

.po-mini__qty.is-ok {
  color: var(--industrial-normal);
  font-weight: 600;
}

.po-mini__qty.is-err {
  color: var(--industrial-danger);
  font-weight: 600;
}

/* 撤销列：平时两个字，再点一次确认时变成四个字（列宽要留够，不然确认态会被截断） */
.po-mini th.is-op,
.po-mini td.is-op {
  padding: 0 2px;
  text-align: right;
}

.po-mini__revoke {
  height: 22px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 2px;
  background: none;
  color: var(--industrial-muted);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.po-mini__revoke:hover {
  border-color: transparent;
  background: #f7e9e7;
  color: var(--industrial-danger);
}

.po-mini__revoke.is-confirming {
  border-color: var(--industrial-danger);
  background: #f7e9e7;
  color: var(--industrial-danger);
  font-weight: 600;
}

/* ---------- 右：标题与动作 ---------- */
.po-detail__title {
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.po-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 3px;
  background: none;
  color: #5b6b74;
  cursor: pointer;
}

.po-more:hover {
  border-color: var(--industrial-grid);
  background: var(--industrial-surface);
  color: var(--industrial-text);
}

/* ---------- 右：单 SKU 进度条 ---------- */
.po-figure {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid var(--industrial-grid-light);
  background: #fff;
  color: var(--industrial-muted);
  font-size: 11.5px;
  white-space: nowrap;
}

.po-figure__lead b {
  margin: 0 1px;
  color: var(--industrial-text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.po-figure__lead b.is-low {
  color: var(--industrial-replenish);
}

.po-figure__lead b.is-ok {
  color: var(--industrial-normal);
}

.po-figure__lead b.is-err {
  color: var(--industrial-danger);
}

.po-figure__lead b.is-idle {
  color: var(--industrial-muted);
}

.po-figure__track {
  position: relative;
  flex: 1 1 120px;
  min-width: 70px;
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: #e2eaee;
}

.po-figure__track i {
  position: absolute;
  inset: 0 auto 0 0;
  display: block;
  border-radius: 999px;
  background: #c3ced4;
  transition: width 0.18s ease;
}

.po-figure__track.is-low i {
  background: var(--industrial-replenish);
}

.po-figure__track.is-ok i {
  background: var(--industrial-normal);
}

.po-figure__track.is-err i {
  background: var(--industrial-danger);
}

/* 左列表的数字列（表头 + 单元格）居中，跟表头对齐（原来右对齐看着像挤在撤销按钮旁边） */
.po-mini th.is-num,
.po-mini td.is-num {
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* ---------- 右：分订单表 ---------- */
.po-order__scroll {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

/* 表格自己的外框交给面板：指标条与合计条由本页提供，编辑器只出表格 */
.po-order__scroll :deep(.so-editor) {
  gap: 0;
}

.po-order__scroll :deep(.so-table-wrap) {
  overflow: visible;
  border: 0;
  border-radius: 0;
}

.po-order__scroll :deep(.so-table) {
  min-width: 0;
}

.po-order__scroll :deep(.so-table th) {
  position: sticky;
  top: 0;
  z-index: 1;
}

.po-order__scroll :deep(.so-table th:first-child),
.po-order__scroll :deep(.so-table td:first-child) {
  padding-left: 8px;
}

.po-order__scroll :deep(.so-empty) {
  padding: 28px 12px;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

/* ---------- 右：底部操作条 ---------- */
.po-foot {
  display: flex;
  flex: none;
  align-items: center;
  gap: 20px;
  height: 34px;
  padding: 0 12px;
  border-top: 1px solid var(--industrial-grid);
  background: #eef2f4;
  font-size: 12px;
}

/* 主操作贴右下角 */
.po-foot__confirm {
  margin-left: auto;
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
