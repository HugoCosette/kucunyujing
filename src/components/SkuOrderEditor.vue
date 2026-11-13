<script setup>
import { computed } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect } from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import {
  assigneesForSku,
  factoriesForSku,
  findFactoryById,
  findFactoryByName,
  planOrderQuantity,
  resolveVatBand,
  resolveVatRule,
} from '@/purchase'
import { formatQuantity } from '@/utils/inventory'

// 单个 SKU 的分订单编辑器：主面板采购清单弹窗与采购下单页共用同一份实现。
// 染厂来自「下单设置」里该 SKU 的可选染厂，允许临时手输（不回写设置）；
// 分单人员优先用该 SKU 树形分类里维护的人，分类没配人时回退到分单人员表全部人员。
// 缸数按品名（SPU）绑定的缸规则换算：改缸数自动算公斤，改公斤自动回算缸数。
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

const vatRule = computed(() =>
  resolveVatRule(purchaseStore.settings, { skuId: skuId.value, product: props.item?.product }),
)
const vatContext = computed(() => ({
  planned: planned.value,
  monthlyAvgCount: props.item?.monthlyAvgCount,
  spuMonthlyAvg: props.item?.spuMonthlyAvg,
}))
const vatBand = computed(() => resolveVatBand(vatRule.value, vatContext.value))
const kgPerVat = computed(() => {
  const band = vatBand.value?.band
  if (!band || band.action === 'skip') return null
  const value = Number(band.value)
  return value > 0 ? value : null
})
const suggestion = computed(() => planOrderQuantity(planned.value, vatRule.value, vatContext.value))
const vatTotal = computed(() =>
  props.modelValue.reduce((sum, entry) => sum + (Number(entry.vatCount) || 0), 0),
)
const nonWholeCount = computed(
  () =>
    props.modelValue.filter((entry) => {
      const quantity = Number(entry.quantity) || 0
      const perVat = Number(entry.kgPerVat) || kgPerVat.value
      if (!perVat || quantity <= 0) return false
      return Math.abs(quantity / perVat - Math.round(quantity / perVat)) > 0.005
    }).length,
)

// 缸数显示：优先用分订单里存的快照，老分订单（只有公斤）按当前每缸公斤回算。
function vatCountOf(entry) {
  const stored = Number(entry?.vatCount)
  if (Number.isFinite(stored) && stored > 0) return stored
  const quantity = Number(entry?.quantity) || 0
  const perVat = Number(entry?.kgPerVat) || kgPerVat.value
  if (!perVat || quantity <= 0) return 0
  return Math.round((quantity / perVat) * 100) / 100
}

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
      vatCount: null,
      kgPerVat: kgPerVat.value,
      note: '',
    },
  ])
}

// 建议下单量按缸规则换算过（如 3 缸 × 80 = 240 公斤），点这里直接落成第一张分订单。
function addSuggestedEntry() {
  const result = suggestion.value
  if (!(result.rounded > 0)) return
  updateEntries([
    {
      id: `so-${Date.now().toString(36)}-1`,
      factoryId: '',
      factoryName: '',
      assignee: '',
      quantity: result.rounded,
      vatCount: result.vatCount,
      kgPerVat: result.kgPerVat ?? kgPerVat.value,
      note: '',
    },
  ])
}

// 改缸数：公斤数跟着 ＝ 缸数 × 每缸公斤；改公斤数：缸数按每缸公斤回算（可能不是整缸）。
function handleVatCountChange(index, value) {
  const vatCount = Math.max(0, Number(value) || 0)
  const perVat = kgPerVat.value
  patchEntry(index, {
    vatCount,
    quantity: perVat ? Math.round(vatCount * perVat * 100) / 100 : Number(props.modelValue[index]?.quantity) || 0,
    kgPerVat: perVat,
  })
}

function handleQuantityChange(index, value) {
  const quantity = Math.max(0, Number(value) || 0)
  const perVat = kgPerVat.value
  patchEntry(index, {
    quantity,
    vatCount: perVat ? Math.round((quantity / perVat) * 100) / 100 : null,
    kgPerVat: perVat,
  })
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

// 缸规则文案：只有 vat 才是真的「每缸」；round 是取整步长，fixed 是整单一单量。
// 说成「每缸 100 公斤」会把「34 × 100 取整」误解成 34 个缸。
const ruleShort = computed(() => {
  const rule = vatRule.value
  if (!rule) return '未绑定缸规则，按公斤精确下单'
  const action = suggestion.value.action
  const per = kgPerVat.value
  if (!per) return `「${rule.name}」判定当前不下单`
  if (action === 'fixed') return `${rule.name} · 固定 ${formatQuantity(per)} 公斤/单`
  if (action === 'round') return `${rule.name} · 按 ${formatQuantity(per)} 公斤取整`
  return `${rule.name} · 每缸 ${formatQuantity(per)} 公斤`
})

const ruleTitle = computed(() => {
  const rule = vatRule.value
  if (!rule) return '该品名未绑定缸规则，可在「下单设置 → 缸规则」绑定'
  const parts = []
  if (suggestion.value.bandText) parts.push(suggestion.value.bandText)
  if (suggestion.value.vatCount !== null && suggestion.value.rounded > 0) {
    parts.push(
      `建议 ${formatQuantity(suggestion.value.vatCount)} 缸 ＝ ${formatQuantity(suggestion.value.rounded)} 公斤`,
    )
  }
  for (const warning of suggestion.value.warnings ?? []) parts.push(warning)
  return parts.join(' · ') || rule.name
})
</script>

<template>
  <div class="so-editor">
    <div class="so-bar">
      <span class="so-bar__item">需安排 <b>{{ formatQuantity(planned) }}</b> 公斤</span>
      <span class="so-bar__item">已下单 <b>{{ formatQuantity(total) }}</b> 公斤</span>
      <span v-if="kgPerVat" class="so-bar__item">合计 <b>{{ formatQuantity(vatTotal) }}</b> 缸</span>
      <span v-if="nonWholeCount > 0" class="so-bar__warn">{{ nonWholeCount }} 张非整缸</span>
      <span class="so-bar__rule" :title="ruleTitle">{{ ruleShort }}</span>
    </div>

    <div class="so-table-wrap">
      <table class="so-table">
        <colgroup>
          <col style="width: 38px" />
          <col style="width: 26%" />
          <col style="width: 17%" />
          <col style="width: 9%" />
          <col style="width: 14%" />
          <col />
          <col style="width: 42px" />
        </colgroup>
        <thead>
          <tr>
            <th class="so-center">#</th>
            <th>染厂</th>
            <th>分单人员</th>
            <th class="so-r">缸数</th>
            <th class="so-r">数量（公斤）</th>
            <th>备注</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, index) in modelValue" :key="entry.id || index">
            <td class="so-idx">{{ index + 1 }}</td>
            <td>
              <ElSelect
                class="so-cell"
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
            </td>
            <td>
              <ElSelect
                class="so-cell"
                :model-value="entry.assignee"
                size="small"
                filterable
                :placeholder="assigneeOptions.length ? '选择人员' : '未维护人员'"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单分单人员`"
                @update:model-value="patchEntry(index, { assignee: String($event ?? '').trim() })"
              >
                <ElOption v-for="person in assigneeOptions" :key="person" :label="person" :value="person" />
              </ElSelect>
            </td>
            <td>
              <ElInputNumber
                :model-value="vatCountOf(entry)"
                :min="0"
                :step="1"
                :controls="false"
                :disabled="!kgPerVat"
                :placeholder="kgPerVat ? `× ${formatQuantity(kgPerVat)}` : '无缸'"
                size="small"
                class="so-cell so-cell--num"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单缸数`"
                @update:model-value="handleVatCountChange(index, $event)"
              />
            </td>
            <td>
              <ElInputNumber
                :model-value="entry.quantity"
                :min="0"
                :step="1"
                :precision="2"
                :controls="false"
                size="small"
                class="so-cell so-cell--num"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单数量`"
                @update:model-value="handleQuantityChange(index, $event)"
              />
            </td>
            <td>
              <ElInput
                :model-value="entry.note"
                size="small"
                placeholder="缸号 / 交期"
                class="so-cell"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单备注`"
                @update:model-value="patchEntry(index, { note: $event })"
              />
            </td>
            <td class="so-center">
              <button
                type="button"
                class="so-del"
                :aria-label="`删除第 ${index + 1} 个分订单`"
                title="删除这张分订单"
                @click="removeEntry(index)"
              >
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path
                    d="M5.6 2.2h4.8M2.6 4.4h10.8M4.2 4.4l.55 7.9a1 1 0 0 0 1 .93h4.5a1 1 0 0 0 1-.93l.55-7.9M6.6 6.8v4.2M9.4 6.8v4.2"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.15"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </td>
          </tr>

          <tr v-if="modelValue.length === 0">
            <td colspan="7" class="so-empty">
              还没有分订单。点下面「添加分订单」按染厂拆单，或直接用缸规则建议的一单。
            </td>
          </tr>

          <tr class="so-add-row">
            <td colspan="7">
              <button type="button" class="so-add" @click="addEntry">＋ 添加分订单</button>
              <button
                v-if="modelValue.length === 0 && suggestion.rounded > 0"
                type="button"
                class="so-add so-add--suggest"
                @click="addSuggestedEntry"
              >
                按建议添加（{{ formatQuantity(suggestion.rounded) }} 公斤）
              </button>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="modelValue.length">
          <tr>
            <td colspan="3" class="so-foot-label">合计</td>
            <td class="so-r so-foot-num">{{ formatQuantity(vatTotal) }}</td>
            <td class="so-r so-foot-num">{{ total.toFixed(2) }}</td>
            <td colspan="2" class="so-foot-state" :class="`so-foot-state--${totalTone}`">
              {{ totalHint }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>
</template>

<style scoped>
.so-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* 一条指标条：只留当前 SKU 的三个数，缸规则收成右侧一行灰字（悬停看完整判定） */
.so-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 18px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.so-bar__item b {
  margin: 0 2px;
  color: var(--industrial-text);
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.so-bar__warn {
  padding: 1px 6px;
  border: 1px solid #e2c9c7;
  border-radius: 2px;
  background: #f9efee;
  color: var(--industrial-urgent);
  font-size: 11px;
}

.so-bar__rule {
  margin-left: auto;
  font-size: 11.5px;
  cursor: help;
}

.so-table-wrap {
  min-width: 0;
  overflow-x: auto;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
}

/* 单元格里保留可编辑控件，但静止时没有边框：眼睛看到的是表格，不是一个表单 */
.so-table {
  width: 100%;
  min-width: 600px;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
}

.so-table th {
  height: 27px;
  padding: 0 8px;
  border-right: 1px solid var(--industrial-grid-light);
  border-bottom: 1px solid var(--industrial-grid);
  background: var(--industrial-header);
  color: #33424b;
  font-size: 11.5px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.so-table th:last-child {
  border-right: 0;
}

.so-table td {
  height: 34px;
  padding: 2px 6px;
  border-bottom: 1px solid var(--line-soft);
  vertical-align: middle;
}

.so-table tbody tr:hover td {
  background: #f8fafb;
}

.so-table tbody tr:last-child td {
  border-bottom: 0;
}

.so-r {
  text-align: right;
}

.so-center {
  text-align: center;
}

.so-idx {
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.so-cell {
  width: 100%;
}

.so-cell--num :deep(.el-input__inner) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.so-table :deep(.el-input__wrapper),
.so-table :deep(.el-select__wrapper) {
  min-height: 26px;
  padding: 0 4px;
  background: transparent;
  border-radius: 2px;
  box-shadow: none;
}

.so-table :deep(.el-input__wrapper:hover),
.so-table :deep(.el-select__wrapper:hover) {
  background: #fff;
  box-shadow: 0 0 0 1px var(--industrial-grid-light) inset;
}

.so-table :deep(.el-input__wrapper.is-focus),
.so-table :deep(.el-input.is-focus .el-input__wrapper),
.so-table :deep(.el-select__wrapper.is-focused) {
  background: #fff;
  box-shadow: 0 0 0 1px var(--industrial-primary) inset;
}

.so-table :deep(.el-input.is-disabled .el-input__wrapper) {
  background: transparent;
  box-shadow: none;
}

.so-table :deep(.el-input__inner) {
  font-size: 12px;
}

.so-table :deep(.el-input__inner::placeholder) {
  color: #a9b4bb;
}

.so-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: transparent;
  color: var(--industrial-muted);
  cursor: pointer;
}

.so-del:hover {
  background: #f9efee;
  color: var(--industrial-urgent);
}

.so-del svg {
  display: block;
}

.so-empty {
  padding: 20px 10px !important;
  color: var(--industrial-muted);
  text-align: center;
}

.so-add-row td {
  padding: 0;
  border-bottom: 1px solid var(--industrial-grid);
}

.so-table tbody tr.so-add-row:hover td {
  background: transparent;
}

.so-add {
  height: 30px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--industrial-primary);
  font-size: 12px;
  cursor: pointer;
}

.so-add:hover {
  background: #eef4f7;
}

.so-add--suggest {
  color: var(--industrial-muted);
}

.so-add--suggest:hover {
  color: var(--industrial-primary);
}

.so-table tfoot td {
  height: 30px;
  border-top: 1px solid var(--industrial-grid);
  border-bottom: 0;
  background: #eef2f4;
}

.so-foot-label {
  padding-left: 10px !important;
  color: var(--industrial-muted);
}

.so-foot-num {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.so-foot-state {
  padding-right: 10px !important;
  font-size: 11.5px;
  text-align: right;
}

.so-foot-state--match {
  color: var(--industrial-normal);
}

.so-foot-state--under {
  color: var(--industrial-replenish);
}

.so-foot-state--over {
  color: var(--industrial-urgent);
}

.so-foot-state--empty {
  color: var(--industrial-muted);
}
</style>
