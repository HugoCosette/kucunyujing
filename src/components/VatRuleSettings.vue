<script setup>
// 缸规则面板：规则列表（区间与动作）+ 编辑弹窗 + SPU 绑定。
// 组件只改传进来的草稿对象，保存 / 放弃由「下单设置」页统一负责。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElButton, ElDialog, ElInput, ElInputNumber, ElMessage, ElMessageBox } from 'element-plus'
import {
  DEFAULT_VAT_SIZES,
  VAT_BAND_KEYS,
  VAT_RULE_NONE,
  createDefaultVatRules,
  describeVatBands,
  normalizeVatRule,
  normalizeVatSizes,
  planOrderQuantity,
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
const spuKeyword = ref('')

const defaultRuleName = computed(
  () => rules.value.find((rule) => rule.id === defaultRuleId.value)?.name ?? '未设置',
)

// 只认「显式绑定」：没点过的品名不落库，空串表示跟着默认规则走。
function boundRuleOf(product) {
  return spuRules.value[product] ?? ''
}

function ruleNameBy(ruleId) {
  if (!ruleId) return `默认（${defaultRuleName.value}）`
  if (ruleId === VAT_RULE_NONE) return '不取整'
  return rules.value.find((rule) => rule.id === ruleId)?.name ?? '未设置'
}

function ruleLabelOf(product) {
  const id = boundRuleOf(product)
  if (!id) return '默认'
  return id === VAT_RULE_NONE ? '不取整' : (rules.value.find((rule) => rule.id === id)?.name ?? '未知规则')
}

// 规则卡上的一段：「区间 → 补到多少」。缸型阶梯会按相邻中点摊成多段，区间天然连续。
function compactBands(rule) {
  const rows = describeVatBands(rule)
  return rows.map((row, index) => {
    const from = index === 0 ? 0 : (Number(rows[index - 1].upTo) || 0) + 1
    const hasUpper = row.upTo !== null && row.upTo !== undefined
    return {
      index: row.index,
      range: hasUpper ? `${formatNumber(from)}–${formatNumber(row.upTo)}` : `${formatNumber(from)} 以上`,
      target: compactTarget(row),
      skip: row.action === 'skip',
    }
  })
}

function compactTarget(row) {
  if (row.action === 'skip') return '不下单'
  if (row.action === 'round') return `按 ${formatNumber(row.value)} 取整`
  const value = Number(row.value) || 0
  return value > 0 ? `${formatNumber(value)} kg` : '未配置'
}

const ruleRows = computed(() =>
  rules.value.map((rule) => ({
    id: rule.id,
    name: rule.name,
    bands: compactBands(rule),
    isDefault: rule.id === defaultRuleId.value,
  })),
)

// 计数按「显式绑定」算：没绑定的都落在「默认」这一桶，改默认规则不会搬动任何品名。
const ruleCounts = computed(() => {
  const counts = {}
  for (const entry of props.spus) {
    const id = boundRuleOf(entry.product)
    counts[id] = (counts[id] ?? 0) + 1
  }
  return counts
})

const ruleCountOptions = computed(() => [
  { id: '', name: '默认', count: ruleCounts.value[''] ?? 0 },
  ...rules.value.map((rule) => ({
    id: rule.id,
    name: rule.name,
    count: ruleCounts.value[rule.id] ?? 0,
  })),
  { id: VAT_RULE_NONE, name: '不取整', count: ruleCounts.value[VAT_RULE_NONE] ?? 0 },
])

// 下面这排单选只决定「看哪一桶」，跟上面的「设为默认」没有联动。
const activePick = ref('')
const activeRuleId = computed(() =>
  ruleCountOptions.value.some((entry) => entry.id === activePick.value) ? activePick.value : '',
)

const keywordActive = computed(() => Boolean(spuKeyword.value.trim()))

// 不搜索时列当前这一桶的品名；搜索时跨规则找，顺便在格子里标出它现在归哪一桶。
const visibleSpus = computed(() => {
  const keyword = spuKeyword.value.trim()
  if (keyword) return props.spus.filter((entry) => entry.product.includes(keyword))
  const active = activeRuleId.value
  return props.spus.filter((entry) => boundRuleOf(entry.product) === active)
})

function setActiveRule(ruleId) {
  activePick.value = String(ruleId ?? '')
}

// 点品名弹出的规则浮层（一次可应用到多个品名）
const ruleMenu = ref({ open: false, x: 0, y: 0, products: [], current: '' })

const ruleMenuOptions = computed(() => [
  { id: '', name: '默认', note: defaultRuleName.value },
  ...rules.value.map((rule) => ({
    id: rule.id,
    name: rule.name,
    note: '',
  })),
  { id: VAT_RULE_NONE, name: '不取整', note: '' },
])

function openRuleMenu(event, products) {
  const list = (Array.isArray(products) ? products : [products]).filter(Boolean)
  if (!list.length) return
  event?.stopPropagation?.()
  const rect = event?.currentTarget?.getBoundingClientRect?.() ?? { left: 24, bottom: 120 }
  ruleMenu.value = {
    open: true,
    x: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 232)),
    y: Math.min(rect.bottom + 2, Math.max(8, window.innerHeight - 168)),
    products: list,
    current: list.length === 1 ? boundRuleOf(list[0]) : '__mixed__',
  }
}

function closeRuleMenu() {
  ruleMenu.value = { ...ruleMenu.value, open: false }
}

function applyRuleToSelection(ruleId) {
  const targets = ruleMenu.value.products
  if (!targets.length) return
  const next = { ...spuRules.value }
  for (const product of targets) {
    if (!ruleId) delete next[product]
    else next[product] = ruleId
  }
  closeRuleMenu()
  commit({ spuVatRules: next })
  ElMessage.success(`已把 ${targets.length} 个品名设为「${ruleNameBy(ruleId)}」，点「确定」后生效`)
}

// 点浮层外面关掉；点浮层内部不关。
function onDocumentClick(event) {
  if (!ruleMenu.value.open) return
  if (event.target instanceof Element && event.target.closest('.vat-rule-menu')) return
  closeRuleMenu()
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))

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

const dialogTitle = computed(() => (editingId.value ? '编辑缸规则' : '新增缸规则'))
const currentUnit = computed(
  () => VAT_BAND_KEYS.find((entry) => entry.value === draft.value.bandKey)?.unit ?? '公斤',
)

function cloneRule(source) {
  return normalizeVatRule(JSON.parse(JSON.stringify(source)))
}

function openCreate() {
  editingId.value = ''
  draft.value = prepareDraft({
    name: '',
    bands: [{ upTo: null, action: 'ladder', value: 0, sizes: [...DEFAULT_VAT_SIZES] }],
  })
  trialNeed.value = 100
  dialogVisible.value = true
}

function openEdit(rule) {
  editingId.value = rule.id
  draft.value = prepareDraft(rule)
  trialNeed.value = 100
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

// 一行只有一个含义：这一段（到下一行之前）补到多少公斤。补到 0 就是这段不补。
function bandTarget(band) {
  if (!band) return 0
  return Number(band.action === 'ladder' ? band.sizes?.[0] : band.value) || 0
}

function setBandTarget(index, value) {
  const band = draft.value.bands[index]
  if (!band) return
  const target = Math.max(0, Number(value) || 0)
  band.value = target
  band.sizes = target > 0 ? [target] : []
  band.action = target > 0 ? 'fixed' : 'skip'
  applyBandChain()
}

// 只有末行是开口的：末行存成单缸型阶梯（超过它按它一缸一缸往上补），其余行都是固定量。
function applyBandChain(bands = draft.value.bands) {
  bands.forEach((band, index) => {
    if (index === bands.length - 1) {
      band.upTo = null
      if (band.action === 'fixed') {
        const target = Number(band.value) || 0
        band.action = 'ladder'
        band.sizes = target > 0 ? [target] : []
      }
      if (band.action === 'ladder') band.value = Number(band.sizes?.[0]) || 0
      return
    }
    if (band.action === 'ladder') {
      band.action = 'fixed'
      band.value = Number(band.sizes?.[0]) || band.value || 0
      band.sizes = []
    }
  })
}

// 两端都算：上一行到 120，下一行就从 121 起；改任一边另一边自动跟着走，串起来不留缝。
function bandFrom(index) {
  return index > 0 ? (Number(draft.value.bands[index - 1].upTo) || 0) + 1 : 0
}

function setBandFrom(index, value) {
  if (index <= 0) return
  const previous = draft.value.bands[index - 1]
  if (!previous) return
  previous.upTo = Math.max(0, (Number(value) || 1) - 1)
}

function bandUpper(index) {
  const band = draft.value.bands[index]
  return Number(band?.upTo) > 0 ? Number(band.upTo) : 0
}

function setBandUpper(index, value) {
  const band = draft.value.bands[index]
  if (!band || index >= draft.value.bands.length - 1) return
  band.upTo = Math.max(1, Number(value) || 0)
}

// 区间必须连着：上限不小于下限（两端都算），断了就地标红，保存时也拦下。
const bandErrors = computed(() =>
  draft.value.bands.map((band, index) => {
    const isLast = index === draft.value.bands.length - 1
    if (isLast) return ''
    const from = bandFrom(index)
    return Number(band.upTo) >= from ? '' : `上限要 ≥ ${formatNumber(from)}`
  }),
)

const bandErrorCount = computed(() => bandErrors.value.filter(Boolean).length)

// 在某一段后面插一段：中间段从中间一分为二（原段留前半，新段接后半并沿用原段的补到量），
// 开口的末段则先切出一个步长给原段、新段继续敞开。插在哪都只动这一段，后面的段不用重调。
function insertBandAfter(index) {
  const bands = draft.value.bands
  const band = bands[index]
  if (!band) return
  const from = bandFrom(index)
  const target = bandTarget(band)
  let nextUpTo = null
  if (index === bands.length - 1) {
    const previousFrom = index > 0 ? bandFrom(index - 1) : 0
    const span = from - previousFrom
    const step = span > 0 ? span : from > 0 ? from : 100
    band.upTo = from + step - 1
  } else {
    nextUpTo = Number(band.upTo) || 0
    band.upTo = Math.max(from, Math.floor((from + nextUpTo) / 2))
  }
  bands.splice(index + 1, 0, {
    upTo: nextUpTo,
    action: target > 0 ? 'fixed' : 'skip',
    value: target,
    sizes: [],
  })
  applyBandChain()
}

function addBand() {
  insertBandAfter(draft.value.bands.length - 1)
}

function removeBand(index) {
  const bands = draft.value.bands
  if (bands.length <= 1) return
  bands.splice(index, 1)
  applyBandChain()
}

const trialResult = computed(() => {
  const rule = normalizeVatRule(draft.value)
  const value = Number(trialNeed.value) || 0
  return planOrderQuantity(value, rule, {
    planned: value,
    monthlyAvgCount: value,
    spuMonthlyAvg: value,
  })
})

const trialText = computed(() => {
  const result = trialResult.value
  if (!result) return ''
  if (!(Number(trialNeed.value) > 0)) return '填入数值看这段补多少'
  if (result.action === 'skip') return '这段补到 0 公斤（不下单）'
  if (result.action === 'fixed') return `补到 ${formatNumber(result.rounded)} 公斤`
  if (result.action === 'round') {
    return `按 ${formatNumber(result.kgPerVat)} 公斤取整 · 下单 ${formatNumber(result.rounded)} 公斤`
  }
  if (result.vatCount !== null && result.kgPerVat) {
    return `${formatNumber(result.vatCount)} 缸 × ${formatNumber(result.kgPerVat)} 公斤 = ${formatNumber(result.rounded)} 公斤`
  }
  return `下单 ${formatNumber(result.rounded)} 公斤`
})

const trialTone = computed(() => {
  const result = trialResult.value
  if (!result || !(Number(trialNeed.value) > 0)) return ''
  if (result.action === 'skip') return 'warn'
  if (result.warnings.length) return 'warn'
  if (Math.abs(result.deltaKg) < 0.005) return 'ok'
  return ''
})


// 编辑弹窗打开时把老配置摊成「一行一段」：
// 缸型阶梯（80/160/240）按相邻中点拆成区间（→ 120 / 200 两个断点），末段留成开口的单缸型；
// 老数据里的「按每缸公斤取整（vat）」等价于只有一种缸型；
// 老的「整十 / 整百取整」段没法用「补到」表达，直接并进上一段。
function expandLadderBand(band, startFrom) {
  const sizes = normalizeVatSizes(band.sizes)
  if (!sizes.length) return []
  const rows = []
  sizes.forEach((size, index) => {
    const isLastSize = index === sizes.length - 1
    const from = index === 0 ? startFrom : Number(rows[rows.length - 1].upTo)
    const midpoint = isLastSize
      ? null
      : Math.round(((size + sizes[index + 1]) / 2) * 100) / 100
    const cap = band.upTo === null || band.upTo === undefined ? null : Number(band.upTo)
    const upper = cap === null ? midpoint : midpoint === null ? cap : Math.min(midpoint, cap)
    if (upper !== null && !(upper > from)) return
    rows.push({
      upTo: upper,
      action: upper === null ? 'ladder' : 'fixed',
      value: size,
      sizes: upper === null ? [size] : [],
    })
  })
  return rows
}

function prepareDraft(rule) {
  const draftRule = cloneRule(rule)
  const bands = []
  let from = 0
  for (const band of draftRule.bands) {
    if (band.action === 'round') continue
    if (band.action === 'ladder' || band.action === 'vat') {
      const source =
        band.action === 'vat'
          ? { ...band, action: 'ladder', sizes: normalizeVatSizes([band.value]) }
          : band
      const rows = expandLadderBand(source, from)
      if (rows.length) {
        bands.push(...rows)
        from = rows[rows.length - 1].upTo ?? from
        continue
      }
    }
    bands.push({ ...band })
    from = band.upTo ?? from
  }
  draftRule.bands = bands.length
    ? bands
    : [{ upTo: null, action: 'ladder', value: 0, sizes: [...DEFAULT_VAT_SIZES] }]
  applyBandChain(draftRule.bands)
  return draftRule
}

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
  if (bandErrorCount.value > 0) {
    const index = bandErrors.value.findIndex(Boolean)
    ElMessage.error(`范围 ${index + 1}：${bandErrors.value[index]}`)
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
      <div class="vat-rules">
        <article
          v-for="row in ruleRows"
          :key="row.id"
          class="vat-rule"
          :class="{ 'vat-rule--default': row.isDefault }"
        >
          <div class="vat-rule__head">
            <strong class="vat-rule__name" :title="row.name">{{ row.name }}</strong>
            <label
              class="vat-rule__pick"
              :class="{ 'vat-rule__pick--on': row.isDefault }"
              title="设为默认规则：没有单独绑定的品名都用它"
            >
              <input
                type="radio"
                name="vat-default-rule"
                :value="row.id"
                :checked="row.isDefault"
                @change="setDefaultRule(row.id)"
              />
              <span>设为默认</span>
            </label>
            <div class="vat-rule__acts">
              <button
                type="button"
                class="vat-link"
                @click="openEdit(rules.find((rule) => rule.id === row.id))"
              >
                编辑
              </button>
              <button
                v-if="!row.isDefault"
                type="button"
                class="vat-link vat-link--danger"
                @click="removeRule(row.id)"
              >
                删除
              </button>
              <span v-else class="vat-link vat-link--ghost">删除</span>
            </div>
          </div>
          <div class="vat-rule__ladder">
            <span v-for="band in row.bands" :key="band.index" class="vat-rule__seg">
              <em>{{ band.range }}</em>
              <i>→</i>
              <b :class="{ 'is-skip': band.skip }">{{ band.target }}</b>
            </span>
          </div>
        </article>
        <p v-if="ruleRows.length === 0" class="vat-settings__empty">还没有缸规则</p>
      </div>

      <div class="vat-bind">
        <div class="vat-bind__head">
          <strong>品名绑定</strong>
          <ElInput
            v-model="spuKeyword"
            size="small"
            clearable
            placeholder="搜索品名"
            class="vat-bind__search"
          />
        </div>

        <div class="vat-bind__tabs">
          <label
            v-for="option in ruleCountOptions"
            :key="option.id"
            class="vat-tab"
            :class="{ 'vat-tab--on': !keywordActive && option.id === activeRuleId }"
          >
            <input
              type="radio"
              name="vat-rule-tab"
              :value="option.id"
              :checked="option.id === activeRuleId"
              @change="setActiveRule(option.id)"
            />
            {{ option.name }}<span class="vat-tab__count">{{ option.count }}</span>
          </label>
        </div>

        <div class="vat-bind__grid" :class="{ 'vat-bind__grid--search': keywordActive }">
          <button
            v-for="entry in visibleSpus"
            :key="entry.product"
            type="button"
            class="vat-spu-cell"
            :title="`${entry.product} · ${ruleLabelOf(entry.product)}`"
            @click="openRuleMenu($event, [entry.product])"
          >
            <span class="vat-spu-cell__name">{{ entry.product }}</span>
            <span v-if="keywordActive" class="vat-spu-cell__rule">
              {{ ruleLabelOf(entry.product) }}
            </span>
            <span v-else class="vat-spu-cell__mark">▾</span>
          </button>
          <p v-if="visibleSpus.length === 0" class="vat-bind__empty">
            {{
              spus.length === 0
                ? '还没导入总表，导入后这里会列出品名'
                : keywordActive
                  ? '没有匹配的品名'
                  : '这条规则下还没有品名'
            }}
          </p>
        </div>

        <p class="vat-bind__note">
          <template v-if="keywordActive">
            全部规则下 {{ visibleSpus.length }} 个匹配
            <button
              v-if="visibleSpus.length"
              type="button"
              class="vat-link"
              @click="openRuleMenu($event, visibleSpus.map((entry) => entry.product))"
            >
              全部归到…
            </button>
          </template>
          <template v-else-if="!activeRuleId">
            这 {{ visibleSpus.length }} 个品名没单独绑定，跟着默认规则「{{ defaultRuleName }}」，点任意品名可改
          </template>
          <template v-else>
            单独绑到「{{ ruleNameBy(activeRuleId) }}」的品名，点任意品名可改回「默认」
          </template>
        </p>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="ruleMenu.open"
        class="vat-rule-menu"
        :style="{ left: `${ruleMenu.x}px`, top: `${ruleMenu.y}px` }"
      >
        <p class="vat-rule-menu__head">
          {{
            ruleMenu.products.length > 1
              ? `把 ${ruleMenu.products.length} 个品名归到`
              : `${ruleMenu.products[0]} → 归到`
          }}
        </p>
        <label v-for="option in ruleMenuOptions" :key="option.id" class="vat-rule-menu__item">
          <input
            type="radio"
            name="vat-rule-menu"
            :value="option.id"
            :checked="option.id === ruleMenu.current"
            @change="applyRuleToSelection(option.id)"
          />
          <span>{{ option.name }}</span>
          <span v-if="option.note" class="vat-rule-menu__note">{{ option.note }}</span>
        </label>
      </div>
    </Teleport>

    <ElDialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="760px"
      class="ui-dialog vat-rule-dialog"
      destroy-on-close
      align-center
    >
      <div class="vat-dialog-head">
        <label class="vat-dialog-field">
          <span>规则名称 *</span>
          <ElInput v-model="draft.name" size="small" placeholder="例如：标准大货补单" />
        </label>
    
      </div>

      <div class="vat-bands">
        <article
          v-for="(band, index) in draft.bands"
          :key="index"
          class="vat-band"
          :class="{ 'vat-band--invalid': Boolean(bandErrors[index]) }"
        >
          <div class="vat-band__row">
            <span class="vat-band__index">范围{{ index + 1 }}</span>

            <span class="vat-band__word">从</span>
            <span class="vat-band__cell">
              <ElInputNumber
                v-if="index > 0"
                :model-value="bandFrom(index)"
                size="small"
                :min="1"
                :step="10"
                :controls="false"
                class="vat-band__num"
                :aria-label="`范围${index + 1}下限（${currentUnit}）`"
                @update:model-value="setBandFrom(index, $event)"
              />
              <b v-else class="vat-band__static">0</b>
            </span>

            <span class="vat-band__word">到</span>
            <span class="vat-band__cell">
              <ElInputNumber
                v-if="index < draft.bands.length - 1"
                :model-value="bandUpper(index)"
                size="small"
                :min="1"
                :step="10"
                :controls="false"
                class="vat-band__num"
                :aria-label="`范围${index + 1}上限（${currentUnit}）`"
                @update:model-value="setBandUpper(index, $event)"
              />
              <b v-else class="vat-band__static">不限</b>
            </span>
            <span class="vat-band__unit">{{ currentUnit }}</span>

            <span class="vat-band__arrow">→</span>

            <span class="vat-band__word">补到</span>
            <span class="vat-band__cell">
              <ElInputNumber
                :model-value="bandTarget(band)"
                size="small"
                :min="0"
                :step="10"
                :controls="false"
                class="vat-band__num"
                :aria-label="`范围${index + 1}补到多少公斤`"
                @update:model-value="setBandTarget(index, $event)"
              />
            </span>
            <span class="vat-band__unit">公斤</span>

            <span class="vat-band__actions">
              <button
                type="button"
                class="vat-band__insert"
                :title="
                  index < draft.bands.length - 1
                    ? `把范围${index + 1}一分为二：前半留给本段，后半给新段`
                    : '在末段后面再加一段'
                "
                @click="insertBandAfter(index)"
              >
                插入
              </button>
              <button
                type="button"
                class="vat-band__remove"
                :disabled="draft.bands.length <= 1"
                @click="removeBand(index)"
              >
                删除
              </button>
            </span>
          </div>
          <p v-if="bandErrors[index]" class="vat-band__error">{{ bandErrors[index] }}</p>
        </article>
      </div>

      <div class="vat-dialog-actions">
        <ElButton size="small" @click="addBand">＋ 添加范围</ElButton>
        <span class="vat-settings__hint">{{ lastBandHint }}</span>
      </div>
 

      <div class="vat-dialog-trial">
        <span class="vat-dialog-trial__label">试算</span>
        <ElInputNumber
          v-model="trialNeed"
          size="small"
          :min="0"
          :step="10"
          :controls="false"
          class="vat-dialog-trial__input"
          aria-label="试算值"
        />
        <span class="vat-settings__hint">{{ currentUnit }}</span>
        <span class="vat-dialog-trial__result" :class="`vat-dialog-trial__result--${trialTone}`">
          {{ trialText }}
        </span>
      </div>
      <p v-if="trialResult.warnings.length && trialResult.action !== 'skip'" class="vat-dialog-trial__warn">
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

/* 规则：名字右边跟「设为默认」单选；右侧两个按钮各占固定一列，跨行对齐 */
.vat-rules {
  display: flex;
  flex-direction: column;
}

.vat-rule {
  padding: 6px 0 0;
  border-top: 1px solid var(--line-soft);
  border-left: 3px solid transparent;
}

.vat-rule:first-child {
  border-top: none;
}

.vat-rule--default {
  border-left-color: var(--industrial-primary);
}

.vat-rule__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
}

.vat-rule__name {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 13.5px;
  font-weight: 700;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vat-rule__pick {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  color: var(--industrial-muted);
  font-size: 11.5px;
  cursor: pointer;
}

.vat-rule__pick input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--industrial-primary);
  cursor: pointer;
}

.vat-rule__pick--on {
  color: var(--industrial-primary);
  font-weight: 600;
}

.vat-rule__acts {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.vat-link {
  width: 42px;
  padding: 2px 0;
  border: 0;
  border-radius: 2px;
  background: none;
  color: var(--industrial-muted);
  font-size: 11.5px;
  line-height: 1.4;
  text-align: center;
  white-space: nowrap;
  cursor: pointer;
}

.vat-link:hover {
  background: rgba(63, 113, 141, 0.1);
  color: var(--industrial-primary);
}

.vat-link--danger:hover {
  background: rgba(184, 79, 72, 0.1);
  color: var(--industrial-danger);
}

/* 默认规则不能删，占位保持「编辑」这一列跨行对齐 */
.vat-link--ghost {
  visibility: hidden;
  cursor: default;
}

/* 一段一格：区间 → 补到多少 */
.vat-rule__ladder {
  display: flex;
  padding: 1px 10px 8px;
}

.vat-rule__seg {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 0 14px;
  border-left: 1px dashed var(--industrial-grid-light);
  white-space: nowrap;
}

.vat-rule__seg:first-child {
  padding-left: 0;
  border-left: none;
}

.vat-rule__seg em {
  color: var(--industrial-muted);
  font-size: 11.5px;
  font-style: normal;
}

.vat-rule__seg i {
  color: var(--industrial-grid);
  font-size: 11px;
  font-style: normal;
}

.vat-rule__seg b {
  color: var(--industrial-primary);
  font-size: 13px;
  font-weight: 700;
}

.vat-rule__seg b.is-skip {
  color: var(--industrial-muted);
  font-size: 12.5px;
  font-weight: 600;
}

/* 品名绑定：规则单选一排 + 品名网格 */
.vat-bind {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--industrial-grid);
}

.vat-bind__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.vat-bind__head > strong {
  color: var(--industrial-text);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
}

.vat-bind__search {
  width: min(200px, 100%);
  margin-left: auto;
}

.vat-bind__tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin-top: 6px;
}

.vat-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 2px;
  color: var(--industrial-text);
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
}

.vat-tab:hover {
  background: rgba(63, 113, 141, 0.1);
}

.vat-tab input {
  width: 12px;
  height: 12px;
  margin: 0;
  accent-color: var(--industrial-primary);
  cursor: pointer;
}

.vat-tab__count {
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.vat-tab--on {
  border-color: var(--industrial-primary);
  background: rgba(63, 113, 141, 0.1);
  color: var(--industrial-primary);
  font-weight: 600;
}

.vat-tab--on .vat-tab__count {
  color: var(--industrial-primary);
}

.vat-bind__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 1px;
  max-height: 228px;
  margin-top: 8px;
  overflow: auto;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 2px;
  background: var(--line-soft);
}

/* 搜索结果里每个格子要多显示当前规则，格子放宽一点 */
.vat-bind__grid--search {
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
}

.vat-spu-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 27px;
  padding: 0 8px;
  border: 0;
  background: #fff;
  color: var(--industrial-text);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.vat-spu-cell:hover {
  background: rgba(63, 113, 141, 0.1);
  color: var(--industrial-primary);
}

.vat-spu-cell__name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vat-spu-cell__rule {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 10.5px;
  white-space: nowrap;
}

.vat-spu-cell__mark {
  margin-left: auto;
  color: var(--industrial-grid);
  font-size: 10px;
}

.vat-spu-cell:hover .vat-spu-cell__mark {
  color: var(--industrial-primary);
}

.vat-bind__empty {
  grid-column: 1 / -1;
  margin: 0;
  padding: 16px 10px;
  background: #fff;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.vat-bind__note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.vat-bind__note .vat-link {
  width: auto;
  padding: 1px 6px;
  color: var(--industrial-primary);
  text-decoration: underline dotted;
}

/* 点品名后的规则选择浮层 */
.vat-rule-menu {
  position: fixed;
  z-index: 3000;
  min-width: 212px;
  padding: 4px;
  border: 1px solid var(--industrial-grid);
  border-radius: 2px;
  background: #fff;
  box-shadow: 0 4px 16px rgba(47, 59, 67, 0.22);
}

.vat-rule-menu__head {
  margin: 0 0 3px;
  padding: 4px 8px 5px;
  overflow: hidden;
  border-bottom: 1px solid var(--industrial-grid-light);
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.vat-rule-menu__item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 2px;
  color: var(--industrial-text);
  font-size: 12.5px;
  cursor: pointer;
}

.vat-rule-menu__item:hover {
  background: rgba(63, 113, 141, 0.1);
  color: var(--industrial-primary);
}

.vat-rule-menu__item input {
  width: 12px;
  height: 12px;
  margin: 0;
  accent-color: var(--industrial-primary);
  cursor: pointer;
}

.vat-rule-menu__note {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 10.5px;
}

.vat-dialog-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 14px;
  margin-bottom: 12px;
}

.vat-dialog-head .vat-dialog-field {
  width: 240px;
  flex: 0 0 auto;
}

/* 与输入框首行对齐，不压在「规则名称」标签上。 */
.vat-dialog-head__tip {
  flex: 1 1 320px;
  margin: 18px 0 0;
  color: var(--industrial-muted);
  font-size: 11.5px;
  line-height: 1.55;
}

.vat-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--industrial-muted);
  font-size: 12px;
}

/* 每段一张卡：区间在上、「怎么补」一排按钮、参数紧跟其下，按阅读顺序排。 */
.vat-bands {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.vat-band {
  padding: 8px 10px 9px;
  border: 1px solid var(--industrial-grid);
  border-left: 3px solid var(--industrial-primary);
  border-radius: 4px;
  background: #fff;
}

/* 每行一条规则：从 → 到 → 补到多少。列宽写死，行与行绝对对齐（含 0 / 不限 那个灰格子）。 */
.vat-band__row {
  display: grid;
  grid-template-columns: 58px 16px 78px 16px 78px 24px 18px 28px 78px 24px 1fr;
  align-items: center;
  column-gap: 8px;
}

.vat-band__index {
  padding: 1px 6px;
  color: var(--industrial-primary);
  background: rgba(63, 113, 141, 0.1);
  border-radius: 2px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  text-align: center;
}

.vat-band__word {
  color: var(--industrial-muted);
  font-size: 12px;
  white-space: nowrap;
}

.vat-band__arrow {
  color: var(--industrial-primary);
  font-size: 12px;
  text-align: center;
}

.vat-band__static {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
  background: var(--industrial-page);
  color: var(--industrial-muted);
  font-size: 12px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.vat-band__actions {
  display: flex;
  align-items: center;
  justify-self: end;
  gap: 2px;
}

.vat-band__insert {
  padding: 2px 6px;
  color: var(--industrial-primary);
  background: none;
  border: none;
  border-radius: 2px;
  font-size: 11.5px;
  cursor: pointer;
}

.vat-band__insert:hover {
  background: rgba(63, 113, 141, 0.1);
}

.vat-band__remove {
  padding: 2px 6px;
  color: var(--industrial-muted);
  background: none;
  border: none;
  font-size: 11.5px;
  cursor: pointer;
}

.vat-band__remove:hover:not(:disabled) {
  color: var(--industrial-danger);
}

.vat-band__remove:disabled {
  color: var(--industrial-grid);
  cursor: not-allowed;
}

/* 配置页有全局「弹窗里的 el-input-number 撑满」规则，这里按格子宽度收住，三行才一样宽。 */
.vat-band__row :deep(.el-input-number) {
  width: 100%;
  flex: 0 0 auto;
}

.vat-band__unit {
  color: var(--industrial-muted);
  font-size: 11.5px;
  white-space: nowrap;
}

/* 区间断了（上限 < 下限）就地标红，保存时也会拦下。 */
.vat-band--invalid {
  border-color: var(--industrial-danger);
  border-left-color: var(--industrial-danger);
}

.vat-band__error {
  margin: 4px 0 0;
  color: var(--industrial-danger);
  font-size: 11px;
}

.vat-dialog-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.vat-bands__hint {
  margin: 6px 0 0;
  color: var(--industrial-muted);
  font-size: 11.5px;
  line-height: 1.5;
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

.vat-dialog-trial :deep(.el-input-number.el-input-number--small) {
  width: 110px;
  flex: 0 0 auto;
}

.vat-dialog-trial__result {
  margin-left: auto;
  color: var(--industrial-primary);
  font-weight: 600;
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
