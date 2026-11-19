<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElInput, ElInputNumber, ElOption, ElSelect } from 'element-plus'
import { usePurchaseStore } from '@/stores/purchase'
import {
  assigneesForSku,
  factoriesForSku,
  fillTone,
  findFactoryById,
  findFactoryByName,
  planOrderQuantity,
  resolveVatBand,
  resolveVatRule,
} from '@/purchase'
import { formatQuantity } from '@/utils/inventory'

// 单个 SKU 的分订单编辑器：采购下单页按需安排拆单时使用，缸规则换算也在这里。
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
  // dialog：弹窗里自带指标条与合计行；panel：采购下单页把这两件收到面板自己的进度条 / 底部合计条，
  // 编辑器只负责表格，避免同一组数字在一屏里出现两次。
  variant: {
    type: String,
    default: 'dialog',
    validator: (value) => ['dialog', 'panel'].includes(value),
  },
  // 关掉「进面板即带一张建议单」：筛选导致的自动回落不能预填，否则会把整张清单连锁填满。
  autoSeed: {
    type: Boolean,
    default: true,
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
// 颜色口径与采购下单页同一份（src/purchase/fillTone.js）：不足八成黄、八成到超一缸内绿、超过一缸红。
const tonePerVat = computed(() =>
  props.modelValue.reduce(
    (max, entry) => Math.max(max, Number(entry?.kgPerVat) || 0),
    Number(kgPerVat.value) || 0,
  ),
)
const totalTone = computed(() => fillTone(total.value, planned.value, tonePerVat.value))
const totalHint = computed(() => {
  if (!props.modelValue.length) return '尚未录入分订单'
  if (Math.abs(difference.value) < 0.005) return '与需安排一致'
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
const suggestion = computed(() => planOrderQuantity(planned.value, vatRule.value, vatContext.value))
// 缸数按规则建议里选中的缸型换算（缸型阶梯会随需安排量挑小缸 / 中缸 / 大缸）。
const kgPerVat = computed(() => {
  const per = Number(suggestion.value.kgPerVat)
  return per > 0 ? per : null
})
const vatTotal = computed(() =>
  props.modelValue.reduce((sum, entry) => sum + (Number(entry.vatCount) || 0), 0),
)

// 正好整缸时返回缸数，否则返回 null（公斤允许不是整缸）。
function nearestWholeVats(quantity, perVat) {
  if (!(perVat > 0) || !(quantity > 0)) return null
  const ratio = quantity / perVat
  const nearest = Math.round(ratio)
  return nearest > 0 && Math.abs(ratio - nearest) < 0.005 ? nearest : null
}

// 行内提示：整缸写「＝ 2 缸 × 240 公斤」，非整缸给出相邻两档整缸，让人决定改缸数还是改公斤。
function quantityHint(entry) {
  const quantity = Number(entry?.quantity) || 0
  const perVat = Number(entry?.kgPerVat) || kgPerVat.value
  if (!(quantity > 0) || !(perVat > 0)) return null
  const whole = nearestWholeVats(quantity, perVat)
  if (whole) return { tone: 'ok', text: `＝ ${formatQuantity(whole)} 缸 × ${formatQuantity(perVat)} 公斤` }
  const ratio = quantity / perVat
  const lower = Math.floor(ratio)
  const upper = lower + 1
  return {
    tone: 'warn',
    text: `非整缸：${formatQuantity(lower)} 缸 = ${formatQuantity(lower * perVat)} ／ ${formatQuantity(upper)} 缸 = ${formatQuantity(upper * perVat)} 公斤`,
  }
}

const rowHints = computed(() => props.modelValue.map((entry) => quantityHint(entry)))
const nonWholeCount = computed(() => rowHints.value.filter((hint) => hint?.tone === 'warn').length)

// 缸数只认人填的整数；公斤不是整缸时留空（不反推小数），由行内提示说明差多少。
function vatCountOf(entry) {
  const stored = Number(entry?.vatCount)
  return Number.isFinite(stored) && stored > 0 ? stored : null
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

// 新增的分订单一进来就带默认值：公斤与缸数按缸规则对「还差多少需安排」换算
// （如还差 433 公斤 → 2 缸 × 240 = 480 公斤），染厂 / 分单人员沿用上一张，
// 没有上一张就取下拉第一项，点一下就是一张看得见、能直接提交的单。
function addEntry() {
  const previous = props.modelValue[props.modelValue.length - 1]
  const factory = previous
    ? { factoryId: previous.factoryId ?? '', factoryName: previous.factoryName ?? '' }
    : {
        factoryId: factoryOptions.value[0]?.id ?? '',
        factoryName: factoryOptions.value[0]?.name ?? '',
      }
  const remaining = planned.value - total.value
  const result = remaining > 0.005 ? planOrderQuantity(remaining, vatRule.value, vatContext.value) : null
  updateEntries([
    ...props.modelValue,
    {
      id: `so-${Date.now().toString(36)}-${props.modelValue.length + 1}`,
      ...factory,
      assignee: previous?.assignee || assigneeOptions.value[0] || '',
      quantity: result?.rounded ?? 0,
      vatCount: result?.vatCount ?? null,
      kgPerVat: result?.kgPerVat ?? kgPerVat.value,
      note: '',
    },
  ])
}

// 「添加分订单」按钮右侧的预告删了：面板里已有一整条进度与「下单数量」。

// 面板一打开就等于替人点过了「添加分订单」：该 SKU 还没有分订单时，先按缸规则带出一张建议单，
// 所以进到 /purchase 的任意 SKU（或打开下单弹窗）就能直接核对 / 改缸数 / 确认下单。
// 同一个 SKU 只自动带一次，删掉之后不再自己长回来。
const seededSkus = new Set()
// 用户亲手把分订单清空的 SKU：删到空 / 点「清空分订单」后若立刻按规则再带一张建议单，
// 「删除」看起来就像没生效（删一次又长回一张新单，得删两轮才真的空）。放模块级，
// 弹窗关了再开、切走再回来都记得；重新有分订单后自动解除（见下面监听行数变化的 watch）。
const deletedSkus = new Set()
function seedSuggestedEntry() {
  if (!props.autoSeed) return
  const key = skuId.value
  if (!key || props.modelValue.length > 0 || seededSkus.has(key)) return
  if (deletedSkus.has(key)) return
  if (!(suggestion.value.rounded > 0)) return
  seededSkus.add(key)
  addEntry()
}

// 首次挂载后再带（不在父组件的渲染过程中写 store / 草稿），切 SKU 时由下面这个 watch 接手。
onMounted(seedSuggestedEntry)
watch(
  () => [skuId.value, props.modelValue.length, planned.value],
  () => seedSuggestedEntry(),
  { flush: 'post' },
)

// 改缸数：公斤数跟着 ＝ 缸数 × 缸型（硬换算）；改公斤数：只有正好整缸才回填缸数，否则留空只提示。
function handleVatCountChange(index, value) {
  const vatCount = Math.max(0, Math.round(Number(value) || 0))
  const perVat = kgPerVat.value
  patchEntry(index, {
    vatCount: vatCount > 0 ? vatCount : null,
    quantity: perVat ? Math.round(vatCount * perVat * 100) / 100 : Number(props.modelValue[index]?.quantity) || 0,
    kgPerVat: perVat,
  })
}

function handleQuantityChange(index, value) {
  // 公斤最多两位小数：整数就显示整数（480，不是 480.00），手输的小数也不会留一串尾数。
  const quantity = Math.round(Math.max(0, Number(value) || 0) * 100) / 100
  const perVat = kgPerVat.value
  patchEntry(index, {
    quantity,
    vatCount: nearestWholeVats(quantity, perVat),
    kgPerVat: perVat,
  })
}

function removeEntry(index) {
  updateEntries(props.modelValue.filter((_, entryIndex) => entryIndex !== index))
}

// 「删除分订单」不弹窗，跟采购下单页列表里的「撤销」同一套手感：
// 第一次点变成「确认删除」，再点一次才真删；点别处或行数变了就取消待确认。
const deletingIndex = ref(null)

function requestDelete(index, event) {
  event?.stopPropagation()
  if (deletingIndex.value === index) {
    deletingIndex.value = null
    removeEntry(index)
    return
  }
  deletingIndex.value = index
}

function handleDocumentClick(event) {
  if (deletingIndex.value === null) return
  if (event.target?.closest?.('.so-del')) return
  deletingIndex.value = null
}

onMounted(() => document.addEventListener('click', handleDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', handleDocumentClick))
// 分订单从「有」变成「一张不剩」= 人删光或点了清空：记下这个 SKU，别再自动补建议单，
// 否则删完立刻又长回一张新单，看起来像删不掉（得删两轮才真的空）。
let lastSkuId = skuId.value
let lastEntryCount = props.modelValue.length
watch(
  () => [skuId.value, props.modelValue.length],
  ([key, count]) => {
    deletingIndex.value = null
    if (key === lastSkuId && count === 0 && lastEntryCount > 0) deletedSkus.add(key)
    // 又有分订单了（手动添加 / 批量填单 / 重新下单）就忘掉「删光过」，以后还能按建议带单。
    else if (count > 0 && key) deletedSkus.delete(key)
    lastSkuId = key
    lastEntryCount = count
  },
)

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
  if (action === 'ladder') {
    const sizes = vatBand.value?.band?.sizes ?? []
    if (!sizes.length) return `${rule.name} · 缸型未配置`
    return `${rule.name} · 缸型 ${sizes.map((size) => formatQuantity(size)).join(' / ')} 公斤，就近取整`
  }
  return `${rule.name} · 每缸 ${formatQuantity(per)} 公斤`
})

const ruleTitle = computed(() => {
  const rule = vatRule.value
  if (!rule) return '该品名未绑定缸规则，可在「配置板块 → 缸规则」绑定'
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
  <div class="so-editor" :class="`so-editor--${variant}`">
    <div v-if="variant !== 'panel'" class="so-bar">
      <span class="so-bar__item">需安排 <b>{{ formatQuantity(planned) }}</b> 公斤</span>
      <span class="so-bar__item">已下单 <b>{{ formatQuantity(total) }}</b> 公斤</span>
      <span v-if="kgPerVat" class="so-bar__item">合计 <b>{{ formatQuantity(vatTotal) }}</b> 缸</span>
      <span v-if="nonWholeCount > 0" class="so-bar__warn">{{ nonWholeCount }} 张非整缸</span>
      <span class="so-bar__state" :class="`so-bar__state--${totalTone}`">{{ totalHint }}</span>
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
          <col style="width: 66px" />
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
                :controls="false"
                size="small"
                class="so-cell so-cell--num"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单数量`"
                @update:model-value="handleQuantityChange(index, $event)"
              />
              <span
                v-if="rowHints[index]"
                class="so-hint"
                :class="`so-hint--${rowHints[index].tone}`"
              >
                {{ rowHints[index].text }}
              </span>
            </td>
            <td>
              <ElInput
                :model-value="entry.note"
                size="small"
                placeholder="输入备注"
                class="so-cell"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单备注`"
                @update:model-value="patchEntry(index, { note: $event })"
              />
            </td>
            <td class="so-op">
              <button
                type="button"
                class="so-del"
                :class="{ 'is-confirming': deletingIndex === index }"
                :aria-label="
                  deletingIndex === index
                    ? `确认删除第 ${index + 1} 个分订单`
                    : `删除第 ${index + 1} 个分订单`
                "
                :title="
                  deletingIndex === index
                    ? '再点一次就删掉这张分订单'
                    : '删掉这张分订单（需再点一次确认）'
                "
                @click="requestDelete(index, $event)"
              >
                {{ deletingIndex === index ? '确认删除' : '删除' }}
              </button>
            </td>
          </tr>

          <tr v-if="modelValue.length === 0">
            <td colspan="7" class="so-empty">
              还没有分订单。点下面「添加分订单」会按缸规则带出一张建议单，再按染厂拆。
            </td>
          </tr>

          <tr class="so-add-row">
            <td colspan="7">
              <button type="button" class="so-add" @click="addEntry">＋ 添加分订单</button>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="variant !== 'panel' && modelValue.length">
          <tr>
            <td colspan="3" class="so-foot-label">合计</td>
            <td class="so-r so-foot-num">{{ formatQuantity(vatTotal) }}</td>
            <td class="so-r so-foot-num">{{ formatQuantity(total) }}</td>
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

.so-bar__state {
  font-size: 11.5px;
}

.so-bar__state--ok {
  color: var(--industrial-normal);
}

.so-bar__state--low {
  color: var(--industrial-replenish);
}

.so-bar__state--err {
  color: var(--industrial-urgent);
}

.so-bar__state--idle {
  color: var(--industrial-muted);
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

/* 数量下方的整缸提示：整缸绿、非整缸黄，不占额外列宽 */
.so-hint {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
  white-space: normal;
}

.so-hint--ok {
  color: var(--industrial-normal);
}

.so-hint--warn {
  color: var(--industrial-replenish);
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

.so-del:hover {
  background: #f7e9e7;
  color: var(--industrial-danger);
}

/* 待确认态：红框红字，跟采购下单页列表里的「确认撤销」一致 */
.so-del.is-confirming {
  border-color: var(--industrial-danger);
  background: #f7e9e7;
  color: var(--industrial-danger);
  font-weight: 600;
}

/* 删除列：平时两个字，确认态四个字，列宽按确认态留 */
.so-table td.so-op {
  padding: 0 2px;
  text-align: right;
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

.so-foot-state--ok {
  color: var(--industrial-normal);
}

.so-foot-state--low {
  color: var(--industrial-replenish);
}

.so-foot-state--err {
  color: var(--industrial-urgent);
}

.so-foot-state--idle {
  color: var(--industrial-muted);
}
</style>
