<script setup>
import { computed } from 'vue'
import {
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElMessage,
  ElMessageBox,
} from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import { QUANTITY_MAX } from '@/utils/quantityInput'

// 采购分订单明细（对账口径）。到仓事实以导入的出入库明细（生产入库）为准，
// 所以这里不再按单登记到货：右侧只做到仓对账，手工到货降级成 ⋯ 里的「补登记到货」兜底。
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  item: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue', 'cancelled'])

const purchaseStore = usePurchaseStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const skuId = computed(() => String(props.item?.skuId ?? '').trim())
const productText = computed(() => String(props.item?.product ?? '').trim() || '采购订单')
const subtitleText = computed(() => String(props.item?.color ?? '').trim())
const summary = computed(() => purchaseStore.orderSummary(skuId.value))
const orders = computed(() => summary.value.orders)

// 到仓对账取自主面板那一行：在仓来自导入，在途来自订单 / 排单 / 生产入库的对账结果。
const warehouseKg = computed(() => numberOrNull(props.item?.warehouseKg))
const inTransitKg = computed(() => numberOrNull(props.item?.inTransitKg))
const allArrived = computed(() => inTransitKg.value !== null && !(inTransitKg.value > 0))
// 手工补登记的合计（只在导入没跟上时用），有值才在行里提示一句。
const manualReceived = computed(() =>
  orders.value.reduce((sum, order) => sum + receivedOf(order), 0),
)

const sortedOrders = computed(() =>
  [...orders.value].sort((first, second) =>
    String(second.submittedAt ?? '').localeCompare(String(first.submittedAt ?? '')),
  ),
)

function numberOrNull(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

function pad(value) {
  return String(value).padStart(2, '0')
}

// 弹窗里只到分钟、不带年份：同一天的多笔单也分得出先后。
function formatMoment(value) {
  const stamp = Date.parse(value ?? '')
  if (!Number.isFinite(stamp)) return '—'
  const date = new Date(stamp)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

// 公斤数带千分位（2,400 / 1,340），最多两位小数。
function formatNumber(value) {
  if (value === null || value === undefined) return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function receivedOf(order) {
  return Number(order.receivedQty) || 0
}

// 待收只用于「补登记到货」的上限校验：到仓不靠它，界面也不展示。
function pendingOf(order) {
  return Math.max(0, (Number(order.quantity) || 0) - receivedOf(order))
}

function quantityPatchOf(order, quantity) {
  const perVat = Number(order?.kgPerVat) || 0
  const vatCount = perVat > 0 ? Math.round(quantity / perVat) : 0
  if (
    order?.quantityMode === 'vat' &&
    vatCount > 0 &&
    Math.abs(quantity / perVat - vatCount) < 0.005
  ) {
    return { quantity, quantityMode: 'vat', vatCount, kgPerVat: perVat }
  }
  return { quantity, quantityMode: 'kg', vatCount: null, kgPerVat: null }
}

function onCardCommand(order, command) {
  if (command === 'edit') void handleEditQuantity(order)
  else if (command === 'receive') void handleManualReceive(order)
  else if (command === 'cancel') void handleCancel(order)
}

async function handleEditQuantity(order) {
  const received = receivedOf(order)
  let input = ''
  try {
    const result = await ElMessageBox.prompt(
      `当前下单 ${formatNumber(order.quantity)} 公斤，已补登记到货 ${formatNumber(received)} 公斤。`,
      '修改下单量（公斤）',
      {
        inputValue: String(order.quantity),
        inputType: 'number',
        inputPlaceholder: '新的下单量',
        inputValidator: (value) => {
          const amount = Number(value)
          if (!Number.isFinite(amount) || amount <= 0) return '请填写大于 0 的公斤数'
          if (amount > QUANTITY_MAX) return `最多输入 ${QUANTITY_MAX} 公斤（6 位数）`
          if (amount < received) return `不能少于已补登记的 ${formatNumber(received)} 公斤`
          return true
        },
        confirmButtonText: '确定',
        cancelButtonText: '取消',
      },
    )
    input = result.value
  } catch {
    return
  }

  const amount = Number(input)
  if (!Number.isFinite(amount) || amount <= 0 || amount === order.quantity) return
  const quantityPatch = quantityPatchOf(order, amount)
  purchaseStore.updateOrder(order.id, quantityPatch)
  const modeNotice =
    order.quantityMode === 'vat' && quantityPatch.quantityMode === 'kg'
      ? '，该数量不是整缸，已改按公斤记录'
      : ''
  ElMessage.success(`下单量已改为 ${formatNumber(amount)} 公斤${modeNotice}`)
}

// 补登记到货：官方到仓口径是导入的生产入库，这里只在导入还没跟上时兜底扣一次在途。
async function handleManualReceive(order) {
  const pending = pendingOf(order)
  if (!(pending > 0)) {
    ElMessage.warning('这张单已经补登记满了')
    return
  }
  let input = ''
  try {
    const result = await ElMessageBox.prompt(
      `到仓以导入的出入库明细为准，这里只做补登：最多 ${formatNumber(pending)} 公斤。`,
      '补登记到货（公斤）',
      {
        inputValue: String(pending),
        inputType: 'number',
        inputPlaceholder: '本次到货公斤数',
        inputValidator: (value) => {
          const amount = Number(value)
          if (!Number.isFinite(amount) || amount <= 0) return '请填写大于 0 的公斤数'
          if (amount > pending + 1e-9) return `这张单还剩 ${formatNumber(pending)} 公斤没到`
          return true
        },
        confirmButtonText: '登记',
        cancelButtonText: '取消',
      },
    )
    input = result.value
  } catch {
    return
  }

  const amount = Number(input)
  if (!(amount > 0)) return
  if (!purchaseStore.receiveOrder(order.id, amount)) return
  ElMessage.success(`已补登记到货 ${formatNumber(amount)} 公斤`)
}

// 撤销整单：整张分订单作废，公斤数退回主面板需安排。
async function handleCancel(order) {
  if (receivedOf(order) > 0) {
    try {
      await ElMessageBox.confirm(
        `这张分订单已补登记到货 ${formatNumber(receivedOf(order))} 公斤，撤销后那条记录一并作废。确定撤销？`,
        '撤销分订单',
        { type: 'warning', confirmButtonText: '撤销', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }

  const result = purchaseStore.cancelOrder(order.id)
  if (!result) return
  emit('cancelled', { skuId: skuId.value, quantity: result.quantity, order: result.order })
  ElMessage.success(`已撤销 ${formatNumber(result.quantity)} 公斤，需安排已退回`)
}
</script>

<template>
  <ElDialog
    v-model="visible"
    class="order-panel-dialog"
    width="min(760px, calc(100vw - 32px))"
    append-to-body
    align-center
    :show-close="false"
  >
    <template #header>
      <div class="order-head">
        <h2 class="order-head__title" :title="productText">{{ productText }}</h2>
        <span v-if="subtitleText" class="order-head__color">{{ subtitleText }}</span>
        <span class="order-head__spacer" />
        <button type="button" class="order-head__close" aria-label="关闭" @click="visible = false">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </template>

    <div v-if="props.item" class="order-panel">
      <!-- 列头兼汇总：左边讲分订单，右边讲到仓对账 -->
      <div class="order-thead">
        <div class="order-thead__cell" title="按染厂拆单，一张单一行">
          <span class="order-thead__name">分订单</span>
          <span class="order-thead__hint">
            {{ orders.length }} 张 · 下单合计
            <b>{{ formatNumber(summary.total) }}</b>
            公斤
          </span>
        </div>
        <div
          class="order-thead__cell order-thead__cell--right"
          title="到仓以导入的出入库明细（生产入库）为准，不按分订单勾到货"
        >
          <span class="order-thead__name">到仓对账</span>
          <span class="order-thead__hint">
            在仓 <b class="is-received">{{ formatNumber(warehouseKg) }}</b> ·
            在途
            <b :class="allArrived ? 'is-received' : 'is-pending'">{{ formatNumber(inTransitKg) }}</b>
            公斤
          </span>
        </div>
      </div>

      <div class="order-rows">
        <div v-if="!orders.length" class="ord-empty">
          <b>这个 SKU 还没有分订单</b>
          <span>分订单被撤销后，需要回需求表重新下单</span>
        </div>

        <div v-for="(order, index) in sortedOrders" :key="order.id" class="ord-row">
          <div class="ord-row__top">
            <span class="ord-row__idx">{{ index + 1 }}</span>
            <span class="ord-row__factory" :title="order.note || ''">
              {{ order.factoryName || '未指定染厂' }}
            </span>
            <span v-if="order.assignee" class="ord-row__person">{{ order.assignee }}</span>
            <span class="ord-row__time" :title="formatMoment(order.submittedAt)">
              {{ formatMoment(order.submittedAt) }}
            </span>
          </div>

          <div class="ord-row__bottom">
            <div class="ord-row__nums">
              <span class="ord-num"><em>下单</em><b>{{ formatNumber(order.quantity) }}</b></span>
              <span v-if="order.quantityMode === 'vat' && order.vatCount" class="ord-num">
                <em>缸</em><b>{{ order.vatCount }}</b>
              </span>
              <span
                v-if="receivedOf(order) > 0"
                class="ord-num ord-num--manual"
                title="手工补登记的到货，只在导入没跟上时用"
              >
                <em>补登</em><b>{{ formatNumber(receivedOf(order)) }}</b>
              </span>
            </div>

            <ElDropdown
              class="ord-row__more"
              trigger="click"
              placement="bottom-end"
              popper-class="ord-dropdown"
              @command="(command) => onCardCommand(order, command)"
            >
              <button type="button" class="ord-more" aria-label="更多操作">
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <circle cx="3.2" cy="8" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="12.8" cy="8" r="1.2" />
                </svg>
              </button>
              <template #dropdown>
                <ElDropdownMenu>
                  <ElDropdownItem command="edit">
                    <span class="ord-dropdown__icon">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M10.6 2.7a1.55 1.55 0 0 1 2.2 2.2L5.2 12.5l-2.9.6.6-2.9 7.7-7.5z" />
                        <path d="M9.6 3.7l2.2 2.2" />
                      </svg>
                    </span>
                    改单
                  </ElDropdownItem>
                  <ElDropdownItem command="receive" :disabled="pendingOf(order) <= 0">
                    <span class="ord-dropdown__icon">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M8 2.6v7.2M4.6 6.4 8 9.8l3.4-3.4" />
                        <path d="M2.8 12.4h10.4" />
                      </svg>
                    </span>
                    补登记到货
                  </ElDropdownItem>
                  <ElDropdownItem command="cancel" divided class="is-danger">
                    <span class="ord-dropdown__icon">
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="8" cy="8" r="5.5" />
                        <path d="M6.3 6.3l3.4 3.4M9.7 6.3l-3.4 3.4" />
                      </svg>
                    </span>
                    撤销整单
                  </ElDropdownItem>
                </ElDropdownMenu>
              </template>
            </ElDropdown>
          </div>
        </div>
      </div>

      <div class="order-foot">
        <span>
          到仓以导入的出入库明细为准（生产入库 → 在途归零、在仓增加）；
          导入还没跟上或来源单据没匹配上时，用 ⋯ → 补登记到货 先把在途扣掉<template
            v-if="manualReceived > 0"
          >。当前已补登记 {{ formatNumber(manualReceived) }} 公斤</template
          >。
        </span>
      </div>
    </div>
  </ElDialog>
</template>

<style scoped>
/* 弹窗外壳照原型：细边框、3px 圆角、头部灰蓝条 */
:global(.el-dialog.order-panel-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-color-danger: var(--industrial-danger);
  --el-dialog-padding-primary: 0;
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: #fff;
  width: min(760px, calc(100vw - 32px));
  /* 高度跟着内容走：分订单少时不留空白，内容多到 3/4 视窗高才在中间区域出滚动条 */
  height: auto;
  max-height: 75vh;
  min-height: 0;
  padding: 0;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  box-shadow: 0 8px 28px rgba(47, 59, 67, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

:global(.order-panel-dialog .el-dialog__header) {
  margin: 0;
  padding: 0 10px;
  min-height: 42px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--industrial-grid);
  background: var(--industrial-header);
}

:global(.order-panel-dialog .el-dialog__body) {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.order-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

/* ---------- 标题条 ---------- */
.order-head {
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  min-width: 0;
}

.order-head__title {
  overflow: hidden;
  margin: 0;
  color: var(--industrial-text);
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.order-head__color {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(63, 113, 141, 0.12);
  color: var(--industrial-primary);
  font-size: 12px;
  white-space: nowrap;
}

.order-head__spacer {
  margin-left: auto;
}

.order-head__close {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 2px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  background: none;
  color: var(--industrial-muted);
  cursor: pointer;
}

.order-head__close svg {
  width: 14px;
  height: 14px;
}

.order-head__close:hover {
  border-color: var(--industrial-grid);
  background: var(--industrial-surface);
  color: var(--industrial-text);
}

/* ---------- 列头兼汇总：左讲分订单，右讲到仓对账 ---------- */
.order-thead {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  border-bottom: 1px solid var(--industrial-grid);
  background: #fff;
}

.order-thead__cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  font-size: 11.5px;
  font-weight: 600;
}

.order-thead__cell--right {
  border-left: 1px solid var(--industrial-grid);
}

.order-thead__name {
  flex: 0 0 auto;
  white-space: nowrap;
}

.order-thead__hint {
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
  color: var(--industrial-muted);
  font-size: 10.5px;
  font-weight: 400;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.order-thead__hint b {
  color: var(--industrial-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.order-thead__hint b.is-pending {
  color: var(--industrial-danger);
}

.order-thead__hint b.is-received {
  color: var(--industrial-normal);
}

/* ---------- 分订单行 ---------- */
.order-rows {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.ord-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 26px 12px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.ord-empty b {
  color: var(--industrial-text);
  font-size: 12.5px;
}

.ord-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 9px;
  border-bottom: 1px solid var(--line-soft);
  background: #fff;
}

.ord-row:last-child {
  border-bottom: 0;
}

.ord-row:hover {
  background: #f8fafb;
}

.ord-row__top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

/* 小序号，和列头的「N 张」对得上 */
.ord-row__idx {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  border-radius: 2px;
  background: var(--industrial-page);
  color: var(--industrial-muted);
  font-size: 10px;
  line-height: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.ord-row__factory {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ord-row__person {
  flex: 0 0 auto;
  color: var(--industrial-muted);
  font-size: 10.5px;
  white-space: nowrap;
}

.ord-row__time {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ord-row__bottom {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ord-row__nums {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
  margin-left: 23px;
}

.ord-num {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  color: var(--industrial-text);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ord-num em {
  color: var(--industrial-muted);
  font-size: 10.5px;
  font-style: normal;
  font-weight: 400;
}

.ord-num b {
  font-weight: 600;
}

.ord-num--manual b {
  color: var(--industrial-muted);
  font-weight: 400;
}

.ord-row__more {
  margin-left: auto;
}

.ord-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: none;
  color: var(--industrial-muted);
  cursor: pointer;
}

.ord-more:hover {
  background: #e7edf0;
  color: var(--industrial-text);
}

/* 下拉浮层被 teleport 到 body，只能写全局选择器 */
:global(.el-popper.ord-dropdown.el-dropdown__popper) {
  min-width: 142px;
  padding: 4px;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  background: #fff;
  box-shadow:
    0 1px 3px rgba(47, 59, 67, 0.08),
    0 8px 22px rgba(47, 59, 67, 0.16);
}

:global(.ord-dropdown .el-dropdown-menu) {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  list-style: none;
}

:global(.ord-dropdown .el-dropdown-menu__item) {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 29px;
  padding: 0 8px;
  border-radius: 3px;
  color: var(--industrial-text);
  font-size: 12px;
  line-height: 29px;
}

:global(.ord-dropdown .el-dropdown-menu__item:not(.is-disabled):hover) {
  background: #eaf1f4;
  color: var(--industrial-primary);
}

:global(.ord-dropdown .el-dropdown-menu__item:not(.is-disabled):hover .ord-dropdown__icon) {
  color: var(--industrial-primary);
}

:global(.ord-dropdown .el-dropdown-menu__item.is-disabled) {
  color: #b3bdc3;
}

:global(.ord-dropdown .el-dropdown-menu__item.is-danger) {
  color: var(--industrial-danger);
}

:global(.ord-dropdown .el-dropdown-menu__item.is-danger .ord-dropdown__icon) {
  color: var(--industrial-danger);
}

:global(.ord-dropdown .el-dropdown-menu__item.is-danger:not(.is-disabled):hover) {
  background: #fbeeed;
  color: var(--industrial-danger);
}

:global(.ord-dropdown .el-dropdown-menu__item--divided) {
  margin-top: 4px;
  border-top: 1px solid var(--industrial-grid-light);
}

:global(.ord-dropdown .el-dropdown-menu__item--divided::before) {
  display: none;
}

:global(.ord-dropdown__icon) {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  color: var(--industrial-muted);
}

:global(.ord-dropdown__icon svg) {
  width: 13px;
  height: 13px;
}

/* ---------- 底部口径说明 ---------- */
.order-foot {
  flex: 0 0 auto;
  padding: 7px 10px 8px;
  border-top: 1px solid var(--industrial-grid);
  background: #fbfcfd;
  color: var(--industrial-muted);
  font-size: 10.5px;
  line-height: 1.55;
}
</style>
