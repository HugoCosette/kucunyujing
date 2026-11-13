<script setup>
// 缸规则面板：规则列表（区间与动作）+ 编辑弹窗 + SPU 绑定。
// 组件只改传进来的草稿对象，保存 / 放弃由「下单设置」页统一负责。
import { computed, ref, watch } from 'vue'
import {
  ElButton,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTag,
} from 'element-plus'
import {
  DEFAULT_VAT_SIZES,
  VAT_ACTIONS,
  VAT_BAND_KEYS,
  VAT_REMAINDER_POLICIES,
  VAT_RULE_NONE,
  createDefaultVatRules,
  describeVatBands,
  describeVatRemainder,
  normalizeVatRule,
  normalizeVatSizes,
  planOrderQuantity,
  summarizeVatRule,
  validateVatRule,
} from '@/purchase'

const props = defineProps({
  // { vatRules, defaultVatRuleId, spuVatRules }
  modelValue: {
    type: Object,
    required: true,
  },
  // [{ product, skuCount, monthlyAvg }]
  spus: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['update:modelValue'])

const rules = computed(() => props.modelValue?.vatRules ?? [])
const defaultRuleId = computed(() => props.modelValue?.defaultVatRuleId ?? '')
const spuRules = computed(() => props.modelValue?.spuVatRules ?? {})
const boundSpuCount = computed(() => Object.keys(spuRules.value).length)
const ruleOptions = computed(() => rules.value.map((rule) => ({ id: rule.id, name: rule.name })))
const defaultRuleName = computed(
  () => rules.value.find((rule) => rule.id === defaultRuleId.value)?.name ?? '未设置',
)

const usageCounts = computed(() => {
  const counts = {}
  for (const ruleId of Object.values(spuRules.value)) {
    counts[ruleId] = (counts[ruleId] ?? 0) + 1
  }
  return counts
})

const ruleRows = computed(() =>
  rules.value.map((rule) => ({
    id: rule.id,
    name: rule.name,
    bandKeyLabel:
      VAT_BAND_KEYS.find((entry) => entry.value === rule.bandKey)?.label ?? '需安排（公斤）',
    bands: describeVatBands(rule),
    remainderText: describeVatRemainder(rule),
    summary: summarizeVatRule(rule),
    usage: usageCounts.value[rule.id] ?? 0,
    isDefault: rule.id === defaultRuleId.value,
  })),
)

function commit(patch) {
  emit('update:modelValue', {
    vatRules: patch.vatRules ?? rules.value,
    defaultVatRuleId: patch.defaultVatRuleId ?? defaultRuleId.value,
    spuVatRules: patch.spuVatRules ?? spuRules.value,
  })
}

function setDefaultRule(ruleId) {
  commit({ defaultVatRuleId: ruleId })
}

async function removeRule(ruleId) {
  const rule = rules.value.find((entry) => entry.id === ruleId)
  if (!rule) return
  try {
    await ElMessageBox.confirm(`删除规则「${rule.name}」？绑定它的 SPU 会回到默认规则。`, '删除缸规则', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  const nextRules = rules.value.filter((entry) => entry.id !== ruleId)
  const nextSpuRules = { ...spuRules.value }
  for (const [product, bound] of Object.entries(nextSpuRules)) {
    if (bound === ruleId) delete nextSpuRules[product]
  }
  commit({
    vatRules: nextRules.length ? nextRules : createDefaultVatRules(),
    spuVatRules: nextSpuRules,
    defaultVatRuleId: defaultRuleId.value === ruleId ? '' : defaultRuleId.value,
  })
}

async function restoreDefaults() {
  try {
    await ElMessageBox.confirm('恢复为「标准大货补单」「小批量补单」两条默认规则？当前规则会被替换。', '恢复默认缸规则', {
      type: 'warning',
      confirmButtonText: '恢复',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  const nextRules = createDefaultVatRules()
  commit({ vatRules: nextRules, defaultVatRuleId: nextRules[0].id, spuVatRules: {} })
  ElMessage.success('已恢复默认缸规则，点「确定」后生效')
}

// —— 编辑弹窗 ——
const dialogVisible = ref(false)
const editingId = ref('')
const draft = ref(normalizeVatRule({}))
const trialNeed = ref(100)
const trialMetric = ref(100)

const dialogTitle = computed(() => (editingId.value ? '编辑缸规则' : '新增缸规则'))
const currentUnit = computed(
  () => VAT_BAND_KEYS.find((entry) => entry.value === draft.value.bandKey)?.unit ?? '公斤',
)

function cloneRule(source) {
  return normalizeVatRule(JSON.parse(JSON.stringify(source)))
}

function openCreate() {
  editingId.value = ''
  draft.value = cloneRule({
    name: '',
    bands: [{ upTo: null, action: 'ladder', value: 0, sizes: [...DEFAULT_VAT_SIZES] }],
  })
  trialNeed.value = 100
  trialMetric.value = 100
  syncSizeTexts()
  dialogVisible.value = true
}

function openEdit(rule) {
  editingId.value = rule.id
  draft.value = cloneRule(rule)
  trialNeed.value = 100
  trialMetric.value = 100
  syncSizeTexts()
  dialogVisible.value = true
}

watch(dialogVisible, (visible) => {
  if (visible) return
  editingId.value = ''
})

function formatNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '--'
  return Number.isInteger(number) ? String(number) : number.toFixed(2)
}

function bandRangeText(index) {
  const bands = draft.value.bands
  const from = index > 0 ? Number(bands[index - 1].upTo) || 0 : 0
  const upTo = index === bands.length - 1 ? null : Number(bands[index].upTo)
  if (upTo === null) return `${formatNumber(from)} ${currentUnit.value}及以上`
  if (!(from > 0)) return `低于 ${formatNumber(upTo)} ${currentUnit.value}`
  return `${formatNumber(from)} 至不足 ${formatNumber(upTo)} ${currentUnit.value}`
}

// 「新增阈值」插在末档（无上限）之前，新档沿用末档的处理方式（含缸型组合），末档继续兜底。
function addBand() {
  const bands = draft.value.bands
  const last = bands[bands.length - 1]
  const previousUpTo = bands.length > 1 ? Number(bands[bands.length - 2].upTo) || 0 : 0
  const nextBand = {
    upTo: previousUpTo + 100,
    action: last?.action ?? 'ladder',
    value: last?.value ?? 0,
    sizes: [...(last?.sizes ?? DEFAULT_VAT_SIZES)],
  }
  if (last && last.upTo === null) {
    bands.splice(bands.length - 1, 0, nextBand)
  } else {
    bands.push(nextBand)
    bands.push({
      upTo: null,
      action: last?.action ?? 'ladder',
      value: last?.value ?? 0,
      sizes: [...(last?.sizes ?? DEFAULT_VAT_SIZES)],
    })
  }
  syncSizeTexts()
}

function removeBand(index) {
  const bands = draft.value.bands
  if (bands.length <= 1) return
  bands.splice(index, 1)
  if (bands[bands.length - 1].upTo !== null) bands[bands.length - 1].upTo = null
  syncSizeTexts()
}

function actionValueLabel(action) {
  return VAT_ACTIONS.find((entry) => entry.value === action)?.valueLabel ?? ''
}

// 缸型用「80，160，240」文本编辑：显示保留用户输入的原文，模型里回写成升序去重的数组。
const sizeTexts = ref([])

function syncSizeTexts() {
  sizeTexts.value = draft.value.bands.map((band) => (band.sizes ?? []).join('，'))
}

function handleSizesInput(index, text) {
  sizeTexts.value[index] = text
  const band = draft.value.bands[index]
  if (band) band.sizes = normalizeVatSizes(String(text ?? '').split(/[^0-9.]+/))
}

// 切到「缸型就近取整」但还没填缸型时，先给默认的 80 / 160 / 240，避免保存时报错。
function handleActionChange(index, action) {
  const band = draft.value.bands[index]
  if (!band) return
  band.action = action
  if (action === 'ladder' && !(band.sizes ?? []).length) {
    band.sizes = [...DEFAULT_VAT_SIZES]
    sizeTexts.value[index] = band.sizes.join('，')
  }
}

const hasLadderBand = computed(() => draft.value.bands.some((band) => band.action === 'ladder'))

const trialResult = computed(() => {
  const rule = normalizeVatRule(draft.value)
  const need = Number(trialNeed.value) || 0
  const metric = rule.bandKey === 'planned' ? need : Number(trialMetric.value) || 0
  return planOrderQuantity(need, rule, {
    planned: need,
    monthlyAvgCount: metric,
    spuMonthlyAvg: metric,
  })
})

const trialText = computed(() => {
  const result = trialResult.value
  if (!result) return ''
  if (!(Number(trialNeed.value) > 0)) return '填入需安排量后显示试算结果'
  const parts = []
  if (result.vatCount !== null) {
    parts.push(`${formatNumber(result.vatCount)} 缸`)
  }
  if (result.kgPerVat) parts.push(`每缸 ${formatNumber(result.kgPerVat)} 公斤`)
  parts.push(`下单 ${formatNumber(result.rounded)} 公斤`)
  if (Math.abs(result.deltaKg) >= 0.005) {
    const sign = result.deltaKg > 0 ? '+' : ''
    const rate = Number.isFinite(result.deltaRate) ? `（${sign}${Math.round(result.deltaRate * 100)}%）` : ''
    parts.push(`较需安排 ${sign}${formatNumber(result.deltaKg)} 公斤${rate}`)
  }
  return parts.join(' · ')
})

const trialTone = computed(() => {
  const result = trialResult.value
  if (!result || !(Number(trialNeed.value) > 0)) return ''
  if (result.action === 'skip') return 'warn'
  if (result.warnings.length) return 'warn'
  if (Math.abs(result.deltaKg) < 0.005) return 'ok'
  return ''
})

function saveRule() {
  const candidate = normalizeVatRule({ ...draft.value, id: editingId.value || undefined })
  const errors = validateVatRule({ ...draft.value, id: editingId.value || undefined })
  if (!candidate.name.trim()) {
    ElMessage.error('规则名称必须填写')
    return
  }
  if (
    rules.value.some(
      (rule) => rule.name === candidate.name && rule.id !== editingId.value,
    )
  ) {
    ElMessage.error(`规则名称「${candidate.name}」已存在`)
    return
  }
  if (errors.length) {
    ElMessage.error(errors[0].message)
    return
  }

  let nextRules
  if (editingId.value) {
    nextRules = rules.value.map((rule) => (rule.id === editingId.value ? { ...candidate, id: rule.id } : rule))
  } else {
    const used = new Set(rules.value.map((rule) => rule.id))
    let id = candidate.id && !used.has(candidate.id) ? candidate.id : `vr-${used.size + 1}`
    let suffix = 2
    while (used.has(id)) {
      id = `vr-${used.size + suffix}`
      suffix += 1
    }
    nextRules = [...rules.value, { ...candidate, id }]
  }

  const nextDefault = defaultRuleId.value || nextRules[0]?.id || ''
  const isEdit = Boolean(editingId.value)
  commit({ vatRules: nextRules, defaultVatRuleId: nextDefault })
  dialogVisible.value = false
  ElMessage.success(isEdit ? '规则已更新，点「确定」后生效' : '规则已新增，点「确定」后生效')
}

// —— SPU 绑定 ——
const spuKeyword = ref('')
const bulkRuleId = ref('')

const filteredSpus = computed(() => {
  const keyword = spuKeyword.value.trim().toLowerCase()
  const list = keyword
    ? props.spus.filter((entry) => entry.product.toLowerCase().includes(keyword))
    : props.spus
  return list.slice(0, 300)
})

const hiddenSpuCount = computed(() => Math.max(0, props.spus.length - filteredSpus.value.length))

function spuRuleValue(product) {
  return spuRules.value[product] ?? ''
}

function setSpuRule(product, value) {
  const next = { ...spuRules.value }
  const ruleId = String(value ?? '')
  if (ruleId) next[product] = ruleId
  else delete next[product]
  commit({ spuVatRules: next })
}

const bulkOptions = computed(() => [
  { value: '__unbind__', label: '解除绑定（回到默认规则）' },
  ...ruleOptions.value.map((rule) => ({ value: rule.id, label: rule.name })),
  { value: VAT_RULE_NONE, label: '不取整（按原样下单）' },
])

function applyBulk() {
  if (!bulkRuleId.value) {
    ElMessage.warning('先选择要套用的缸规则')
    return
  }
  const next = { ...spuRules.value }
  for (const entry of filteredSpus.value) {
    if (bulkRuleId.value === '__unbind__') delete next[entry.product]
    else next[entry.product] = bulkRuleId.value
  }
  commit({ spuVatRules: next })
  ElMessage.success(`已把规则套用到 ${filteredSpus.value.length} 个 SPU，点「确定」后生效`)
}

function clearBulk() {
  const next = { ...spuRules.value }
  for (const entry of filteredSpus.value) delete next[entry.product]
  commit({ spuVatRules: next })
  ElMessage.success(`已清空 ${filteredSpus.value.length} 个 SPU 的缸规则，点「确定」后生效`)
}
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">缸规则</h2>
      <div class="panel__head-actions">
        <button type="button" class="btn btn--text btn--sm" @click="restoreDefaults">
          恢复默认
        </button>
        <button type="button" class="btn btn--sm" @click="openCreate">新增规则</button>
      </div>
    </div>

    <div class="panel__body">
      <div class="vat-settings__default">
      <span>未单独绑定的品名使用</span>
      <ElSelect
        :model-value="defaultRuleId"
        size="small"
        class="vat-settings__default-select"
        aria-label="默认缸规则"
        @update:model-value="setDefaultRule"
      >
        <ElOption v-for="rule in ruleOptions" :key="rule.id" :label="rule.name" :value="rule.id" />
      </ElSelect>
      <span class="vat-settings__hint">共 {{ rules.length }} 条规则 · {{ spus.length }} 个品名</span>
    </div>

    <div class="vat-rule-table" role="table" aria-label="缸规则">
      <div class="vat-rule-row vat-rule-row--head" role="row">
        <span role="columnheader">规则名称</span>
        <span role="columnheader">区间与动作</span>
        <span role="columnheader">生效品名</span>
        <span role="columnheader">操作</span>
      </div>
      <div v-for="row in ruleRows" :key="row.id" class="vat-rule-row" role="row">
        <div class="vat-rule-name" role="cell">
          <strong>{{ row.name }}</strong>
          <span class="vat-rule-name__meta">
            {{ row.bandKeyLabel }}
            <ElTag v-if="row.isDefault" size="small" type="primary" effect="plain">默认</ElTag>
          </span>
        </div>
        <div class="vat-rule-bands" role="cell">
          <span v-for="band in row.bands" :key="band.index" class="vat-rule-bands__item">
            <em>{{ band.rangeText }}</em>
            <span>{{ band.actionText }}</span>
          </span>
          <span class="vat-rule-bands__remainder">{{ row.remainderText }}</span>
        </div>
        <span class="vat-rule-usage" role="cell">{{ row.usage }} 个品名</span>
        <span class="vat-rule-actions" role="cell">
          <ElButton size="small" text @click="openEdit(rules.find((rule) => rule.id === row.id))">
            编辑
          </ElButton>
          <ElButton size="small" text @click="setDefaultRule(row.id)">
            设为默认
          </ElButton>
          <ElButton size="small" text type="danger" @click="removeRule(row.id)">删除</ElButton>
        </span>
      </div>
      <p v-if="ruleRows.length === 0" class="vat-settings__empty">还没有缸规则</p>
    </div>

    <div class="vat-spu">
      <div class="vat-spu__head">
        <strong>品名绑定</strong>
        <span class="vat-settings__hint">
          {{ boundSpuCount }} 个品名单独绑定 · 其余走默认「{{ defaultRuleName }}」
        </span>
      </div>
      <div class="vat-spu__tools">
        <ElInput
          v-model="spuKeyword"
          size="small"
          clearable
          placeholder="搜索品名"
          class="vat-spu__search"
        />
        <ElSelect v-model="bulkRuleId" size="small" clearable placeholder="选择规则批量套用" class="vat-spu__bulk">
          <ElOption
            v-for="option in bulkOptions"
            :key="option.value || 'default'"
            :label="option.label"
            :value="option.value"
          />
        </ElSelect>
        <ElButton size="small" @click="applyBulk">批量套用</ElButton>
        <ElButton size="small" text @click="clearBulk">清空筛选结果</ElButton>
      </div>

      <div class="vat-spu-table" role="table" aria-label="品名缸规则绑定">
        <div class="vat-spu-row vat-spu-row--head" role="row">
          <span role="columnheader">品名</span>
          <span role="columnheader">SKU 数</span>
          <span role="columnheader">月均条数</span>
          <span role="columnheader">缸规则</span>
        </div>
        <div v-for="entry in filteredSpus" :key="entry.product" class="vat-spu-row" role="row">
          <span class="vat-spu-row__product" role="cell" :title="entry.product">{{ entry.product }}</span>
          <span role="cell">{{ entry.skuCount }}</span>
          <span role="cell">{{ formatNumber(entry.monthlyAvg) }}</span>
          <ElSelect
            :model-value="spuRuleValue(entry.product)"
            size="small"
            class="vat-spu-row__select"
            :placeholder="`默认（${defaultRuleName}）`"
            :aria-label="`${entry.product} 缸规则`"
            @update:model-value="setSpuRule(entry.product, $event)"
          >
            <ElOption :label="`默认（${defaultRuleName}）`" value="" />
            <ElOption v-for="rule in ruleOptions" :key="rule.id" :label="rule.name" :value="rule.id" />
            <ElOption label="不取整（按原样下单）" :value="VAT_RULE_NONE" />
          </ElSelect>
        </div>
        <p v-if="filteredSpus.length === 0" class="vat-settings__empty">
          {{ spus.length === 0 ? '还没导入总表，导入后这里会列出品名' : '没有匹配的品名' }}
        </p>
      </div>
      <p v-if="hiddenSpuCount > 0" class="vat-settings__hint">
        还有 {{ hiddenSpuCount }} 个品名未显示，输入关键词继续筛选
      </p>
    </div>
    </div>

    <ElDialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="760px"
      class="ui-dialog vat-rule-dialog"
      destroy-on-close
      align-center
    >
      <div class="vat-dialog-form">
        <label class="vat-dialog-field">
          <span>规则名称 *</span>
          <ElInput v-model="draft.name" size="small" placeholder="例如：标准大货补单" />
        </label>
        <label class="vat-dialog-field">
          <span>判定依据</span>
          <ElSelect v-model="draft.bandKey" size="small">
            <ElOption
              v-for="entry in VAT_BAND_KEYS"
              :key="entry.value"
              :label="entry.label"
              :value="entry.value"
            />
          </ElSelect>
        </label>
        <label class="vat-dialog-field">
          <span>零头处理</span>
          <ElSelect v-model="draft.remainder" size="small">
            <ElOption
              v-for="entry in VAT_REMAINDER_POLICIES"
              :key="entry.value"
              :label="entry.label"
              :value="entry.value"
            />
          </ElSelect>
        </label>
        <label v-if="draft.remainder === 'nearest'" class="vat-dialog-field">
          <span>补缸阈值</span>
          <ElInputNumber
            v-model="draft.remainderThreshold"
            size="small"
            :min="0.05"
            :max="1"
            :step="0.05"
            :precision="2"
            :controls="false"
          />
        </label>
        <label class="vat-dialog-field">
          <span>至少几缸</span>
          <ElInputNumber v-model="draft.minVats" size="small" :min="0" :max="99" :precision="0" :controls="false" />
        </label>
      </div>

      <div class="vat-dialog-bands" role="table" aria-label="区间与动作">
        <div class="vat-dialog-band vat-dialog-band--head" role="row">
          <span role="columnheader">区间</span>
          <span role="columnheader">上限（{{ currentUnit }}）</span>
          <span role="columnheader">处理方式</span>
          <span role="columnheader">参数</span>
          <span role="columnheader">操作</span>
        </div>
        <div v-for="(band, index) in draft.bands" :key="index" class="vat-dialog-band" role="row">
          <span class="vat-dialog-band__range" role="cell">
            <em>区间 {{ index + 1 }}</em>
            {{ bandRangeText(index) }}
          </span>
          <ElInputNumber
            v-if="index < draft.bands.length - 1"
            v-model="band.upTo"
            size="small"
            :min="1"
            :step="10"
            :controls="false"
          />
          <span v-else class="vat-dialog-band__unbounded">无上限</span>
          <ElSelect :model-value="band.action" size="small" @update:model-value="handleActionChange(index, $event)">
            <ElOption
              v-for="entry in VAT_ACTIONS"
              :key="entry.value"
              :label="entry.label"
              :value="entry.value"
            />
          </ElSelect>
          <ElInput
            v-if="band.action === 'ladder'"
            :model-value="sizeTexts[index]"
            size="small"
            placeholder="缸型，如 80，160，240"
            :aria-label="`区间 ${index + 1} 缸型（公斤）`"
            @update:model-value="handleSizesInput(index, $event)"
          />
          <ElInputNumber
            v-else-if="band.action !== 'skip'"
            v-model="band.value"
            size="small"
            :min="0"
            :step="10"
            :controls="false"
            :placeholder="actionValueLabel(band.action)"
          />
          <span v-else class="vat-dialog-band__unbounded">—</span>
          <ElButton
            size="small"
            text
            type="danger"
            :disabled="draft.bands.length <= 1"
            @click="removeBand(index)"
          >
            删除
          </ElButton>
        </div>
      </div>

      <div class="vat-dialog-actions">
        <ElButton size="small" @click="addBand">＋ 新增阈值</ElButton>
        <span class="vat-settings__hint">
          上限按从小到大自动串联，只填上限即可；最后一档固定无上限。
        </span>
      </div>
      <p v-if="hasLadderBand" class="vat-settings__hint">
        缸型就近取整：需求不到最大缸型时只下 1 缸最接近的缸型（正好一半取大缸）；超过最大缸型按它的整数倍取模，余量 ≥ 半个大缸再补 1 缸。一张分订单只用一种缸型。
      </p>

      <div class="vat-dialog-trial">
        <span class="vat-dialog-trial__label">试算</span>
        <ElInputNumber
          v-model="trialNeed"
          size="small"
          :min="0"
          :step="10"
          :controls="false"
          class="vat-dialog-trial__input"
          aria-label="试算需安排量"
        />
        <span class="vat-settings__hint">公斤</span>
        <template v-if="draft.bandKey !== 'planned'">
          <span class="vat-settings__hint">判据值</span>
          <ElInputNumber
            v-model="trialMetric"
            size="small"
            :min="0"
            :step="10"
            :controls="false"
            class="vat-dialog-trial__input"
            aria-label="试算判据值"
          />
        </template>
        <span class="vat-dialog-trial__result" :class="`vat-dialog-trial__result--${trialTone}`">
          {{ trialText }}
        </span>
      </div>
      <p v-if="trialResult.warnings.length" class="vat-dialog-trial__warn">
        {{ trialResult.warnings.join('；') }}
      </p>

      <template #footer>
        <div class="vat-dialog-footer">
          <ElButton @click="dialogVisible = false">取消</ElButton>
          <ElButton type="primary" @click="saveRule">保存规则</ElButton>
        </div>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.vat-settings__default {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  color: var(--industrial-text);
  font-size: 12px;
}

.vat-settings__default-select {
  width: 200px;
}

.vat-settings__hint {
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.vat-settings__empty {
  margin: 0;
  padding: 16px 10px;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.vat-rule-table,
.vat-spu-table {
  border: 1px solid var(--industrial-grid);
  overflow-x: auto;
}

.vat-spu-table {
  max-height: 320px;
  overflow-y: auto;
}

.vat-rule-row {
  display: grid;
  grid-template-columns: 170px minmax(220px, 2fr) 88px 168px;
  align-items: center;
  min-height: 36px;
  gap: 8px;
  padding: 4px 8px;
  border-top: 1px solid var(--line-soft);
  font-size: 12px;
}

.vat-rule-row:first-child,
.vat-spu-row:first-child {
  border-top: none;
}

.vat-rule-usage {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.vat-rule-row > :last-child {
  justify-self: end;
}

.vat-rule-row--head,
.vat-spu-row--head {
  min-height: 27px;
  color: #33424b;
  background: var(--industrial-header);
  font-size: 11.5px;
  font-weight: 600;
}

.vat-rule-row--head > :nth-child(3) {
  text-align: right;
}

.vat-rule-name {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.vat-rule-name__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--industrial-muted);
  font-size: 11px;
}

.vat-rule-bands {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 14px;
}

.vat-rule-bands__item {
  display: inline-flex;
  gap: 5px;
  color: var(--industrial-text);
  font-size: 12px;
  white-space: nowrap;
}

.vat-rule-bands__item em {
  color: var(--industrial-muted);
  font-style: normal;
}

.vat-rule-bands__remainder {
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
}

.vat-rule-actions {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0;
}

:deep(.vat-rule-actions .el-button) {
  height: 22px;
  padding: 0 4px;
  font-size: 11.5px;
}

.vat-spu {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.vat-spu__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  color: var(--industrial-text);
  font-size: 13px;
}

.vat-spu__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.vat-spu__search {
  width: min(240px, 100%);
}

.vat-spu__bulk {
  width: min(240px, 100%);
}

.vat-spu-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) 70px 90px minmax(200px, 1.2fr);
  align-items: center;
  min-height: 36px;
  gap: 8px;
  padding: 4px 8px;
  border-top: 1px solid var(--line-soft);
  font-size: 12px;
}

.vat-spu-row__product {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vat-spu-row__select {
  width: 100%;
}

.vat-dialog-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.vat-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.vat-dialog-bands {
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  overflow-x: auto;
}

.vat-dialog-band {
  display: grid;
  grid-template-columns: minmax(170px, 1fr) 100px 170px 130px 56px;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--industrial-grid-light);
  font-size: 13px;
}

.vat-dialog-band:first-child {
  border-top: none;
}

.vat-dialog-band--head {
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-size: 12px;
  font-weight: 600;
}

.vat-dialog-band__range {
  display: flex;
  flex-direction: column;
  color: var(--industrial-muted);
  font-size: 12px;
}

.vat-dialog-band__range em {
  color: var(--industrial-text);
  font-style: normal;
  font-weight: 600;
}

.vat-dialog-band__unbounded {
  color: var(--industrial-muted);
  font-size: 12px;
}

.vat-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.vat-dialog-trial {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 10px;
  background: var(--industrial-page);
  border: 1px dashed var(--industrial-grid);
  border-radius: 4px;
  font-size: 12px;
}

.vat-dialog-trial__label {
  color: var(--industrial-text);
  font-weight: 600;
}

.vat-dialog-trial__input {
  width: 110px;
}

.vat-dialog-trial__result {
  color: var(--industrial-text);
}

.vat-dialog-trial__result--ok {
  color: var(--industrial-normal);
}

.vat-dialog-trial__result--warn {
  color: var(--industrial-replenish);
}

.vat-dialog-trial__warn {
  margin: 6px 0 0;
  color: var(--industrial-urgent);
  font-size: 12px;
}

.vat-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:global(.el-dialog.vat-rule-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

:global(.el-dialog.vat-rule-dialog .el-dialog__body) {
  min-height: 0;
  overflow: auto;
}
</style>
