<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ElButton,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTable,
  ElTableColumn,
} from 'element-plus'
import { Delete } from '@element-plus/icons-vue'
import PanelNavigation from '@/components/PanelNavigation.vue'
import StockingFieldPicker from '@/components/StockingFieldPicker.vue'
import {
  ALL_GRADES,
  COMPARE_OPERATORS,
  createDefaultCoefficients,
  createEvaluator,
  createThresholds,
  evaluateItem,
  exportConfigFile,
  getFieldLabel,
  getFieldMeta,
  normalizeConfig,
  summarizeEvaluation,
  validateConfig,
} from '@/stocking'
import { DEFAULT_PANEL_KEY, getPanelConfigLabel, isExamplePanel } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { useStockingConfigStore } from '@/stores/stocking'
import { groupRowsByProduct } from '@/utils/productGroups'
import { calculateInventoryRow, formatFactors, formatQuantity } from '@/utils/inventory'

// 主面板与示例配置共用同一份备货配置（src/stocking/config.json），改哪边都一样。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const COEFFICIENT_KEYS = [
  { key: 'redLine', label: '红线' },
  { key: 'normal', label: '正常' },
  { key: 'peak', label: '峰值' },
]
const GRADE_KEYS = ['S', 'A', 'B', 'C']
const CATEGORIES = getFieldMeta('category').options

const inventoryStore = useInventoryStore(props.panelKey)
const stockingStore = useStockingConfigStore()
const inventoryItems = inventoryStore.inventoryItems
const examplePanel = isExamplePanel(props.panelKey)
const configLabel = getPanelConfigLabel(props.panelKey)
const panelDescription = examplePanel
  ? '示例配置：与主面板共用同一份备货配置，仅供对照演示。'
  : '维护规则、热度打分与备货系数；修改会写回 src/stocking/config.json。'

// —— 配置草稿 ——
const configDraft = ref(normalizeConfig(stockingStore.config))
const selectedRuleId = ref(configDraft.value.rules[0]?.id ?? '')
// 规则删除需要二次点击确认，避免误删整条规则。
const pendingRuleDeleteId = ref('')
let ruleDeleteTimer = 0
const configDirty = computed(
  () =>
    JSON.stringify(configDraft.value) !==
    JSON.stringify(normalizeConfig(stockingStore.config)),
)
const validation = computed(() => validateConfig(configDraft.value))
const activeRule = computed(
  () =>
    configDraft.value.rules.find((rule) => rule.id === selectedRuleId.value) ??
    configDraft.value.rules[0] ??
    null,
)

// —— 草稿撤销 / 重做 ——
// 历史只覆盖「未保存的草稿」：改动前存一份 JSON 快照，连续输入合并成一步，
// 结构性操作（增删规则 / 档位 / 因子 / 条件）各自单独成步。
const HISTORY_LIMIT = 50
const HISTORY_DEBOUNCE = 600
const undoStack = ref([])
const redoStack = ref([])
const pendingHistory = ref(false)
// 外部整体替换草稿（撤销 / 重做 / 重置 / 恢复默认）时递增，用于重挂编辑器，
// 否则 ElInputNumber 会保留旧的输入态，撤销后数值框仍显示改过的值。
const draftVersion = ref(0)
let historyTimer = 0
let baseline = JSON.stringify(configDraft.value)
let pendingBase = null
let restoringDraft = false

const canUndo = computed(() => undoStack.value.length > 0 || pendingHistory.value)
const canRedo = computed(() => redoStack.value.length > 0)

function snapshotDraft() {
  return JSON.stringify(configDraft.value)
}

// 把挂起的输入合并提交成一步历史。
function commitPendingHistory() {
  if (historyTimer) {
    clearTimeout(historyTimer)
    historyTimer = 0
  }
  if (pendingBase === null) return

  const current = snapshotDraft()
  if (current !== pendingBase) {
    undoStack.value = [...undoStack.value, pendingBase].slice(-HISTORY_LIMIT)
    redoStack.value = []
  }
  pendingBase = null
  pendingHistory.value = false
  baseline = current
}

// 结构性操作前先提交已有改动，保证“改一个数值 + 删一个档位”是两步。
function beforeStructuralChange() {
  commitPendingHistory()
}

watch(configDraft, () => {
  if (restoringDraft) return

  const current = snapshotDraft()
  if (current === baseline && pendingBase === null) return
  if (pendingBase === null) pendingBase = baseline
  pendingHistory.value = true

  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = window.setTimeout(commitPendingHistory, HISTORY_DEBOUNCE)
}, { deep: true })

function applySnapshot(json) {
  restoringDraft = true
  configDraft.value = normalizeConfig(JSON.parse(json))
  if (!configDraft.value.rules.some((rule) => rule.id === selectedRuleId.value)) {
    selectedRuleId.value = configDraft.value.rules[0]?.id ?? ''
  }
  pendingRuleDeleteId.value = ''
  draftVersion.value += 1
  baseline = snapshotDraft()
  pendingBase = null
  pendingHistory.value = false
  nextTick(() => {
    restoringDraft = false
  })
}

function undo() {
  commitPendingHistory()
  const stack = undoStack.value
  if (!stack.length) return

  redoStack.value = [...redoStack.value, snapshotDraft()].slice(-HISTORY_LIMIT)
  undoStack.value = stack.slice(0, -1)
  applySnapshot(stack[stack.length - 1])
}

function redo() {
  commitPendingHistory()
  const stack = redoStack.value
  if (!stack.length) return

  undoStack.value = [...undoStack.value, snapshotDraft()].slice(-HISTORY_LIMIT)
  redoStack.value = stack.slice(0, -1)
  applySnapshot(stack[stack.length - 1])
}

function clearHistory() {
  if (historyTimer) {
    clearTimeout(historyTimer)
    historyTimer = 0
  }
  undoStack.value = []
  redoStack.value = []
  pendingBase = null
  pendingHistory.value = false
  baseline = snapshotDraft()
}

function handleHistoryShortcut(event) {
  if (!(event.ctrlKey || event.metaKey)) return
  const target = event.target
  const tagName = target?.tagName?.toLowerCase()
  // 输入框内交给浏览器处理文本撤销，避免抢掉原生行为。
  if (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) return

  const key = event.key.toLowerCase()
  if (key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (key === 'y') {
    event.preventDefault()
    redo()
  }
}

onMounted(() => document.addEventListener('keydown', handleHistoryShortcut))

// 规则/档位的实际命中分布：配置改动后延迟重算，避免逐键全量评估。
const distribution = ref(null)
let distributionTimer = 0

function scheduleDistribution() {
  if (distributionTimer) clearTimeout(distributionTimer)
  distributionTimer = window.setTimeout(() => {
    distributionTimer = 0
    distribution.value = summarizeEvaluation(inventoryItems, configDraft.value)
  }, 250)
}

watch(configDraft, scheduleDistribution, { deep: true })
scheduleDistribution()

onBeforeUnmount(() => {
  if (distributionTimer) clearTimeout(distributionTimer)
  if (historyTimer) clearTimeout(historyTimer)
  if (ruleDeleteTimer) clearTimeout(ruleDeleteTimer)
  productTransitionTimers.forEach((timer) => clearTimeout(timer))
  document.removeEventListener('keydown', handleHistoryShortcut)
})

function ruleHitCount(ruleName) {
  return distribution.value?.ruleCounts.get(ruleName) ?? null
}

function tierHitCount(ruleName, tierName) {
  return distribution.value?.tierCounts.get(`${ruleName}\u0000${tierName}`) ?? null
}

function factorCountOf(rule) {
  return rule ? Object.keys(rule.grades).length : 0
}

function operatorOptions(field) {
  const meta = getFieldMeta(field)
  return meta?.kind === 'number' ? COMPARE_OPERATORS : COMPARE_OPERATORS.slice(2)
}

function isEnumField(field) {
  return getFieldMeta(field)?.kind === 'enum'
}

function isTextField(field) {
  return getFieldMeta(field)?.kind === 'text'
}

function usedFactorFields(rule) {
  return (rule?.factors ?? []).map((factor) => factor.field)
}

function usedGradeFields(rule) {
  return Object.keys(rule?.grades ?? {})
}

// —— 规则 ——
function addRule() {
  const used = new Set(
    configDraft.value.rules.filter((rule) => !rule.isDefault).map((rule) => rule.name),
  )
  let index = 1
  while (used.has(`规则${index}`)) index += 1

  const id = `rule-${Date.now().toString(36)}`
  const rule = {
    id,
    name: `规则${index}`,
    isDefault: false,
    factors: [],
    grades: { monthlyAvgCount: createThresholds('monthlyAvgCount') },
    tiers: [
      {
        id: `${id}-tier-1`,
        name: '热销A',
        isDefault: false,
        conditions: [{ grade: 'S', operator: 'gte', count: 1 }],
        coefficients: createDefaultCoefficients(),
      },
      {
        id: `${id}-tier-default`,
        name: '默认档',
        isDefault: true,
        conditions: [],
        coefficients: createDefaultCoefficients(),
      },
    ],
  }

  const defaultIndex = configDraft.value.rules.findIndex((entry) => entry.isDefault)
  beforeStructuralChange()
  configDraft.value.rules.splice(
    defaultIndex < 0 ? configDraft.value.rules.length : defaultIndex,
    0,
    rule,
  )
  selectedRuleId.value = id
}

function removeRule(rule) {
  if (!rule || rule.isDefault) return
  const index = configDraft.value.rules.findIndex((entry) => entry.id === rule.id)
  if (index < 0) return

  beforeStructuralChange()
  configDraft.value.rules.splice(index, 1)
  if (selectedRuleId.value === rule.id) {
    selectedRuleId.value = configDraft.value.rules[0]?.id ?? ''
  }
}

// 第一次点击只进入“待确认”状态，3 秒内再次点击才真正删除。
function requestRemoveRule(rule) {
  if (!rule || rule.isDefault) return

  if (pendingRuleDeleteId.value !== rule.id) {
    pendingRuleDeleteId.value = rule.id
    if (ruleDeleteTimer) clearTimeout(ruleDeleteTimer)
    ruleDeleteTimer = window.setTimeout(() => {
      pendingRuleDeleteId.value = ''
      ruleDeleteTimer = 0
    }, 3000)
    return
  }

  if (ruleDeleteTimer) clearTimeout(ruleDeleteTimer)
  ruleDeleteTimer = 0
  pendingRuleDeleteId.value = ''
  removeRule(rule)
}

// 切换规则时取消待确认状态，避免按钮文案残留到另一条规则上。
watch(selectedRuleId, () => {
  pendingRuleDeleteId.value = ''
  if (ruleDeleteTimer) {
    clearTimeout(ruleDeleteTimer)
    ruleDeleteTimer = 0
  }
})

// —— 规则因子 ——
function addRuleFactor(field) {
  const rule = activeRule.value
  if (!rule) return

  const meta = getFieldMeta(field)
  const value = meta.kind === 'number' ? 0 : meta.options?.[0] ?? ''
  beforeStructuralChange()
  rule.factors.push({ field, operator: operatorOptions(field)[0].value, value })
}

function removeRuleFactor(index) {
  if (!activeRule.value) return
  beforeStructuralChange()
  activeRule.value.factors.splice(index, 1)
}

// —— 热度因子与评分标准 ——
function addGradeField(field) {
  const rule = activeRule.value
  if (!rule || rule.grades[field]) return
  beforeStructuralChange()
  rule.grades[field] = createThresholds(field)
}

function removeGradeField(field) {
  const rule = activeRule.value
  if (!rule) return
  beforeStructuralChange()
  delete rule.grades[field]
}

// —— 热度档 ——
function nextTierName(rule) {
  const used = new Set(rule.tiers.filter((tier) => !tier.isDefault).map((tier) => tier.name))
  for (let index = 0; index < 26; index += 1) {
    const name = `热销${String.fromCharCode(65 + index)}`
    if (!used.has(name)) return name
  }
  return '热销Z'
}

function addTier() {
  const rule = activeRule.value
  if (!rule) return

  const tier = {
    id: `${rule.id}-tier-${Date.now().toString(36)}`,
    name: nextTierName(rule),
    isDefault: false,
    conditions: [{ grade: 'S', operator: 'gte', count: 1 }],
    coefficients: createDefaultCoefficients(),
  }
  const defaultIndex = rule.tiers.findIndex((entry) => entry.isDefault)
  beforeStructuralChange()
  rule.tiers.splice(defaultIndex < 0 ? rule.tiers.length : defaultIndex, 0, tier)
}

function removeTier(tier) {
  if (tier.isDefault) return
  const rule = activeRule.value
  const index = rule.tiers.indexOf(tier)
  if (index < 0) return
  beforeStructuralChange()
  rule.tiers.splice(index, 1)
}

function moveTier(tier, direction) {
  const rule = activeRule.value
  const index = rule.tiers.indexOf(tier)
  const target = index + direction
  if (index < 0 || target < 0 || target >= rule.tiers.length) return
  if (rule.tiers[target].isDefault) return

  beforeStructuralChange()
  rule.tiers.splice(index, 1)
  rule.tiers.splice(target, 0, tier)
}

function copyPreviousCoefficients(tier) {
  const rule = activeRule.value
  const index = rule.tiers.indexOf(tier)
  const source = rule.tiers[index - 1] ?? rule.tiers[0]
  if (!source || source === tier) return
  beforeStructuralChange()
  tier.coefficients = JSON.parse(JSON.stringify(source.coefficients))
}

function addTierCondition(tier) {
  beforeStructuralChange()
  tier.conditions.push({ grade: 'S', operator: 'gte', count: 1 })
}

function removeTierCondition(tier, index) {
  beforeStructuralChange()
  tier.conditions.splice(index, 1)
}

// —— 保存 / 重置 / 导出 ——
async function confirmConfig() {
  const result = validateConfig(configDraft.value)
  if (!result.ok) {
    ElMessage.error(result.errors[0]?.message ?? '配置有误，请先修正')
    return
  }

  const conflictCount = distribution.value?.conflictCount ?? 0
  if (conflictCount > 0) {
    const samples = (distribution.value?.conflictSamples ?? [])
      .map((item) => `${item.skuId} ${item.product}/${item.color}`)
      .join('、')
    const proceed = await ElMessageBox.confirm(
      `有 ${conflictCount} 个 SKU 命中多条规则（如：${samples}），将按规则列表中靠前的一条处理。是否仍然保存？`,
      '规则存在重叠',
      { confirmButtonText: '仍然保存', cancelButtonText: '返回修改', type: 'warning' },
    )
      .then(() => true)
      .catch(() => false)
    if (!proceed) return
  }

  const saved = await stockingStore.apply(configDraft.value)
  configDraft.value = normalizeConfig(saved.config)
  draftVersion.value += 1
  clearHistory()
  ElMessage.success(
    saved.written
      ? '配置已保存到 src/stocking/config.json'
      : '已保存到本地缓存（部署环境无法写源文件，可点击“导出配置”覆盖）',
  )
}

function discardChanges() {
  configDraft.value = normalizeConfig(stockingStore.config)
  selectedRuleId.value = configDraft.value.rules[0]?.id ?? ''
  pendingRuleDeleteId.value = ''
  draftVersion.value += 1
  clearHistory()
}

async function restoreDefaults() {
  const confirmed = await ElMessageBox.confirm(
    '恢复为内置默认配置并立即写回配置文件？当前修改会丢失。',
    '恢复默认',
    { confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return

  const saved = await stockingStore.restoreDefaults()
  configDraft.value = normalizeConfig(saved.config)
  selectedRuleId.value = configDraft.value.rules[0]?.id ?? ''
  pendingRuleDeleteId.value = ''
  draftVersion.value += 1
  clearHistory()
  ElMessage.success('已恢复默认配置')
}

function downloadConfig() {
  exportConfigFile(configDraft.value)
  ElMessage.success('配置文件已导出，可覆盖 src/stocking/config.json')
}

// —— 备货详情表格 ——
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const selectedRowId = ref(null)
const configTableRef = ref(null)
const collapsingProductKeys = ref(new Set())
const expandingProductKeys = ref(new Set())

const inventoryLeafRows = computed(() => {
  // 表格展示的是已生效配置的计算结果，未保存的草稿不影响这里。
  const evaluator = createEvaluator(stockingStore.config)
  return inventoryItems
    .map((item) => calculateInventoryRow(evaluateItem(item, evaluator)))
    .sort(
      (first, second) =>
        productCollator.compare(first.product, second.product) ||
        Number(second.color === '黑色') - Number(first.color === '黑色') ||
        productCollator.compare(first.color, second.color) ||
        first.id - second.id,
    )
})

const inventoryRows = computed(() => groupRowsByProduct(inventoryLeafRows.value))

// 配置信息页仍用 ElTable（含展开行与下拉），3 万行无法一次渲染：
// 行数小保持品名树形；行数大改为扁平分页。
const CONFIG_FLAT_LIMIT = 500
const CONFIG_FLAT_PAGE_SIZE = 60
const CONFIG_PAGE_ROW_BUDGET = 300
const configFlat = computed(() => inventoryLeafRows.value.length > CONFIG_FLAT_LIMIT)
const configLeafPageCount = computed(() =>
  Math.max(1, Math.ceil(inventoryLeafRows.value.length / CONFIG_FLAT_PAGE_SIZE)),
)
const pagedLeafRows = computed(() => {
  const start = (configPage.value - 1) * CONFIG_FLAT_PAGE_SIZE
  return inventoryLeafRows.value.slice(start, start + CONFIG_FLAT_PAGE_SIZE)
})
const configPage = ref(1)
const configPages = computed(() => {
  const pages = []
  let currentPage = []
  let rowCount = 0

  for (const group of inventoryRows.value) {
    const groupRowCount = group.children.length
    if (currentPage.length > 0 && rowCount + groupRowCount > CONFIG_PAGE_ROW_BUDGET) {
      pages.push(currentPage)
      currentPage = []
      rowCount = 0
    }
    currentPage.push(group)
    rowCount += groupRowCount
  }
  if (currentPage.length > 0) pages.push(currentPage)
  return pages.length > 0 ? pages : [[]]
})
const configPageCount = computed(() =>
  configFlat.value ? configLeafPageCount.value : configPages.value.length,
)
const configTableRows = computed(() =>
  configFlat.value
    ? pagedLeafRows.value
    : configPages.value[Math.min(configPage.value, configPages.value.length) - 1] ?? [],
)

watch(configPageCount, (pageCount) => {
  if (configPage.value > pageCount) configPage.value = pageCount
})

const expandedProductKeys = ref(inventoryRows.value.map((row) => row.id))
let knownProductKeys = new Set(expandedProductKeys.value)
const productTransitionTimers = new Map()
const productTransitionDuration = 120

function clearProductTransition(productKey) {
  const timer = productTransitionTimers.get(productKey)
  if (timer) clearTimeout(timer)
  productTransitionTimers.delete(productKey)
  collapsingProductKeys.value.delete(productKey)
  expandingProductKeys.value.delete(productKey)
}

function animateProductExpansion(productKey) {
  clearProductTransition(productKey)
  expandingProductKeys.value.add(productKey)
  productTransitionTimers.set(
    productKey,
    setTimeout(() => {
      expandingProductKeys.value.delete(productKey)
      productTransitionTimers.delete(productKey)
    }, productTransitionDuration),
  )
}

function animateProductCollapse(row) {
  const productKey = row.id
  clearProductTransition(productKey)
  collapsingProductKeys.value.add(productKey)
  productTransitionTimers.set(
    productKey,
    setTimeout(() => {
      configTableRef.value?.toggleRowExpansion(row, false)
      collapsingProductKeys.value.delete(productKey)
      productTransitionTimers.delete(productKey)
    }, productTransitionDuration),
  )
}

watch(inventoryRows, (groups) => {
  const currentKeys = new Set(groups.map((row) => row.id))
  const expandedKeys = new Set(expandedProductKeys.value.filter((key) => currentKeys.has(key)))
  for (const group of groups) {
    if (!knownProductKeys.has(group.id)) expandedKeys.add(group.id)
  }
  knownProductKeys = currentKeys
  expandedProductKeys.value = [...expandedKeys]
})

function handleExpandChange(row, expanded) {
  if (!row.isProductGroup) return
  const keys = new Set(expandedProductKeys.value)
  if (expanded) keys.add(row.id)
  else keys.delete(row.id)
  expandedProductKeys.value = [...keys]
  if (expanded) animateProductExpansion(row.id)
}

function handleCellClick(row, column) {
  if (!row.isProductGroup || column.property !== 'product') return

  if (collapsingProductKeys.value.has(row.id)) {
    clearProductTransition(row.id)
    animateProductExpansion(row.id)
    return
  }

  const isExpanded = expandedProductKeys.value.includes(row.id)
  if (isExpanded) {
    animateProductCollapse(row)
    return
  }

  configTableRef.value?.toggleRowExpansion(row, true)
}

function getCellClassName({ row, column }) {
  return row.isProductGroup && column.property === 'product' ? 'product-cell-clickable' : ''
}

function getRowClassName({ row }) {
  return [
    row.isProductGroup ? 'product-group-row' : 'product-color-row',
    collapsingProductKeys.value.has(`product:${row.product}`) ? 'product-group-collapsing' : '',
    expandingProductKeys.value.has(`product:${row.product}`) ? 'product-group-expanding' : '',
    !row.isProductGroup && row.id === selectedRowId.value ? 'inventory-row-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function handleRowClick(row) {
  selectedRowId.value = row.isProductGroup ? null : row.id
}
</script>

<template>
  <main class="config-page">
    <div class="config-content">
      <PanelNavigation />

      <header v-if="examplePanel" class="config-heading">
        <div>
          <h1>{{ configLabel }}</h1>
          <p>{{ panelDescription }}</p>
        </div>
      </header>

      <section class="rule-config-section" aria-labelledby="rule-config-title">
        <div class="rule-config-heading">
          <h2 id="rule-config-title">规则与系数配置</h2>
          <span class="rule-config-hint">
            规则之间互相独立：一个 SKU 只能命中一条规则，都不命中时归「默认规则」；规则内按热度因子打 S/A/B/C，达到档位条件即为该热度档。
          </span>
        </div>

        <div class="rule-tabs" role="tablist" aria-label="规则">
          <button
            v-for="rule in configDraft.rules"
            :key="rule.id"
            type="button"
            role="tab"
            class="rule-tab"
            :class="{
              'rule-tab--active': rule.id === activeRule?.id,
              'rule-tab--default': rule.isDefault,
            }"
            :aria-selected="rule.id === activeRule?.id"
            @click="selectedRuleId = rule.id"
          >
            <span class="rule-tab__name">{{ rule.name }}</span>
            <span v-if="distribution" class="rule-tab__count">
              {{ ruleHitCount(rule.name) ?? 0 }}
            </span>
          </button>
          <ElButton size="small" text class="rule-tab-add" @click="addRule">＋ 新增规则</ElButton>
        </div>

        <div
          v-if="activeRule"
          :key="`${activeRule.id}-${draftVersion}`"
          class="rule-card"
        >
          <div class="rule-card__heading">
            <ElInput
              v-model="activeRule.name"
              size="small"
              class="rule-name-input"
              aria-label="规则名称"
            />
            <span v-if="activeRule.isDefault" class="rule-card__badge">兜底：无条件命中</span>
            <span v-else class="rule-card__badge rule-card__badge--muted">
              {{
                activeRule.factors.length
                  ? `命中 ${ruleHitCount(activeRule.name) ?? '--'} 个 SKU`
                  : '未配置规则因子，暂不参与匹配'
              }}
            </span>
            <span class="rule-card__spacer" />
            <ElButton
              size="small"
              :type="pendingRuleDeleteId === activeRule.id ? 'danger' : 'default'"
              :plain="pendingRuleDeleteId === activeRule.id"
              :text="pendingRuleDeleteId !== activeRule.id"
              :disabled="activeRule.isDefault"
              class="rule-delete-button"
              @click="requestRemoveRule(activeRule)"
            >
              {{ pendingRuleDeleteId === activeRule.id ? '确认删除？' : '删除规则' }}
            </ElButton>
          </div>

          <div v-if="!activeRule.isDefault" class="rule-block">
            <div class="rule-block__heading">
              <h3>① 规则因子</h3>
              <span class="rule-block__hint">全部条件同时满足才算命中；同字段可加多条表达区间</span>
              <StockingFieldPicker
                label="＋ 添加条件"
                :used-fields="usedFactorFields(activeRule)"
                @select="addRuleFactor"
              />
            </div>

            <div v-if="activeRule.factors.length" class="rule-factor-list">
              <div
                v-for="(factor, index) in activeRule.factors"
                :key="`${factor.field}-${index}`"
                class="rule-factor-row"
              >
                <span class="rule-factor-row__label">{{ getFieldLabel(factor.field) }}</span>
                <ElSelect v-model="factor.operator" size="small" class="rule-factor-row__operator">
                  <ElOption
                    v-for="operator in operatorOptions(factor.field)"
                    :key="operator.value"
                    :label="operator.label"
                    :value="operator.value"
                  />
                </ElSelect>
                <ElSelect
                  v-if="isEnumField(factor.field)"
                  v-model="factor.value"
                  size="small"
                  class="rule-factor-row__value"
                >
                  <ElOption
                    v-for="option in getFieldMeta(factor.field).options"
                    :key="option"
                    :label="option"
                    :value="option"
                  />
                </ElSelect>
                <ElInput
                  v-else-if="isTextField(factor.field)"
                  v-model="factor.value"
                  size="small"
                  class="rule-factor-row__value"
                  placeholder="精确匹配"
                />
                <ElInputNumber
                  v-else
                  v-model="factor.value"
                  :controls="false"
                  size="small"
                  class="rule-factor-row__value"
                />
                <ElButton
                  size="small"
                  text
                  type="danger"
                  class="rule-row-remove"
                  aria-label="移除条件"
                  @click="removeRuleFactor(index)"
                >
                  <ElIcon><Delete /></ElIcon>
                </ElButton>
              </div>
            </div>
            <p v-else class="rule-block__empty">尚未配置条件，该规则不参与匹配。</p>
          </div>

          <div class="rule-block">
            <div class="rule-block__heading">
              <h3>② 热度因子与评分标准</h3>
              <span class="rule-block__hint">
                满足最高等级即取该等级；未达 C 阈值、缺值或未配置阈值记 Z
              </span>
              <StockingFieldPicker
                label="＋ 添加因子"
                :used-fields="usedGradeFields(activeRule)"
                numeric-only
                @select="addGradeField"
              />
            </div>

            <div v-if="usedGradeFields(activeRule).length" class="grade-table">
              <div class="grade-table__head">
                <span>因子</span>
                <span v-for="grade in GRADE_KEYS" :key="grade">{{ grade }} ≥</span>
                <span />
              </div>
              <div
                v-for="field in usedGradeFields(activeRule)"
                :key="field"
                class="grade-table__row"
              >
                <span class="grade-table__label">{{ getFieldLabel(field) }}</span>
                <ElInputNumber
                  v-for="grade in GRADE_KEYS"
                  :key="grade"
                  v-model="activeRule.grades[field][grade]"
                  :controls="false"
                  size="small"
                  class="grade-table__input"
                  :aria-label="`${getFieldLabel(field)} ${grade} 阈值`"
                />
                <ElButton
                  size="small"
                  text
                  type="danger"
                  class="rule-row-remove"
                  aria-label="移除热度因子"
                  @click="removeGradeField(field)"
                >
                  <ElIcon><Delete /></ElIcon>
                </ElButton>
              </div>
            </div>
            <p v-else class="rule-block__empty">尚未启用热度因子，所有 SKU 将记为 Z。</p>
          </div>

          <div class="rule-block">
            <div class="rule-block__heading">
              <h3>③ 热度档与系数</h3>
              <span class="rule-block__hint">
                按顺序取第一个满足条件的档位，默认档固定兜底；系数单位为周
              </span>
              <ElButton size="small" text class="rule-block__add" @click="addTier">
                ＋ 添加档位
              </ElButton>
            </div>

            <div class="tier-list">
              <div
                v-for="tier in activeRule.tiers"
                :key="tier.id"
                class="tier-card"
                :class="{ 'tier-card--default': tier.isDefault }"
              >
                <div class="tier-card__heading">
                  <ElInput
                    v-model="tier.name"
                    size="small"
                    class="tier-name-input"
                    aria-label="档位名称"
                  />
                  <span v-if="tier.isDefault" class="tier-card__badge">无条件兜底</span>
                  <span v-else class="tier-card__badge tier-card__badge--muted">
                    命中 {{ tierHitCount(activeRule.name, tier.name) ?? 0 }} 个
                  </span>
                  <span class="tier-card__spacer" />
                  <template v-if="!tier.isDefault">
                    <ElButton size="small" text @click="moveTier(tier, -1)">上移</ElButton>
                    <ElButton size="small" text @click="moveTier(tier, 1)">下移</ElButton>
                    <ElButton size="small" text @click="copyPreviousCoefficients(tier)">
                      沿用上档系数
                    </ElButton>
                    <ElButton size="small" text type="danger" @click="removeTier(tier)">
                      <ElIcon><Delete /></ElIcon>
                    </ElButton>
                  </template>
                </div>

                <div v-if="!tier.isDefault" class="tier-conditions">
                  <div
                    v-for="(condition, index) in tier.conditions"
                    :key="index"
                    class="tier-condition"
                  >
                    <ElSelect v-model="condition.grade" size="small" class="tier-condition__grade">
                      <ElOption
                        v-for="grade in ALL_GRADES"
                        :key="grade"
                        :label="grade"
                        :value="grade"
                      />
                    </ElSelect>
                    <ElSelect
                      v-model="condition.operator"
                      size="small"
                      class="tier-condition__operator"
                    >
                      <ElOption
                        v-for="operator in COMPARE_OPERATORS"
                        :key="operator.value"
                        :label="operator.label"
                        :value="operator.value"
                      />
                    </ElSelect>
                    <ElInputNumber
                      v-model="condition.count"
                      :min="0"
                      :max="factorCountOf(activeRule)"
                      :controls="false"
                      size="small"
                      class="tier-condition__count"
                    />
                    <span class="tier-condition__unit">个</span>
                    <ElButton
                      size="small"
                      text
                      type="danger"
                      class="rule-row-remove"
                      aria-label="移除条件"
                      @click="removeTierCondition(tier, index)"
                    >
                      <ElIcon><Delete /></ElIcon>
                    </ElButton>
                  </div>
                  <ElButton
                    size="small"
                    text
                    class="rule-block__add"
                    @click="addTierCondition(tier)"
                  >
                    ＋ 添加条件
                  </ElButton>
                </div>

                <div class="tier-coefficients">
                  <div v-for="category in CATEGORIES" :key="category" class="tier-coefficient-row">
                    <span class="tier-coefficient-row__category">{{ category }}</span>
                    <label
                      v-for="coefficient in COEFFICIENT_KEYS"
                      :key="coefficient.key"
                      class="tier-coefficient-row__item"
                    >
                      <span>{{ coefficient.label }}</span>
                      <ElInputNumber
                        v-model="tier.coefficients[category][coefficient.key]"
                        :min="0"
                        :step="0.5"
                        :precision="1"
                        :controls="false"
                        size="small"
                        class="tier-coefficient-row__input"
                        :aria-label="`${category}${coefficient.label}系数`"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="validation.errors.length || validation.warnings.length"
            class="rule-validation"
          >
            <p
              v-for="error in validation.errors"
              :key="error.message"
              class="rule-validation__error"
            >
              ✕ {{ error.message }}
            </p>
            <p
              v-for="warning in validation.warnings"
              :key="warning.message"
              class="rule-validation__warning"
            >
              ! {{ warning.message }}
            </p>
          </div>
        </div>

        <div class="config-actions">
          <span class="config-dirty">{{ configDirty ? '有未保存的修改' : '' }}</span>
          <ElButton
            size="small"
            :disabled="!canUndo"
            title="撤销上一步（Ctrl+Z）"
            @click="undo"
          >
            撤销
          </ElButton>
          <ElButton size="small" :disabled="!canRedo" title="重做（Ctrl+Shift+Z）" @click="redo">
            重做
          </ElButton>
          <ElButton size="small" :disabled="!configDirty" @click="discardChanges">重置</ElButton>
          <ElButton size="small" @click="downloadConfig">导出配置</ElButton>
          <ElButton size="small" @click="restoreDefaults">恢复默认</ElButton>
          <ElButton size="small" type="primary" :disabled="!configDirty" @click="confirmConfig">
            确定
          </ElButton>
        </div>
      </section>

      <div class="config-table-heading">
        <h2>备货详情</h2>
        <span class="config-record-count">{{ inventoryLeafRows.length }} 条库存记录</span>
      </div>

      <ElTable
        ref="configTableRef"
        class="config-table"
        :data="configTableRows"
        row-key="id"
        :expand-row-keys="configFlat ? [] : expandedProductKeys"
        :tree-props="{ children: 'children' }"
        :cell-class-name="getCellClassName"
        :row-class-name="getRowClassName"
        @expand-change="handleExpandChange"
        @cell-click="handleCellClick"
        @row-click="handleRowClick"
        border
        table-layout="auto"
      >
        <ElTableColumn label="商品" align="center">
          <ElTableColumn prop="product" label="品名" align="center">
            <template #default="{ row }">
              <span v-if="row.isProductGroup" class="config-product-name">{{ row.product }}</span>
              <span v-else class="config-product-text" :title="row.product">
                {{ row.product }}
              </span>
            </template>
          </ElTableColumn>
          <ElTableColumn prop="color" label="颜色" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-color-text" :title="row.color">
                {{ row.color }}
              </span>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="信息" align="center">
          <ElTableColumn label="规则" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-heat-text">{{ row.ruleName }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn label="热度" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-heat-text">{{ row.tierName }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn label="等级" align="center">
            <template #default="{ row }">
              <span
                v-if="!row.isProductGroup"
                class="config-heat-text"
                title="各热度因子等级"
              >{{ row.gradeSummary || '--' }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn label="色彩" align="center">
            <template #default="{ row }">
              <span v-if="!row.isProductGroup" class="config-color-text" :title="row.category">
                {{ row.category }}
              </span>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="备货策略" align="center">
          <ElTableColumn label="红线库存" align="center">
            <template #default="{ row }">
              {{ formatQuantity(row.redLineStock) }}
            </template>
          </ElTableColumn>
          <ElTableColumn label="正常库存" align="center">
            <template #default="{ row }">{{ formatQuantity(row.normalStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="峰值库存" align="center">
            <template #default="{ row }">{{ formatQuantity(row.peakStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="系数" align="center">
            <template #default="{ row }">
              <span
                v-if="!row.isProductGroup"
                :title="row.strategyAvailable ? '红线 / 正常 / 峰值' : row.strategyIssue"
              >{{ formatFactors(row) }}</span>
            </template>
          </ElTableColumn>
        </ElTableColumn>
      </ElTable>

      <div v-if="configPageCount > 1" class="config-pager">
        <ElButton size="small" :disabled="configPage <= 1" @click="configPage -= 1">
          上一页
        </ElButton>
        <span class="config-pager-info">第 {{ configPage }} / {{ configPageCount }} 页</span>
        <ElButton size="small" :disabled="configPage >= configPageCount" @click="configPage += 1">
          下一页
        </ElButton>
      </div>
    </div>
  </main>
</template>

<style scoped>
.config-page {
  min-height: 100vh;
  padding: 12px;
  color: var(--industrial-text);
  background: var(--industrial-page);
}

.config-content {
  width: 100%;
  max-width: 100%;
  margin: 0 auto;
  padding: 0 12px;
  box-sizing: border-box;
}

.config-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.config-heading h1 {
  margin: 0 0 4px;
  font-size: 20px;
}

.config-heading p {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 13px;
}

.rule-config-section {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  background: var(--industrial-surface);
}

.rule-config-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 8px;
}

.rule-config-heading h2 {
  margin: 0;
  font-size: 15px;
}

.rule-config-hint {
  flex: 1 1 320px;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.6;
}

.rule-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--industrial-grid-light);
}

.rule-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--industrial-grid);
  border-radius: 14px;
  color: var(--industrial-text);
  background: var(--industrial-page);
  font-size: 12px;
  cursor: pointer;
}

.rule-tab--default {
  border-style: dashed;
}

.rule-tab--active {
  color: #fff;
  background: var(--industrial-primary);
  border-color: var(--industrial-primary);
}

.rule-tab__count {
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.08);
  font-size: 11px;
}

.rule-tab-add {
  padding: 0 6px;
  color: var(--industrial-primary);
}

.rule-card {
  margin-top: 10px;
}

.rule-card__heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.rule-name-input {
  width: 160px;
}

.rule-card__badge {
  padding: 1px 8px;
  border-radius: 10px;
  color: var(--industrial-primary);
  background: var(--industrial-header);
  font-size: 11px;
}

.rule-card__badge--muted {
  color: var(--industrial-muted);
}

.rule-card__spacer,
.tier-card__spacer {
  flex: 1 1 auto;
}

/* 二次确认时文案变长，固定宽度避免按钮、布局抖动 */
.rule-delete-button {
  min-width: 92px;
}

.rule-block {
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
  background: var(--industrial-page);
}

.rule-block__heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 6px;
}

.rule-block__heading h3 {
  margin: 0;
  font-size: 13px;
}

.rule-block__hint {
  color: var(--industrial-muted);
  font-size: 11px;
}

.rule-block__add {
  padding: 0;
  color: var(--industrial-primary);
}

.rule-block__empty {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
}

.rule-factor-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rule-factor-row {
  display: grid;
  grid-template-columns: 76px 72px minmax(0, 200px) 24px;
  align-items: center;
  gap: 6px;
}

.rule-factor-row__label {
  font-size: 12px;
}

.rule-factor-row__value {
  width: 100%;
}

.rule-row-remove {
  padding: 0;
  color: var(--industrial-danger);
}

.grade-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.grade-table__head,
.grade-table__row {
  display: grid;
  grid-template-columns: 88px repeat(4, minmax(0, 1fr)) 24px;
  align-items: center;
  gap: 6px;
}

.grade-table__head {
  color: var(--industrial-muted);
  font-size: 11px;
}

.grade-table__label {
  font-size: 12px;
}

.grade-table__input {
  width: 100%;
}

.tier-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tier-card {
  padding: 8px 10px;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  background: var(--industrial-surface);
}

.tier-card--default {
  background: var(--industrial-header);
}

.tier-card__heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.tier-name-input {
  width: 140px;
}

.tier-card__badge {
  padding: 1px 8px;
  border-radius: 10px;
  color: var(--industrial-primary);
  background: rgba(0, 0, 0, 0.04);
  font-size: 11px;
}

.tier-card__badge--muted {
  color: var(--industrial-muted);
}

.tier-conditions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.tier-condition {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
  background: var(--industrial-page);
}

.tier-condition__grade {
  width: 60px;
}

.tier-condition__operator {
  width: 64px;
}

.tier-condition__count {
  width: 64px;
}

.tier-condition__unit {
  color: var(--industrial-muted);
  font-size: 11px;
}

.tier-coefficients {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tier-coefficient-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tier-coefficient-row__category {
  width: 32px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.tier-coefficient-row__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.tier-coefficient-row__input {
  width: 76px;
}

.rule-validation {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 3px;
  background: var(--industrial-header);
  font-size: 12px;
  line-height: 1.7;
}

.rule-validation__error {
  margin: 0;
  color: var(--industrial-out-of-stock, #b44242);
}

.rule-validation__warning {
  margin: 0;
  color: var(--industrial-muted);
}

.config-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--industrial-grid-light);
}

.config-dirty {
  margin-right: auto;
  color: var(--industrial-muted);
  font-size: 12px;
}

.config-table-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.config-table-heading h2 {
  margin: 0;
  font-size: 15px;
}

.config-record-count {
  color: var(--industrial-muted);
  font-size: 13px;
}

.config-table {
  width: 100%;
}

.config-product-name {
  font-weight: 600;
}

.config-product-text,
.config-color-text,
.config-heat-text {
  display: inline-block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 10px;
}

.config-pager-info {
  color: var(--industrial-muted);
  font-size: 12px;
}

:deep(.product-cell-clickable) {
  cursor: pointer;
}

:deep(.product-group-row) {
  background: var(--industrial-header);
}

:deep(.inventory-row-selected) {
  background: rgba(47, 59, 67, 0.06);
}
</style>
