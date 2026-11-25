<script setup>
import { computed, reactive, watch } from 'vue'
import {
  ElButton,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElMessage,
  ElMessageBox,
} from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import { QUANTITY_MAX } from '@/utils/quantityInput'

// 订单弹窗：左列是分订单（本次到货填完点「登记到货」），右列是到货记录（每条都能撤回 / 删除）。
// 累积下单 / 已到货只统计 active 订单；已到货由 receipts 求和派生，撤回或删除一条就自动退回待收。
// 视觉照 docs/prototype 的订单弹窗：一条汇总进度带 + 两栏列表，不再用四张卡。
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  item: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue', 'cancelled'])

const purchaseStore = usePurchaseStore()
// 本次到货草稿按分订单记：输入框只改草稿，点「登记到货」才写入订单流水。
const receiveDrafts = reactive({})

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const skuId = computed(() => String(props.item?.skuId ?? '').trim())
const productText = computed(() => String(props.item?.product ?? '').trim() || '采购订单')
const subtitleText = computed(() => String(props.item?.color ?? '').trim())
const summary = computed(() => purchaseStore.orderSummary(skuId.value))
const orders = computed(() => summary.value.orders)
// 到货进度：已到货 ÷ 累积下单，列头那根进度条就吃这个值。
const receivedPercent = computed(() => percentOf(summary.value.received, summary.value.total))
// 还有待收的排在前面（那些才是要动手的），同组里按下单时间倒序
const sortedOrders = computed(() =>
  [...orders.value].sort((first, second) => {
    const firstDone = pendingOf(first) > 0 ? 0 : 1
    const secondDone = pendingOf(second) > 0 ? 0 : 1
    if (firstDone !== secondDone) return firstDone - secondDone
    return String(second.submittedAt ?? '').localeCompare(String(first.submittedAt ?? ''))
  }),
)

// 每次打开清一次草稿：上一次没点确认的数量不带到这一次。
watch(
  () => [props.modelValue, skuId.value],
  ([open]) => {
    if (!open) return
    for (const key of Object.keys(receiveDrafts)) delete receiveDrafts[key]
  },
  { immediate: true },
)

function percentOf(value, total) {
  const amount = Number(value) || 0
  const whole = Number(total) || 0
  if (!(whole > 0)) return 0
  return Math.min(100, Math.max(0, Math.round((amount / whole) * 100)))
}

function pad(value) {
  return String(value).padStart(2, '0')
}

// 弹窗里只到分钟、不带年份：同一天的多笔到货也分得出先后。
function formatMoment(value) {
  const stamp = Date.parse(value ?? '')
  if (!Number.isFinite(stamp)) return '—'
  const date = new Date(stamp)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

function formatFullMoment(value) {
  const stamp = Date.parse(value ?? '')
  if (!Number.isFinite(stamp)) return '时间未知'
  const date = new Date(stamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

// 公斤数带千分位（2,400 / 1,340），最多两位小数。
function formatNumber(value) {
  if (value === null || value === undefined) return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

// 缸只在下单环节换算，订单记录里不再显示，只留分单人员
function orderMetaText(order) {
  return String(order.assignee ?? '').trim()
}

// 下单时间与备注不占行内位置，鼠标停在染厂那一行能看到
function orderMetaTitle(order) {
  return [orderMetaText(order), formatMoment(order.submittedAt), order.note]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' · ')
}

// 每张单的三个次要操作都收进 ⋯：行内只留「登记到货」这一个主动作
function onCardCommand(order, command) {
  if (command === 'edit') handleEditQuantity(order)
  else if (command === 'drop') handleRemovePending(order)
  else if (command === 'cancel') handleCancel(order)
}

function receivedOf(order) {
  return Number(order.receivedQty) || 0
}

// 每张单自己的到货记录（时间倒序），挂在它右侧那一格
function receiptsOf(order) {
  return (order.receipts ?? [])
    .map((receipt) => ({ ...receipt, order }))
    .sort((first, second) => String(second.at).localeCompare(String(first.at)))
}

// 待收 = 下单 − 已到货，纯派生值：界面上只读，改单 / 到货 / 撤回会自己带着变。
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

// 待收归零 = 这单已经收齐：登记区整块不出现，只留结论
function isSettled(order) {
  return pendingOf(order) <= 0
}

// 右下角的到货小计：有效几条、撤回几条（一条都没有时留空，别和下面的空态重复）
function receiptCountText(order) {
  const list = order.receipts ?? []
  const active = list.filter((receipt) => !receipt.voidedAt).length
  const voided = list.length - active
  const parts = []
  if (active) parts.push(`${active} 次到货`)
  if (voided) parts.push(`${voided} 条已撤回`)
  return parts.join(' · ')
}

// 点「待收」= 整单到齐：把剩余量填进本次到货，省一次手输
function fillPending(order) {
  const pending = pendingOf(order)
  if (pending > 0) receiveDrafts[order.id] = pending
}

function draftAmount(order) {
  const amount = Number(receiveDrafts[order.id])
  return Number.isFinite(amount) ? amount : 0
}

function onDraftInput(order, event) {
  const raw = String(event?.target?.value ?? '').trim()
  receiveDrafts[order.id] = raw === '' ? null : Number(raw)
}

function confirmReceive(order) {
  const amount = draftAmount(order)
  const pending = pendingOf(order)
  if (!(amount > 0)) {
    ElMessage.warning('请先填写本次到货数量')
    return
  }
  if (amount > pending + 1e-9) {
    ElMessage.warning(`这张单待收 ${formatNumber(pending)} 公斤，到货不能超过待收`)
    return
  }
  if (!purchaseStore.receiveOrder(order.id, amount)) return
  receiveDrafts[order.id] = null
  ElMessage.success(`已登记到货 ${formatNumber(amount)} 公斤`)
}

// 撤回：记录留痕、数量退回待收；删除：连记录一起抹掉（录错数据时用）。
async function handleVoidReceipt(receipt) {
  try {
    await ElMessageBox.confirm(
      `撤回 ${formatFullMoment(receipt.at)} 的到货 ${formatNumber(receipt.qty)} 公斤？数量会退回待收，记录会留一条「已撤回」痕迹。`,
      '撤回到货',
      { type: 'warning', confirmButtonText: '撤回', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  if (!purchaseStore.voidReceipt(receipt.order.id, receipt.id)) return
  ElMessage.success(`已撤回 ${formatNumber(receipt.qty)} 公斤，数量回到待收`)
}

// 恢复：撤回也能撤回（撤错了再放回），数量重新计入已到货、待收相应减少。
function handleRestoreReceipt(receipt) {
  const amount = Number(receipt.qty) || 0
  const received = receivedOf(receipt.order)
  const quantity = Number(receipt.order.quantity) || 0
  if (received + amount > quantity + 1e-9) {
    ElMessage.warning(
      `这张单下单量已改为 ${formatNumber(quantity)} 公斤、已到货 ${formatNumber(received)} 公斤，恢复这条 ${formatNumber(amount)} 公斤会超过下单量`,
    )
    return
  }
  if (!purchaseStore.restoreReceipt(receipt.order.id, receipt.id)) return
  ElMessage.success(`已恢复到货 ${formatNumber(amount)} 公斤，待收已相应减少`)
}

async function handleDeleteReceipt(receipt) {
  try {
    await ElMessageBox.confirm(
      `彻底删除 ${formatFullMoment(receipt.at)} 的到货记录 ${formatNumber(receipt.qty)} 公斤？删除后不留痕迹，数量同样退回待收。`,
      '删除到货记录',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  if (!purchaseStore.removeReceipt(receipt.order.id, receipt.id)) return
  ElMessage.success(`已删除这条到货记录，${formatNumber(receipt.qty)} 公斤回到待收`)
}

// 删除待收：剩下的不进了，已到货的部分保留，下单量降到已到货量。
async function handleRemovePending(order) {
  const pending = pendingOf(order)
  const received = receivedOf(order)
  if (!(pending > 0)) return
  // 一分货都没到：删除待收等价于整张单作废，直接走撤销（否则会留下一条 0 公斤的空单）
  if (!(received > 0)) {
    await handleCancel(order)
    return
  }
  try {
    await ElMessageBox.confirm(
      `删除这张分订单剩余的待收 ${formatNumber(pending)} 公斤？已到货的 ${formatNumber(received)} 公斤保留，下单量会改成 ${formatNumber(received)} 公斤。`,
      '删除待收',
      { type: 'warning', confirmButtonText: '删除待收', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const quantityPatch = quantityPatchOf(order, received)
  purchaseStore.updateOrder(order.id, quantityPatch)
  const modeNotice =
    order.quantityMode === 'vat' && quantityPatch.quantityMode === 'kg'
      ? '，剩余量不足整缸，已改按公斤记录'
      : ''
  ElMessage.success(`已删除待收 ${formatNumber(pending)} 公斤${modeNotice}`)
}

async function handleEditQuantity(order) {
  const received = receivedOf(order)
  let input = ''
  try {
    const result = await ElMessageBox.prompt(
      `当前下单 ${formatNumber(order.quantity)} 公斤，已到货 ${formatNumber(received)} 公斤。`,
      '修改下单量（公斤）',
      {
        inputValue: String(order.quantity),
        inputType: 'number',
        inputPlaceholder: '新的下单量',
        inputValidator: (value) => {
          const amount = Number(value)
          if (!Number.isFinite(amount) || amount <= 0) return '请填写大于 0 的公斤数'
          if (amount > QUANTITY_MAX) return `最多输入 ${QUANTITY_MAX} 公斤（6 位数）`
          if (amount < received) return `不能少于已到货的 ${formatNumber(received)} 公斤`
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

// 撤销整单：整张分订单作废（含到货记录），公斤数退回主面板需安排。
async function handleCancel(order) {
  if (receivedOf(order) > 0) {
    try {
      await ElMessageBox.confirm(
        `这张分订单已到货 ${formatNumber(receivedOf(order))} 公斤，撤销后到货记录一并作废。确定撤销？`,
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
    width="min(920px, calc(100vw - 32px))"
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
      <!-- 列头兼汇总：左边只讲下单 / 待收，右边只讲已到 + 进度 -->
      <div class="order-thead">
        <div class="order-thead__cell" title="按染厂拆单，每张单的到货记录就排在它右边">
          <span class="order-thead__name">分订单</span>
          <span class="order-thead__hint">
            {{ orders.length }} 张 · 下单合计
            <b>{{ formatNumber(summary.total) }}</b>
            · 待收
            <b class="is-pending">{{ formatNumber(summary.pending) }}</b>
          </span>
        </div>
        <div
          class="order-thead__cell order-thead__cell--right"
          title="撤回的记录会留一行，数量退回待收"
        >
          <span class="order-thead__name">到货记录</span>
          <span class="order-thead__hint">
            已到 <b class="is-received">{{ formatNumber(summary.received) }}</b> 公斤
          </span>
          <span class="order-thead__track" :title="`到货进度 ${receivedPercent}%`">
            <i :style="{ width: `${receivedPercent}%` }" />
          </span>
          <span class="order-thead__pct">{{ receivedPercent }}%</span>
        </div>
      </div>

      <div class="order-pairs">
          <div v-if="!orders.length" class="ord-empty">
            <b>这个 SKU 还没有分订单</b>
            <span>分订单被撤销后，需要回需求表重新下单</span>
          </div>

          <div
            v-for="(order, index) in sortedOrders"
            :key="order.id"
            class="ord-pair"
            :class="{ 'is-settled': isSettled(order) }"
          >
            <div class="ord-pair__left">
              <div class="ord-row__top">
                <span class="ord-row__idx">{{ index + 1 }}</span>
                <span class="ord-row__factory" :title="orderMetaTitle(order)">
                  {{ order.factoryName || '未指定染厂' }}
                </span>
                <span v-if="order.assignee" class="ord-row__person">{{ order.assignee }}</span>
                <span
                  class="ord-row__time"
                  :title="`${formatFullMoment(order.submittedAt)} 下单`"
                >{{ formatMoment(order.submittedAt) }}</span>
              </div>

              <div class="ord-row__bottom">
                <div class="ord-row__nums">
                  <span class="ord-num"><em>下单</em><b>{{ formatNumber(order.quantity) }}</b></span>
                  <span v-if="isSettled(order)" class="ord-chip">已收齐</span>
                  <button
                    v-else
                    type="button"
                    class="ord-num ord-num--pending"
                    :title="`点一下 → 本次到货自动填 ${formatNumber(pendingOf(order))}（剩余全部到齐）`"
                    @click="fillPending(order)"
                  >
                    <em>待收</em><b>{{ formatNumber(pendingOf(order)) }}</b>
                  </button>
                </div>

                <div class="ord-row__acts">
                  <label v-if="!isSettled(order)" class="ord-recv">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      :value="receiveDrafts[order.id] ?? ''"
                      placeholder="0"
                      :disabled="pendingOf(order) <= 0"
                      :aria-label="`${order.factoryName || '分订单'} 本次到货公斤数`"
                      :title="pendingOf(order) > 0 ? `最多 ${formatNumber(pendingOf(order))} 公斤` : '已收齐'"
                      @input="onDraftInput(order, $event)"
                      @keydown.enter.prevent="confirmReceive(order)"
                    />
                    <span>公斤</span>
                  </label>
                  <ElButton
                    v-if="!isSettled(order)"
                    class="order-card__confirm"
                    size="small"
                    type="primary"
                    :disabled="pendingOf(order) <= 0"
                    @click="confirmReceive(order)"
                  >
                    登记到货
                  </ElButton>
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
                        <ElDropdownItem command="drop" :disabled="pendingOf(order) <= 0">
                          <span class="ord-dropdown__icon">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <circle cx="8" cy="8" r="5.5" />
                              <path d="M5.8 8h4.4" />
                            </svg>
                          </span>
                          删除待收
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

            <div class="ord-pair__right">
              <div class="ord-pair__list">
                <!-- 这一单的到货小计：和它下面的明细同列，跟列头是「小计 → 合计」的关系 -->
                <div class="rcpt-head">
                  <em>{{ receiptCountText(order) }}</em>
                  <span>已到</span>
                  <b>{{ formatNumber(receivedOf(order)) }} 公斤</b>
                </div>
                <div
                  v-for="receipt in receiptsOf(order)"
                  :key="receipt.id"
                  class="rcpt"
                  :class="{ 'is-voided': receipt.voidedAt }"
                >
                  <span class="rcpt__time" :title="formatFullMoment(receipt.at)">
                    {{ formatMoment(receipt.at) }}
                  </span>
                  <span
                    class="rcpt__qty"
                    :title="receipt.voidedAt ? `已撤回 ${formatFullMoment(receipt.voidedAt)}` : ''"
                  >
                    +{{ formatNumber(receipt.qty) }} 公斤
                  </span>
                  <span class="rcpt__acts">
                    <button
                      v-if="!receipt.voidedAt"
                      type="button"
                      @click="handleVoidReceipt(receipt)"
                    >
                      撤回
                    </button>
                    <button
                      v-else
                      type="button"
                      class="is-restore"
                      @click="handleRestoreReceipt(receipt)"
                    >
                      恢复
                    </button>
                    <button type="button" class="is-danger" @click="handleDeleteReceipt(receipt)">
                      删除
                    </button>
                  </span>
                </div>
                <span v-if="!receiptsOf(order).length" class="rcpt-none">还没有到货</span>
              </div>
            </div>
          </div>
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
  width: min(920px, calc(100vw - 32px));
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
  /* 头部是 flex 容器，标题条必须撑满，否则 margin-left: auto 的占位撑不开，关闭按钮会贴在标签后面 */
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

/* ---------- 列头兼汇总：左列只讲下单 / 待收，右列只讲已到 + 进度 ---------- */
.order-thead {
  display: grid;
  flex: 0 0 auto;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
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

/* 进度条吃掉列头剩下的宽度，右端紧跟百分比 */
.order-thead__track {
  flex: 1 1 auto;
  min-width: 40px;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: #dde5e9;
}

.order-thead__track i {
  display: block;
  min-width: 2px;
  height: 100%;
  border-radius: 999px;
  background: var(--industrial-primary);
  transition: width 0.18s ease;
}

.order-thead__pct {
  flex: 0 0 auto;
  color: var(--industrial-muted);
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.order-pairs {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.ord-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  border-bottom: 1px solid var(--line-soft);
  background: #fff;
}

.ord-pair:last-child {
  border-bottom: 0;
}

/* 已收齐的整行淡下去：这一单没有待办了 */
.ord-pair.is-settled {
  background: #fbfcfc;
}

.ord-pair:hover .ord-pair__left {
  background: #f8fafb;
}

.ord-pair__left {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px 9px;
}

/* 右格跟着整行走，记录再多也不在格内滚动（外层统一滚） */
.ord-pair__right {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 8px 10px 9px;
  border-left: 1px solid var(--industrial-grid);
}

.ord-pair__list {
  margin: auto 0;
}

/* ---------- 分订单行：上面是谁的单，下面是要办的事 ---------- */
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

/* 缸数不显示，这里直接给下单时间 */
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
  flex-direction: column;
  gap: 6px;
}

/* 下单 / 待收 靠右，和下面的登记到货共用一条右边界 */
.ord-row__nums {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 12px;
  min-height: 17px;
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

/* 收齐的单没有登记区了，把「下单 + 已收齐」放大占住这块位置 */
.ord-pair.is-settled .ord-num em {
  font-size: 11px;
}

.ord-pair.is-settled .ord-num b {
  font-size: 15px;
}

/* 点一下「待收」= 剩余全部到齐，少一次手输 */
.ord-num--pending {
  padding: 0;
  border: 0;
  background: none;
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.ord-num--pending b {
  color: var(--industrial-danger);
}

.ord-num--pending:hover b {
  text-decoration: underline dotted;
}

.ord-chip {
  padding: 2px 8px;
  border: 1px solid rgba(63, 127, 79, 0.35);
  border-radius: 3px;
  background: rgba(63, 127, 79, 0.08);
  color: var(--industrial-normal);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.ord-row__acts {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ⋯（改单 / 删除待收 / 撤销整单）固定在卡片左下角，登记到货靠右 */
.ord-row__more {
  order: -1;
  margin-right: auto;
}

.ord-recv {
  display: inline-flex;
  align-items: center;
  height: 25px;
  overflow: hidden;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: #fff;
}

.ord-recv:focus-within {
  border-color: var(--industrial-primary);
}

.ord-recv input {
  width: 50px;
  height: 100%;
  padding: 0 4px;
  border: 0;
  background: none;
  color: var(--industrial-text);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
  outline: none;
}

.ord-recv input::placeholder {
  color: #a9b4bb;
}

.ord-recv span {
  padding: 0 5px 0 2px;
  color: var(--industrial-muted);
  font-size: 10.5px;
}

.order-card__confirm {
  --el-button-bg-color: var(--industrial-primary);
  --el-button-border-color: var(--industrial-primary);
  --el-button-hover-bg-color: var(--industrial-primary-hover);
  --el-button-hover-border-color: var(--industrial-primary-hover);
  height: 25px;
  padding: 0 9px;
  font-size: 12px;
}

/* 三个次要操作收进 ⋯：行内只留一个主动作 */
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

/* ---------- 到货记录（挂在对应分订单右侧） ---------- */
/* 这一单的到货小计：和明细同列，跟列头是「小计 → 合计」的关系 */
.rcpt-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 5px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--industrial-grid-light);
}

.rcpt-head span {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 10.5px;
}

.rcpt-head b {
  color: var(--industrial-normal);
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rcpt-head em {
  color: var(--industrial-muted);
  font-size: 10.5px;
  font-style: normal;
  white-space: nowrap;
}

.rcpt {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  padding: 2.5px 0;
}

.rcpt__time {
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rcpt__qty {
  color: #3f7d5a;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-align: right;
}

/* 平时只留「时间 + 数量」，鼠标停到这一对、或键盘聚焦时才浮现撤回 / 删除 */
.rcpt__acts {
  display: flex;
  flex: 0 0 auto;
  gap: 7px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.ord-pair:hover .rcpt__acts,
.rcpt:focus-within .rcpt__acts {
  opacity: 1;
}

/* 触屏没有 hover，直接常显 */
@media (hover: none) {
  .rcpt__acts {
    opacity: 1;
  }
}

.rcpt__acts button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--industrial-muted);
  font: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}

.rcpt__acts button:hover {
  color: var(--industrial-primary);
}

.rcpt__acts button.is-danger:hover {
  color: var(--industrial-danger);
}

/* 恢复 = 撤回的反向操作，用绿色区分，避免和「删除」一起被误点 */
.rcpt__acts button.is-restore {
  color: #3f7d5a;
}

.rcpt__acts button.is-restore:hover {
  color: #2f6248;
}

.rcpt.is-voided .rcpt__qty {
  color: #a9b4bb;
  text-decoration: line-through;
}

/* 这张单还没到过货 */
.rcpt-none {
  display: block;
  padding: 5px 0;
  color: #b3bcc2;
  font-size: 11px;
}

/* ---------- 空态 ---------- */
.ord-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 100%;
  min-height: 150px;
  padding: 24px 12px;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.ord-empty b {
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
}
</style>
