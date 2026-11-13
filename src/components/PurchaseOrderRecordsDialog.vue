<script setup>
import { computed, reactive } from 'vue'
import { ElButton, ElDialog, ElInputNumber, ElMessage, ElMessageBox } from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import { formatQuantity } from '@/utils/inventory'

// 订单弹窗：左列是已下订单（每张单一个到货输入框 + 撤销），右列是到货记录。
// 已下单 / 已到货只统计 active 订单；到货是追加 receipts，撤销到货 = 撤掉最后一条。
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  item: { type: Object, default: null },
})
const emit = defineEmits(['update:modelValue', 'cancelled'])

const purchaseStore = usePurchaseStore()
const receiveDrafts = reactive({})

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const skuId = computed(() => String(props.item?.skuId ?? '').trim())
const title = computed(
  () => `采购订单 · ${props.item?.product ?? ''} ${props.item?.color ?? ''}`.trim(),
)
const summary = computed(() => purchaseStore.orderSummary(skuId.value))
const orders = computed(() => summary.value.orders)
const receipts = computed(() =>
  orders.value
    .flatMap((order) => order.receipts.map((receipt) => ({ ...receipt, order })))
    .sort((first, second) => String(second.at).localeCompare(String(first.at))),
)

function formatDate(value) {
  const stamp = Date.parse(value ?? '')
  if (!Number.isFinite(stamp)) return '—'
  const date = new Date(stamp)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function receivedOf(order) {
  return Number(order.receivedQty) || 0
}

function pendingOf(order) {
  return Math.max(0, (Number(order.quantity) || 0) - receivedOf(order))
}

function handleReceive(order, value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return
  if (!purchaseStore.receiveOrder(order.id, amount)) return
  receiveDrafts[order.id] = null
  ElMessage.success(`已登记到货 ${formatQuantity(amount)} 公斤`)
}

function handleQuantityChange(order, value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount === order.quantity) return
  purchaseStore.updateOrder(order.id, { quantity: amount })
  ElMessage.success(`下单量已改为 ${formatQuantity(amount)} 公斤`)
}

function handleRemoveReceipt() {
  if (!receipts.value.length) return
  purchaseStore.removeLastReceipt(receipts.value[0].order.id)
  ElMessage.success('已撤销最后一条到货记录')
}

async function handleCancel(order) {
  if (receivedOf(order) > 0) {
    try {
      await ElMessageBox.confirm(
        `这张分订单已到货 ${formatQuantity(receivedOf(order))} 公斤，撤销后到货记录一并作废。确定撤销？`,
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
  ElMessage.success(`已撤销 ${formatQuantity(result.quantity)} 公斤，需安排已退回`)
}
</script>

<template>
  <ElDialog
    v-model="visible"
    :title="title"
    width="900px"
    class="order-records-dialog"
    destroy-on-close
    align-center
  >
    <dl class="order-records-summary">
      <div>
        <dt>已下单</dt>
        <dd>{{ formatQuantity(summary.total) }}</dd>
      </div>
      <div>
        <dt>已到货</dt>
        <dd>{{ formatQuantity(summary.received) }}</dd>
      </div>
      <div>
        <dt>待收</dt>
        <dd>{{ formatQuantity(summary.pending) }}</dd>
      </div>
      <div>
        <dt>分订单</dt>
        <dd>{{ summary.count }} 张</dd>
      </div>
    </dl>

    <div class="order-records-body">
      <section class="order-records-column">
        <header class="order-records-column__head">已下订单</header>
        <p v-if="orders.length === 0" class="order-records-empty">该 SKU 还没有订单</p>
        <article v-for="order in orders" :key="order.id" class="order-records-item">
          <div class="order-records-item__head">
            <span class="order-records-item__factory">
              {{ order.factoryName || '未指定染厂' }}
            </span>
            <span class="order-records-item__date">{{ formatDate(order.submittedAt) }}</span>
          </div>
          <div class="order-records-item__meta">
            <span v-if="order.vatCount">{{ order.vatCount }} 缸</span>
            <span v-if="order.assignee">{{ order.assignee }}</span>
            <span v-if="order.note">{{ order.note }}</span>
          </div>
          <div class="order-records-item__row">
            <label class="order-records-item__label">下单</label>
            <ElInputNumber
              :model-value="order.quantity"
              size="small"
              :min="1"
              :controls="false"
              class="order-records-item__input"
              @change="handleQuantityChange(order, $event)"
            />
            <label class="order-records-item__label">到货</label>
            <ElInputNumber
              v-model="receiveDrafts[order.id]"
              size="small"
              :min="1"
              :controls="false"
              placeholder="本次到货"
              class="order-records-item__input"
              @change="handleReceive(order, $event)"
            />
          </div>
          <div class="order-records-item__foot">
            <span class="order-records-item__pending">
              已到 {{ formatQuantity(receivedOf(order)) }} · 待收
              {{ formatQuantity(pendingOf(order)) }}
            </span>
            <ElButton size="small" text type="danger" @click="handleCancel(order)">
              撤销
            </ElButton>
          </div>
        </article>
      </section>

      <section class="order-records-column">
        <header class="order-records-column__head">
          到货订单
          <ElButton
            v-if="receipts.length > 0"
            size="small"
            text
            type="danger"
            @click="handleRemoveReceipt"
          >
            撤销最后一条
          </ElButton>
        </header>
        <p v-if="receipts.length === 0" class="order-records-empty">还没有到货记录</p>
        <article v-for="receipt in receipts" :key="receipt.id" class="order-records-receipt">
          <span class="order-records-receipt__date">{{ formatDate(receipt.at) }}</span>
          <span class="order-records-receipt__qty">{{ formatQuantity(receipt.qty) }} 公斤</span>
          <span class="order-records-receipt__factory">
            {{ receipt.order.factoryName || '未指定染厂' }}
          </span>
        </article>
      </section>
    </div>
  </ElDialog>
</template>

<style scoped>
.order-records-summary {
  display: flex;
  gap: 28px;
  margin: 0 0 14px;
  padding: 10px 14px;
  border-radius: 8px;
  background: #f5f7fa;
}

.order-records-summary div {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.order-records-summary dt {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.order-records-summary dd {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.order-records-body {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 14px;
  max-height: 58vh;
}

.order-records-column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.order-records-column__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.order-records-empty {
  margin: 0;
  padding: 18px 0;
  text-align: center;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

.order-records-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: #fff;
}

.order-records-item__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.order-records-item__factory {
  font-size: 13px;
  font-weight: 600;
}

.order-records-item__date,
.order-records-item__meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.order-records-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.order-records-item__row {
  display: grid;
  grid-template-columns: auto 96px auto 96px;
  align-items: center;
  gap: 6px;
}

.order-records-item__label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.order-records-item__input {
  width: 96px;
}

.order-records-item__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.order-records-item__pending {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.order-records-receipt {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-lighter);
  font-size: 12px;
}

.order-records-receipt__qty {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.order-records-receipt__factory {
  color: var(--el-text-color-secondary);
}
</style>
