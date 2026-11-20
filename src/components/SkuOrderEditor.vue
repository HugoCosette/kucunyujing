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
  quantityModeOf,
  resolveVatBand,
  resolveVatRule,
  vatQuantityOptions,
} from '@/purchase'
import { formatQuantity } from '@/utils/inventory'

// 单个 SKU 的分订单编辑器：采购下单页按需安排拆单时使用，缸规则换算也在这里。
// 染厂来自「下单设置」里该 SKU 的可选染厂，允许临时手输（不回写设置）；
// 分单人员优先用该 SKU 树形分类里维护的人，分类没配人时回退到分单人员表全部人员。
// 每张分订单独立选择按缸或按公斤；按缸时公斤由缸数 × 缸型计算。
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
    (max, entry) =>
      quantityModeOf(entry) === 'vat' ? Math.max(max, Number(entry?.kgPerVat) || 0) : max,
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
// 缸型候选来自该 SKU 生效的缸规则（见 src/purchase/vat.js）；也允许手输自定义公斤数。
const quantityOptions = computed(() => vatQuantityOptions(vatRule.value))
// 缸规则当前判定选中的缸型，在下拉里挂一个「建议」标记。
function isSuggestedOption(option) {
  return Math.abs(option.kgPerVat - (Number(suggestion.value.kgPerVat) || 0)) < 0.005
}
const vatTotal = computed(() =>
  props.modelValue.reduce(
    (sum, entry) =>
      quantityModeOf(entry) === 'vat' ? sum + (Number(entry.vatCount) || 0) : sum,
    0,
  ),
)

function roundKg(value) {
  return Math.round(value * 100) / 100
}

// 切到按缸时尽量沿用当前公斤数；不能整除时取最近的整缸数。
function nearestWholeVats(quantity, perVat) {
  if (!(perVat > 0) || !(quantity > 0)) return null
  const ratio = quantity / perVat
  const nearest = Math.round(ratio)
  return nearest > 0 && Math.abs(ratio - nearest) < 0.005 ? nearest : null
}

// 按公斤的订单不计缸数；按缸的数量只由整数缸数和缸型生成。
function vatCountOf(entry) {
  if (quantityModeOf(entry) !== 'vat') return null
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

// 新增分订单沿用上一张的下单方式；按公斤预填剩余需安排量，按缸则沿用规则建议。
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
  const previousMode = previous ? quantityModeOf(previous) : null
  const perVat = Number(result?.kgPerVat) || Number(kgPerVat.value) || null
  const quantityMode =
    previousMode ?? (Number(result?.vatCount) > 0 && perVat ? 'vat' : 'kg')
  const useVat = quantityMode === 'vat' && Boolean(perVat)
  const kgQuantity = remaining > 0.005 ? roundKg(remaining) : 0
  updateEntries([
    ...props.modelValue,
    {
      id: `so-${Date.now().toString(36)}-${props.modelValue.length + 1}`,
      ...factory,
      assignee: previous?.assignee || assigneeOptions.value[0] || '',
      quantityMode: useVat ? 'vat' : 'kg',
      quantity: useVat ? result?.rounded ?? 0 : kgQuantity,
      vatCount: useVat ? result?.vatCount ?? null : null,
      kgPerVat: useVat ? perVat : null,
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

// 按缸模式：数量始终等于整数缸数 × 当前缸型。
function handleVatCountChange(index, value) {
  const entry = props.modelValue[index]
  if (quantityModeOf(entry) !== 'vat') return
  const vatCount = Math.max(0, Math.round(Number(value) || 0))
  const perVat = Number(entry?.kgPerVat) || kgPerVat.value
  if (!(perVat > 0)) return
  patchEntry(index, {
    vatCount: vatCount > 0 ? vatCount : null,
    quantity: roundKg(vatCount * perVat),
    kgPerVat: perVat,
  })
}

function handleVatTypeChange(index, value) {
  const entry = props.modelValue[index]
  const perVat = Number(value)
  if (quantityModeOf(entry) !== 'vat' || !(perVat > 0)) return
  const currentQuantity = Number(entry?.quantity) || 0
  const vatCount =
    vatCountOf(entry) ??
    (currentQuantity > 0
      ? nearestWholeVats(currentQuantity, perVat) ?? Math.max(1, Math.round(currentQuantity / perVat))
      : null)
  patchEntry(index, {
    kgPerVat: perVat,
    vatCount,
    quantity: vatCount ? roundKg(vatCount * perVat) : 0,
  })
}

function handleQuantityModeChange(index, value) {
  if (value !== 'vat' && value !== 'kg') return
  const entry = props.modelValue[index]
  const currentMode = quantityModeOf(entry)
  if (value === currentMode) return

  const quantity = roundKg(Math.max(0, Number(entry?.quantity) || 0))
  if (value === 'kg') {
    patchEntry(index, {
      quantityMode: 'kg',
      quantity: roundWholeKg(quantity),
      vatCount: null,
      kgPerVat: null,
    })
    highlightModeFields(index, 'kg')
    return
  }

  const perVat = Number(entry?.kgPerVat) || kgPerVat.value
  const vatCount = perVat
    ? nearestWholeVats(quantity, perVat) ??
      (quantity > 0 ? Math.max(1, Math.round(quantity / perVat)) : null)
    : null
  patchEntry(index, {
    quantityMode: 'vat',
    vatCount,
    kgPerVat: perVat || null,
    quantity: perVat && vatCount ? roundKg(perVat * vatCount) : quantity,
  })
  highlightModeFields(index, 'vat')
}

function handleQuantityChange(index, value) {
  if (quantityModeOf(props.modelValue[index]) !== 'kg') return
  patchEntry(index, {
    quantity: Math.max(0, Math.round(Number(value) || 0)),
  })
}

function roundWholeKg(value) {
  return Math.max(0, Math.round(Number(value) || 0))
}

const modeHighlight = ref(null)
let modeHighlightTimer = 0

function highlightModeFields(index, mode) {
  modeHighlight.value = { index, mode }
  if (modeHighlightTimer) clearTimeout(modeHighlightTimer)
  modeHighlightTimer = window.setTimeout(() => {
    modeHighlight.value = null
    modeHighlightTimer = 0
  }, 1200)
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
onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  if (modeHighlightTimer) clearTimeout(modeHighlightTimer)
})
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
      <span class="so-bar__state" :class="`so-bar__state--${totalTone}`">{{ totalHint }}</span>
      <span class="so-bar__rule" :title="ruleTitle">{{ ruleShort }}</span>
    </div>

    <div class="so-table-wrap">
      <table class="so-table">
        <colgroup>
          <col style="width: 40px" />
          <col style="width: 150px" />
          <col style="width: 130px" />
          <col style="width: 104px" />
          <col style="width: 80px" />
          <col style="width: 130px" />
          <col style="width: 140px" />
          <col style="width: 160px" />
          <col style="width: 72px" />
        </colgroup>
        <thead>
          <tr>
            <th>#</th>
            <th>染厂</th>
            <th>分单人员</th>
            <th>下单方式</th>
            <th>缸数</th>
            <th>缸型（公斤）</th>
            <th>下单量（公斤）</th>
            <th>备注</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, index) in modelValue" :key="entry.id || index">
            <td>{{ index + 1 }}</td>
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
              <ElSelect
                class="so-cell"
                :model-value="quantityModeOf(entry)"
                size="small"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单下单方式`"
                title="按缸时下单量由缸数 × 缸型计算；按公斤时直接输入。按公斤切到按缸会折算为最近的整数缸数"
                @update:model-value="handleQuantityModeChange(index, $event)"
              >
                <ElOption label="按缸" value="vat" />
                <ElOption label="按公斤" value="kg" />
              </ElSelect>
            </td>
            <td
              :class="{
                'is-mode-highlight':
                  modeHighlight?.index === index && modeHighlight.mode === 'vat',
              }"
            >
              <ElInputNumber
                v-if="quantityModeOf(entry) === 'vat'"
                :model-value="vatCountOf(entry)"
                :min="0"
                :step="1"
                :controls="false"
                :disabled="!Number(entry.kgPerVat)"
                size="small"
                class="so-cell so-cell--num so-cell--vat-count"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单缸数`"
                @update:model-value="handleVatCountChange(index, $event)"
              />
              <span v-else class="so-static">—</span>
            </td>
            <td
              :class="{
                'is-mode-highlight':
                  modeHighlight?.index === index && modeHighlight.mode === 'vat',
              }"
            >
              <ElSelect
                v-if="quantityModeOf(entry) === 'vat'"
                class="so-cell so-cell--num"
                :model-value="Number(entry.kgPerVat) || undefined"
                size="small"
                filterable
                allow-create
                default-first-option
                :placeholder="quantityOptions.length ? '选择缸型' : '输入缸型'"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单缸型（公斤）`"
                @update:model-value="handleVatTypeChange(index, $event)"
              >
                <ElOption
                  v-for="option in quantityOptions"
                  :key="option.kgPerVat"
                  :label="formatQuantity(option.kgPerVat)"
                  :value="option.kgPerVat"
                >
                  <span class="so-opt__kg">{{ formatQuantity(option.kgPerVat) }} 公斤/缸</span>
                  <span v-if="isSuggestedOption(option)" class="so-opt__tag">建议</span>
                </ElOption>
              </ElSelect>
              <span v-else class="so-static">—</span>
            </td>
            <td
              :class="{
                'is-mode-highlight':
                  modeHighlight?.index === index && modeHighlight.mode === 'kg',
              }"
            >
              <span v-if="quantityModeOf(entry) === 'vat'" class="so-static">
                {{ formatQuantity(entry.quantity) }}
              </span>
              <ElInputNumber
                v-else
                :model-value="roundWholeKg(entry.quantity)"
                :min="0"
                :step="1"
                :precision="0"
                :controls="false"
                size="small"
                class="so-cell so-cell--num"
                placeholder="输入公斤数"
                :aria-label="`${item.product} ${item.color} 第 ${index + 1} 个分订单下单量（公斤）`"
                @update:model-value="handleQuantityChange(index, $event)"
              />
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
            <td colspan="9" class="so-empty">
              还没有分订单。点下面「添加分订单」会按缸规则带出一张建议单，再按染厂拆。
            </td>
          </tr>

          <tr class="so-add-row">
            <td colspan="9">
              <button type="button" class="so-add" @click="addEntry">＋ 添加分订单</button>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="variant !== 'panel' && modelValue.length">
          <tr>
            <td colspan="4" class="so-foot-label">合计</td>
            <td class="so-foot-num">{{ formatQuantity(vatTotal) }}</td>
            <td />
            <td class="so-foot-num">{{ formatQuantity(total) }}</td>
            <td colspan="2" class="so-foot-state" :class="`so-foot-state--${totalTone}`">
              {{ totalHint }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div v-if="variant === 'panel'" class="so-mode-guide" aria-label="下单方式说明">
      <div class="so-mode-guide__title">下单方式</div>
      <p>按缸：填写缸数、选择缸型，下单量自动计算</p>
      <p>按公斤：直接填写下单量（公斤）</p>
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

.so-editor--panel {
  min-height: 100%;
}

.so-mode-guide {
  display: flex;
  flex: 1 0 180px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 180px;
  padding: 18px 12px;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
}

.so-mode-guide__title {
  margin-bottom: 2px;
  color: #64737c;
  font-size: 12px;
  font-weight: 600;
}

.so-mode-guide p {
  margin: 0;
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
  min-width: 1006px;
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
  text-align: left;
}

.so-table tbody tr:hover td {
  background: #f8fafb;
}

.so-table td.is-mode-highlight {
  background: #fff9ed;
  animation: so-mode-cell-flash 1.2s ease-out;
}

.so-table td.is-mode-highlight :deep(.el-input__wrapper),
.so-table td.is-mode-highlight :deep(.el-select__wrapper) {
  animation: so-mode-control-flash 1.2s ease-out;
}

@keyframes so-mode-cell-flash {
  0%,
  100% {
    background: transparent;
  }
  18%,
  48% {
    background: #fff2d6;
  }
  32%,
  68% {
    background: #fff9ed;
  }
}

@keyframes so-mode-control-flash {
  0%,
  100% {
    box-shadow: none;
  }
  18%,
  48% {
    box-shadow: 0 0 0 2px #d7c18b inset, 0 0 5px rgb(190 164 105 / 28%);
  }
  32%,
  68% {
    box-shadow: 0 0 0 1px #e5d8b8 inset, 0 0 2px rgb(190 164 105 / 16%);
  }
}

.so-table tbody tr:last-child td {
  border-bottom: 0;
}

.so-idx {
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.so-cell {
  width: 100%;
}

.so-static {
  display: block;
  min-height: 26px;
  padding: 5px 4px 0;
  color: var(--industrial-text);
  font-variant-numeric: tabular-nums;
  text-align: left;
}

.so-cell--num :deep(.el-input__inner) {
  text-align: left;
  font-variant-numeric: tabular-nums;
}

.so-cell--vat-count :deep(.el-input__inner) {
  text-align: left;
}

/* 缸型下拉里的数字也左对齐，表格列统一阅读方向。 */
.so-cell--num :deep(.el-select__selection) {
  justify-content: flex-start;
  font-variant-numeric: tabular-nums;
}

.so-opt__kg {
  font-variant-numeric: tabular-nums;
}

.so-opt__tag {
  margin-left: 8px;
  padding: 0 4px;
  border: 1px solid #b9d4c6;
  border-radius: 2px;
  background: #eef6f1;
  color: var(--industrial-normal);
  font-size: 10.5px;
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
  text-align: left;
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
