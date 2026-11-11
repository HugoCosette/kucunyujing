<script setup>
import { computed } from 'vue'
import { ElButton, ElInput, ElInputNumber, ElOption, ElSelect } from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import { assigneesForSku, factoriesForSku, findFactoryById, findFactoryByName } from '@/purchase'
import { formatQuantity } from '@/utils/inventory'

// 单个 SKU 的分订单编辑器：主面板采购清单弹窗与采购下单页共用同一份实现。
// 染厂来自「下单设置」里该 SKU 的可选染厂，分单人员来自该 SKU 树形分类的名单；
// 两个下拉都允许临时手输，名单没维护全时不至于卡住下单（手输值不回写设置）。
const props = defineProps({
  item: {
    type: Object,
    required: true,
  },
  modelValue: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['update:modelValue'])

const purchaseStore = usePurchaseStore()

const skuId = computed(() => String(props.item?.skuId ?? '').trim())
const factoryOptions = computed(() => factoriesForSku(purchaseStore.settings, skuId.value))
const assigneeOptions = computed(() =>
  assigneesForSku(purchaseStore.settings, skuId.value, props.item?.treeCategory),
)
const planned = computed(() => Number(props.item?.planned) || 0)
const total = computed(() =>
  props.modelValue.reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0),
)
const difference = computed(() => total.value - planned.value)
const totalTone = computed(() => {
  if (!props.modelValue.length) return 'empty'
  if (Math.abs(difference.value) < 0.005) return 'match'
  return difference.value > 0 ? 'over' : 'under'
})
const totalHint = computed(() => {
  if (totalTone.value === 'empty') return '尚未录入分订单'
  if (totalTone.value === 'match') return '与需安排一致'
  return difference.value > 0
    ? `超出需安排 ${formatQuantity(difference.value)} 公斤`
    : `还差 ${formatQuantity(Math.abs(difference.value))} 公斤`
})

function updateEntries(next) {
  emit('update:modelValue', next)
}

function patchEntry(index, patch) {
  updateEntries(
    props.modelValue.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, ...patch } : entry,
    ),
  )
}

function addEntry() {
  updateEntries([
    ...props.modelValue,
    {
      id: `so-${Date.now().toString(36)}-${props.modelValue.length + 1}`,
      factoryId: '',
      factoryName: '',
      assignee: '',
      quantity: 0,
      note: '',
    },
  ])
}

function removeEntry(index) {
  updateEntries(props.modelValue.filter((_, entryIndex) => entryIndex !== index))
}

// select 的 value 是工厂 id；allow-create 时会回传用户输入的厂名，这里统一收敛成
// { factoryId, factoryName }：命中名单就带 id，手输的新厂名只留名字（不回写设置）。
function handleFactoryChange(index, value) {
  const text = String(value ?? '').trim()
  if (!text) {
    patchEntry(index, { factoryId: '', factoryName: '' })
    return
  }

  const matched = findFactoryById(purchaseStore.settings, text) ?? findFactoryByName(purchaseStore.settings, text)
  if (matched) {
    patchEntry(index, { factoryId: matched.id, factoryName: matched.name })
    return
  }
  patchEntry(index, { factoryId: '', factoryName: text })
}
</script>

<template>
  <div class="sku-order-editor">
    <div class="sku-order-editor__summary">
      <span class="sku-order-editor__metric">
        需安排 <strong>{{ formatQuantity(planned) }}</strong> 公斤
      </span>
      <span class="sku-order-editor__metric">
        已下单 <strong>{{ formatQuantity(total) }}</strong> 公斤
      </span>
      <span class="sku-order-editor__state" :class="`sku-order-editor__state--${totalTone}`">
        {{ totalHint }}
      </span>
    </div>

    <div class="sku-order-editor__table" role="table" aria-label="分订单">
      <div class="sku-order-editor__row sku-order-editor__row--head" role="row">
        <span role="columnheader">染厂</span>
        <span role="columnheader">分单人员</span>
        <span role="columnheader">数量（公斤）</span>
        <span role="columnheader">备注</span>
        <span role="columnheader">操作</span>
      </div>

      <div
        v-for="(entry, index) in modelValue"
        :key="entry.id || index"
        class="sku-order-editor__row"
        role="row"
      >
        <ElSelect
          class="sku-order-editor__select"
          :model-value="entry.factoryId || entry.factoryName"
          size="small"
          filterable
          allow-create
          default-first-option
          placeholder="选择染厂"
          :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单染厂`"
          @update:model-value="handleFactoryChange(index, $event)"
        >
          <ElOption
            v-for="factory in factoryOptions"
            :key="factory.id"
            :label="factory.name"
            :value="factory.id"
          />
        </ElSelect>

        <ElSelect
          class="sku-order-editor__select"
          :model-value="entry.assignee"
          size="small"
          filterable
          allow-create
          default-first-option
          placeholder="选择分单人员"
          :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单分单人员`"
          @update:model-value="patchEntry(index, { assignee: String($event ?? '').trim() })"
        >
          <ElOption v-for="person in assigneeOptions" :key="person" :label="person" :value="person" />
        </ElSelect>

        <ElInputNumber
          :model-value="entry.quantity"
          :min="0"
          :step="1"
          :precision="2"
          :controls="false"
          size="small"
          class="sku-order-editor__quantity"
          :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单数量`"
          @update:model-value="patchEntry(index, { quantity: Number($event) || 0 })"
        />

        <ElInput
          :model-value="entry.note"
          size="small"
          placeholder="可填缸号 / 交期"
          :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单备注`"
          @update:model-value="patchEntry(index, { note: $event })"
        />

        <ElButton size="small" text type="danger" @click="removeEntry(index)">删除</ElButton>
      </div>

      <p v-if="modelValue.length === 0" class="sku-order-editor__empty">
        这个 SKU 还没有分订单，点下方「添加分订单」按染厂拆分。
      </p>
    </div>

    <div class="sku-order-editor__actions">
      <ElButton size="small" @click="addEntry">＋ 添加分订单</ElButton>
      <span class="sku-order-editor__hint">
        染厂与分单人员可在「下单设置」里维护；临时手输的值只用于本次下单。
      </span>
    </div>
  </div>
</template>

<style scoped>
.sku-order-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sku-order-editor__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 16px;
  color: var(--industrial-muted);
  font-size: 13px;
}

.sku-order-editor__metric strong {
  color: var(--industrial-text);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.sku-order-editor__state {
  padding: 2px 8px;
  border: 1px solid var(--industrial-grid);
  border-radius: 10px;
  font-size: 12px;
}

.sku-order-editor__state--empty {
  color: var(--industrial-muted);
}

.sku-order-editor__state--match {
  color: var(--industrial-normal);
  border-color: var(--industrial-normal);
}

.sku-order-editor__state--under {
  color: var(--industrial-replenish);
  border-color: var(--industrial-replenish);
}

.sku-order-editor__state--over {
  color: var(--industrial-urgent);
  border-color: var(--industrial-urgent);
}

.sku-order-editor__table {
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  overflow: hidden;
}

.sku-order-editor__row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(110px, 1fr) 110px minmax(120px, 1.2fr) 56px;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--industrial-grid-light);
}

.sku-order-editor__row:first-child {
  border-top: none;
}

.sku-order-editor__row--head {
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-size: 12px;
  font-weight: 600;
}

.sku-order-editor__select,
.sku-order-editor__quantity {
  width: 100%;
}

.sku-order-editor__empty {
  margin: 0;
  padding: 18px 10px;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.sku-order-editor__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.sku-order-editor__hint {
  color: var(--industrial-muted);
  font-size: 12px;
}
</style>
