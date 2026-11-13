<script setup>
import { computed, reactive, watch } from 'vue'
import { ElButton, ElDialog, ElMessage, ElMessageBox } from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'

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
// 到货记录跨分订单汇总，按时间倒序；已撤回的留在列表里灰显可追溯。
const receipts = computed(() =>
  orders.value
    .flatMap((order) => (order.receipts ?? []).map((receipt) => ({ ...receipt, order })))
    .sort((first, second) => String(second.at).localeCompare(String(first.at))),
)
const activeReceiptCount = computed(
  () => receipts.value.filter((receipt) => !receipt.voidedAt).length,
)
const voidedReceiptCount = computed(() => receipts.value.length - activeReceiptCount.value)
// 到货进度：已到货 ÷ 累积下单，一眼看出这批货走到哪一步。
const receivedPercent = computed(() => percentOf(summary.value.received, summary.value.total))
const columnHint = computed(() =>
  summary.value.count ? `${summary.value.count} 张 · 按染厂拆单` : '按染厂拆单',
)
const receiptHint = computed(() => {
  if (!receipts.value.length) return ''
  return voidedReceiptCount.value
    ? `${activeReceiptCount.value} 条有效 · ${voidedReceiptCount.value} 条已撤回`
    : `${activeReceiptCount.value} 条有效`
})

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

function orderMetaText(order) {
  return [order.vatCount ? `${order.vatCount} 缸` : '', order.assignee, formatMoment(order.submittedAt), order.note]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' · ')
}

function receivedOf(order) {
  return Number(order.receivedQty) || 0
}

// 待收 = 下单 − 已到货，纯派生值：界面上只读，改单 / 到货 / 撤回会自己带着变。
function pendingOf(order) {
  return Math.max(0, (Number(order.quantity) || 0) - receivedOf(order))
}

function orderPercent(order) {
  return percentOf(receivedOf(order), order.quantity)
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
  try {
    await ElMessageBox.confirm(
      `删除这张分订单剩余的待收 ${formatNumber(pending)} 公斤？已到货的 ${formatNumber(received)} 公斤保留，下单量会改成 ${formatNumber(received)} 公斤。`,
      '删除待收',
      { type: 'warning', confirmButtonText: '删除待收', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  purchaseStore.updateOrder(order.id, { quantity: received })
  ElMessage.success(`已删除待收 ${formatNumber(pending)} 公斤`)
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
  purchaseStore.updateOrder(order.id, { quantity: amount })
  ElMessage.success(`下单量已改为 ${formatNumber(amount)} 公斤`)
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
    width="min(880px, calc(100vw - 32px))"
    append-to-body
    align-center
    :show-close="false"
  >
    <template #header>
      <div class="order-head">
        <h2 class="order-head__title" :title="productText">{{ productText }}</h2>
        <span v-if="subtitleText" class="order-head__color">{{ subtitleText }}</span>
        <span class="order-head__spacer" />
        <span class="order-head__count">
          {{ summary.count ? `${summary.count} 张分订单` : '无分订单' }}
        </span>
        <button type="button" class="order-head__close" aria-label="关闭" @click="visible = false">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </template>

    <div v-if="props.item" class="order-panel">
      <!-- 一条进度带替代四张卡：订了多少、到了多少、还差多少，一眼读完 -->
      <div class="order-sum">
        <div class="order-sum__item">
          <span>累积下单</span>
          <b>{{ formatNumber(summary.total) }}</b>
        </div>
        <div class="order-sum__item">
          <span>已到货</span>
          <b>{{ formatNumber(summary.received) }}</b>
        </div>
        <div class="order-sum__item" :class="{ 'is-pending': summary.pending > 0 }">
          <span>待收</span>
          <b>{{ formatNumber(summary.pending) }}</b>
        </div>
        <span class="order-sum__track" :title="`到货进度 ${receivedPercent}%`">
          <i :style="{ width: `${receivedPercent}%` }" />
        </span>
        <span class="order-sum__pct">{{ receivedPercent }}%</span>
      </div>

      <div class="order-body">
        <section class="order-col">
          <div class="order-col__head">
            <span class="order-col__title">分订单</span>
            <span class="order-col__hint">{{ columnHint }}</span>
          </div>
          <div class="order-list">
            <div v-if="!orders.length" class="ord-empty">
              <b>这个 SKU 还没有分订单</b>
              <span>分订单被撤销后，需要回主面板重新下单</span>
            </div>
            <article v-for="order in orders" :key="order.id" class="ord-card">
              <div class="ord-card__top">
                <span class="ord-card__factory">{{ order.factoryName || '未指定染厂' }}</span>
                <span class="ord-card__meta">{{ orderMetaText(order) }}</span>
              </div>

              <div class="ord-card__nums">
                <span class="ord-num"><em>下单</em>{{ formatNumber(order.quantity) }}</span>
                <span class="ord-num"><em>已到货</em>{{ formatNumber(receivedOf(order)) }}</span>
                <span class="ord-num" :class="{ 'is-pending': pendingOf(order) > 0 }">
                  <em>待收</em>{{ formatNumber(pendingOf(order)) }}
                </span>
                <span class="ord-card__track" :title="`已到 ${orderPercent(order)}%`">
                  <i :style="{ width: `${orderPercent(order)}%` }" />
                </span>
              </div>

              <div class="ord-card__act">
                <label class="ord-recv">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    :value="receiveDrafts[order.id] ?? ''"
                    placeholder="0"
                    :disabled="pendingOf(order) <= 0"
                    :aria-label="`${order.factoryName || '分订单'} 本次到货公斤数`"
                    @input="onDraftInput(order, $event)"
                    @keydown.enter.prevent="confirmReceive(order)"
                  />
                  <span>公斤</span>
                </label>
                <ElButton
                  class="order-card__confirm"
                  size="small"
                  type="primary"
                  :disabled="pendingOf(order) <= 0"
                  @click="confirmReceive(order)"
                >
                  登记到货
                </ElButton>
                <span class="ord-card__max">
                  {{ pendingOf(order) > 0 ? `最多 ${formatNumber(pendingOf(order))}` : '已收齐' }}
                </span>
                <span class="ord-card__links">
                  <button type="button" @click="handleEditQuantity(order)">改单</button>
                  <button
                    type="button"
                    class="is-warn"
                    :disabled="pendingOf(order) <= 0"
                    @click="handleRemovePending(order)"
                  >
                    删除待收
                  </button>
                  <button type="button" class="is-danger" @click="handleCancel(order)">
                    撤销整单
                  </button>
                </span>
              </div>
            </article>
          </div>
        </section>

        <section class="order-col order-col--receipts">
          <div class="order-col__head">
            <span class="order-col__title">到货记录</span>
            <span class="order-col__hint">{{ receiptHint }}</span>
          </div>
          <div class="order-list order-list--receipts">
            <div v-if="!receipts.length" class="ord-empty">
              <b>还没有到货记录</b>
              <span>在左侧填「本次到货」并登记，这里会按时间倒序列出</span>
            </div>
            <div
              v-for="receipt in receipts"
              :key="receipt.id"
              class="rcpt"
              :class="{ 'is-voided': receipt.voidedAt }"
            >
              <div class="rcpt__top">
                <span class="rcpt__time" :title="formatFullMoment(receipt.at)">
                  {{ formatMoment(receipt.at) }}
                </span>
                <span class="rcpt__qty">+{{ formatNumber(receipt.qty) }} 公斤</span>
                <span class="rcpt__acts">
                  <button
                    v-if="!receipt.voidedAt"
                    type="button"
                    @click="handleVoidReceipt(receipt)"
                  >
                    撤回
                  </button>
                  <button
                    type="button"
                    class="is-danger"
                    @click="handleDeleteReceipt(receipt)"
                  >
                    删除
                  </button>
                </span>
              </div>
              <div class="rcpt__sub">
                {{ receipt.order.factoryName || '未指定染厂' }}
                <template v-if="receipt.order.vatCount"> · {{ receipt.order.vatCount }} 缸</template>
                <template v-if="receipt.voidedAt"> · 已撤回 {{ formatMoment(receipt.voidedAt) }}</template>
              </div>
            </div>
          </div>
        </section>
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
  width: min(880px, calc(100vw - 32px));
  min-height: 300px;
  max-height: min(560px, calc(100vh - 40px));
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

.order-head__count {
  color: var(--industrial-muted);
  font-size: 11.5px;
  white-space: nowrap;
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

/* ---------- 汇总：一条进度带 ---------- */
.order-sum {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 30px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--industrial-grid);
  background: #fff;
}

.order-sum__item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}

.order-sum__item span {
  color: var(--industrial-muted);
  font-size: 11px;
}

.order-sum__item b {
  color: var(--industrial-text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}

.order-sum__item.is-pending b {
  color: var(--industrial-danger);
}

/* 进度条和三个数字同处一行：通栏贴在底边会看成一条分隔线 */
.order-sum__track {
  flex: 1 1 auto;
  min-width: 80px;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: #dde5e9;
}

.order-sum__track i {
  display: block;
  min-width: 2px;
  height: 100%;
  border-radius: 999px;
  background: var(--industrial-primary);
  transition: width 0.18s ease;
}

.order-sum__pct {
  flex: 0 0 auto;
  margin-left: -20px;
  color: var(--industrial-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

/* ---------- 两栏 ---------- */
.order-body {
  display: grid;
  flex: 1 1 auto;
  overflow: hidden;
  grid-template-columns: minmax(0, 1.32fr) minmax(0, 1fr);
  min-height: 0;
}

.order-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.order-col--receipts {
  border-left: 1px solid var(--industrial-grid);
}

.order-col__head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 12px;
  border-bottom: 1px solid var(--industrial-grid-light);
  background: #eef2f4;
}

.order-col__title {
  font-size: 12px;
  font-weight: 600;
}

.order-col__hint {
  color: var(--industrial-muted);
  font-size: 11px;
}

.order-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: min(420px, calc(100vh - 236px));
  padding: 10px 12px 14px;
  overflow: auto;
}

/* ---------- 分订单卡：三行读完 ---------- */
.ord-card {
  padding: 9px 11px 8px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
  background: #fff;
}

.ord-card + .ord-card {
  margin-top: 8px;
}

.ord-card:hover {
  border-color: var(--industrial-grid);
}

.ord-card__top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ord-card__factory {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ord-card__meta {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
}

.ord-card__nums {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-top: 7px;
}

.ord-num {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  color: var(--industrial-text);
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ord-num em {
  color: var(--industrial-muted);
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
}

.ord-num.is-pending {
  color: var(--industrial-danger);
}

.ord-card__track {
  flex: 1 1 auto;
  min-width: 48px;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: #dfe7ea;
}

.ord-card__track i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--industrial-normal);
}

/* 操作行：输入 + 主按钮靠左，次要操作靠右，用虚线和大字号差把两拨分开 */
.ord-card__act {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--industrial-grid-light);
}

.ord-recv {
  display: inline-flex;
  align-items: center;
  height: 28px;
  overflow: hidden;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: #fff;
}

.ord-recv:focus-within {
  border-color: var(--industrial-primary);
}

.ord-recv input {
  width: 62px;
  height: 100%;
  padding: 0 6px;
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
  padding: 0 6px 0 3px;
  color: var(--industrial-muted);
  font-size: 11px;
}

.order-card__confirm {
  --el-button-bg-color: var(--industrial-primary);
  --el-button-border-color: var(--industrial-primary);
  --el-button-hover-bg-color: var(--industrial-primary-hover);
  --el-button-hover-border-color: var(--industrial-primary-hover);
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}

.ord-card__max {
  color: var(--industrial-muted);
  font-size: 10.5px;
  white-space: nowrap;
}

.ord-card__links {
  display: flex;
  gap: 10px;
  margin-left: auto;
}

.ord-card__links button,
.rcpt__acts button {
  padding: 0;
  border: 0;
  background: none;
  color: var(--industrial-muted);
  font: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}

.ord-card__links button:hover,
.rcpt__acts button:hover {
  color: var(--industrial-primary);
}

.ord-card__links button.is-warn:hover {
  color: var(--industrial-replenish);
}

.ord-card__links button.is-danger {
  color: rgba(184, 79, 72, 0.72);
}

.ord-card__links button.is-danger:hover,
.rcpt__acts button.is-danger:hover {
  color: var(--industrial-danger);
}

.ord-card__links button:disabled {
  color: #c2cbd0;
  cursor: default;
}

/* ---------- 到货记录 ---------- */
.order-list--receipts {
  padding: 4px 12px 14px;
}

.rcpt {
  position: relative;
  padding: 8px 0 8px 15px;
  border-bottom: 1px solid var(--line-soft);
}

.order-list--receipts .rcpt:last-child {
  border-bottom: 0;
}

.rcpt::before {
  content: '';
  position: absolute;
  top: 14px;
  left: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--industrial-normal);
}

.rcpt__top {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.rcpt__time {
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rcpt__qty {
  color: #3f7d5a;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rcpt__acts {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.rcpt__sub {
  margin-top: 3px;
  color: var(--industrial-muted);
  font-size: 11px;
}

.rcpt.is-voided::before {
  background: #c9d2d7;
}

.rcpt.is-voided .rcpt__qty {
  color: #a9b4bb;
  text-decoration: line-through;
}

/* ---------- 空态 ---------- */
.ord-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 100%;
  min-height: 180px;
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
