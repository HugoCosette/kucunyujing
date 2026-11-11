<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ElButton,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTable,
  ElTableColumn,
  ElTooltip,
} from 'element-plus'
import { Delete } from '@element-plus/icons-vue'
import PanelNavigation from '@/components/PanelNavigation.vue'
import ScoringSettings from '@/components/ScoringSettings.vue'
import SpuGradeSettings from '@/components/SpuGradeSettings.vue'
import {
  CATEGORIES,
  COEFFICIENT_KEYS,
  MODE_METRICS,
  MANUAL_BEHAVIORS,
  SALES_WINDOW_DEFAULTS,
  DEFAULT_MANUAL_MODE_NAMES,
  createDefaultManualMode,
  expandMonthWeights,
  exportConfigFile,
  findBaselineMonth,
  findDanglingSkuIds,
  importConfigFile,
  normalizeConfig,
  normalizeScoring,
  normalizeSpuGrades,
  summarizeEvaluation,
  validateConfig,
} from '@/stocking'
import { DEFAULT_PANEL_KEY, getPanelConfigLabel, isExamplePanel } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { useStockingConfigStore } from '@/stores/stocking'

// 主面板与示例配置共用同一份备货配置（src/stocking/config.json），改哪边都一样。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const WEIGHT_FIELDS = [
  { key: 'm1', label: '近 1 个月' },
  { key: 'm3', label: '近 3 个月月均' },
  { key: 'm12', label: '近 12 个月月均' },
]

// 手动模式的行为标签统一从 MANUAL_BEHAVIORS 取，避免多处硬编码。
const MANUAL_MODE_BEHAVIOR_LABELS = Object.fromEntries(
  MANUAL_BEHAVIORS.map((behavior) => [behavior.value, behavior.label]),
)

const inventoryStore = useInventoryStore(props.panelKey)
const stockingStore = useStockingConfigStore()
const inventoryItems = inventoryStore.inventoryItems
const examplePanel = isExamplePanel(props.panelKey)
const configLabel = getPanelConfigLabel(props.panelKey)
const panelDescription = examplePanel
  ? '示例配置：与主面板共用同一份备货配置，仅供对照演示。'
  : '维护模式判定与备货系数；修改会写回 src/stocking/config.json。'

// —— 配置草稿 ——
const configDraft = ref(normalizeConfig(stockingStore.config))
// 策略层：自动策略（5 个固定模式）与手动策略（手动模式 + SKU 清单）。
// 注意：这里直接读 configDraft 的 strategies，不经过 normalizeConfig，
// 否则每次读取都会生成新对象，v-model 绑定的输入框在失焦时会被重置。
const activeStrategy = ref('auto')
const autoStrategy = computed(
  () => configDraft.value.strategies?.find((strategy) => strategy.behavior === 'auto') ?? null,
)
const autoModes = computed(() => autoStrategy.value?.modes ?? [])
const manualStrategy = computed(
  () => configDraft.value.strategies?.find((strategy) => strategy.behavior === 'manual') ?? null,
)
const manualModes = computed(() => manualStrategy.value?.modes ?? [])
const activeModeKey = ref(autoModes.value[0]?.key ?? '')
const activeMode = computed(
  () =>
    autoModes.value.find((mode) => mode.key === activeModeKey.value) ??
    autoModes.value[0] ??
    null,
)
const configDirty = computed(
  () =>
    JSON.stringify(configDraft.value) !== JSON.stringify(normalizeConfig(stockingStore.config)),
)
const validation = computed(() => validateConfig(configDraft.value))

// —— 销量权重 ——
const salesWeights = computed(
  () => configDraft.value.salesWindow?.weights ?? { ...SALES_WINDOW_DEFAULTS },
)
const weightsTotal = computed(
  () => salesWeights.value.m1 + salesWeights.value.m3 + salesWeights.value.m12,
)
const weightsBalanced = computed(() => Math.abs(weightsTotal.value - 1) <= 0.001)
const monthWeights = computed(() => expandMonthWeights(salesWeights.value))
// 12 个月权重默认收起，标题行先给一行摘要，展开才看明细。
const weightsOpen = ref(false)

function formatPercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : '—'
}

function shortPercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${Number((number * 100).toFixed(2))}%` : '—'
}

const weightsSummary = computed(
  () =>
    `${shortPercent(salesWeights.value.m1)} / ${shortPercent(salesWeights.value.m3)} / ${shortPercent(salesWeights.value.m12)} · 合计 ${shortPercent(weightsTotal.value)}`,
)
const weightsIntro =
  '加权月销量 = 近 1 个月 × 权重 + 近 3 个月月均 × 权重 + 近 12 个月月均 × 权重；' +
  '只影响「够卖多少天」的系数比较，不参与模式判定。三档权重之和应为 100%。'
const strategyIntro = computed(() =>
  activeStrategy.value === 'auto'
    ? '自动策略按「月均条数」判定 5 个模式：热销 / 常规 按「够卖多少天」比较系数，按量按库存公斤数比较，尾货 / 滞销 仅标注不参与计算。判定从上一个模式往下依次进行，先命中先归属。'
    : '手动策略是人对单个 SKU 的长期决定：在 SKU 弹窗里切到手动模式即可加入清单，跨导入与刷新保留，不写进配置方案文件。',
)

function resetWeights() {
  beforeStructuralChange()
  configDraft.value.salesWindow = { weights: { ...SALES_WINDOW_DEFAULTS } }
}

// —— 健康度评分 ——
// 评分规则挂在方案里的 config.scoring 上；设置面板（摘要 + 编辑弹窗）整体由 ScoringSettings 组件负责。
const scoring = computed(() => normalizeScoring(configDraft.value.scoring))

function applyScoring(next) {
  beforeStructuralChange()
  configDraft.value.scoring = normalizeScoring(next)
  ElMessage.success('评分规则已更新，点「确定」后写入配置')
}

// —— SPU 分级 ——
// 分级规则挂在 config.spuGrades 上，卡片（摘要 + 编辑弹窗）由 SpuGradeSettings 组件承载。
const spuGrades = computed(() => normalizeSpuGrades(configDraft.value.spuGrades))

function applySpuGrades(next) {
  beforeStructuralChange()
  configDraft.value.spuGrades = normalizeSpuGrades(next)
  ElMessage.success('SPU 分级已更新，点「确定」后写入配置')
}

// 每个品名的月均条数合计：只用于卡片里预览各等级命中多少个 SPU。
const spuMonthlyTotals = computed(() => {
  const totals = new Map()
  for (const item of inventoryItems) {
    if (!Number.isFinite(item.monthlyAvgCount)) {
      if (!totals.has(item.product)) totals.set(item.product, null)
      continue
    }
    totals.set(item.product, (totals.get(item.product) ?? 0) + item.monthlyAvgCount)
  }
  return [...totals.values()]
})

// —— 配置方案（Profile）——
const profiles = computed(() => stockingStore.profiles)
const activeProfileId = computed(() => stockingStore.activeProfileId)
const activeProfileName = computed(() => stockingStore.activeProfile?.name ?? '')
// 下拉单独用可回退的本地值：取消切换时把它拨回当前方案，避免控件停留在未生效的选项上。
const profileSelection = ref(activeProfileId.value)
watch(activeProfileId, (profileId) => {
  profileSelection.value = profileId
})

// —— 草稿撤销 / 重做 ——
// 历史只覆盖「未保存的草稿」：改动前存一份 JSON 快照，连续输入合并成一步，
// 结构性操作（改权重、改阈值等）各自单独成步。
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

function beforeStructuralChange() {
  commitPendingHistory()
}

watch(
  configDraft,
  () => {
    if (restoringDraft) return

    const current = snapshotDraft()
    if (current === baseline && pendingBase === null) return
    if (pendingBase === null) pendingBase = baseline
    pendingHistory.value = true

    if (historyTimer) clearTimeout(historyTimer)
    historyTimer = window.setTimeout(commitPendingHistory, HISTORY_DEBOUNCE)
  },
  { deep: true },
)

function applySnapshot(json) {
  restoringDraft = true
  configDraft.value = normalizeConfig(JSON.parse(json))
  if (!autoModes.value.some((mode) => mode.key === activeModeKey.value)) {
    activeModeKey.value = autoModes.value[0]?.key ?? ''
  }
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

// 「近 N 个月」的基准月：数据里最后一个有销量的月份。
const baselineMonth = computed(() => {
  const month = inventoryStore.salesSheet?.baselineMonth
  return Number.isFinite(month) && month > 0 ? month : findBaselineMonth(inventoryItems)
})

// 模式命中分布：配置改动后延迟重算，避免逐键全量评估。
const distribution = ref(null)
let distributionTimer = 0

function scheduleDistribution() {
  if (distributionTimer) clearTimeout(distributionTimer)
  distributionTimer = window.setTimeout(() => {
    distributionTimer = 0
    distribution.value = summarizeEvaluation(inventoryItems, configDraft.value, {
      manualOverrides: stockingStore.manualOverrides,
      baselineMonth: baselineMonth.value,
    })
  }, 250)
}

watch(configDraft, scheduleDistribution, { deep: true })
scheduleDistribution()

onBeforeUnmount(() => {
  if (distributionTimer) clearTimeout(distributionTimer)
  if (historyTimer) clearTimeout(historyTimer)
  document.removeEventListener('keydown', handleHistoryShortcut)
})

function modeHitCount(modeKey) {
  return distribution.value?.counts.get(modeKey) ?? null
}

function exclusiveHitCount(modeKey) {
  return distribution.value?.exclusiveCounts.get(modeKey) ?? null
}

const METRIC_BADGES = { days: '按天数', stock: '按公斤', none: '仅标注' }

function metricBadge(mode) {
  if (!mode) return ''
  return METRIC_BADGES[mode.metric] ?? METRIC_BADGES.none
}

function metricTitle(mode) {
  if (!mode?.participates) return '该模式不参与计算，只在主面板「模式」列标注'
  const metric = MODE_METRICS[mode.metric] ?? MODE_METRICS.none
  return `${metric.hint}（单位：${metric.label}）`
}

function coefficientUnit(mode) {
  if (!mode?.participates) return '—'
  return mode.metric === 'days' ? '天' : '条'
}

function coefficientKinds(mode) {
  if (!mode?.coefficients) return []
  return Object.keys(mode.coefficients).filter((kind) => mode.coefficients[kind])
}

function thresholdHint(mode) {
  if (!mode) return ''
  const { from, to } = mode.range
  if (from === null && to === null) return '不限区间：任何月均条数都会归入该模式'
  if (to === null) return `月均条数 ≥ ${from} 归入该模式（更靠前的模式先命中）`
  if (from === null) return `月均条数 ≤ ${to} 归入该模式（更靠前的模式先命中）`
  return `${from} ≤ 月均条数 ≤ ${to} 归入该模式（更靠前的模式先命中）`
}

// —— 手动策略 ——
const manualSelection = ref([])
const itemBySkuId = computed(() => {
  const map = new Map()
  for (const item of inventoryItems) {
    const key = String(item?.skuId ?? '').trim()
    if (key) map.set(key, item)
  }
  return map
})

const manualRows = computed(() => {
  const modes = new Map(manualModes.value.map((mode) => [mode.id, mode]))
  return Object.entries(stockingStore.manual?.items ?? {})
    .map(([skuId, entry]) => ({
      skuId,
      entry,
      mode: modes.get(entry.modeId) ?? null,
      item: itemBySkuId.value.get(skuId) ?? null,
    }))
    .filter((row) => row.item)
})

const danglingSkuIds = computed(() =>
  findDanglingSkuIds(stockingStore.manual, inventoryItems),
)

// 内置的三种行为必须各保留一个，其余自定义模式可删。
function isRequiredManualMode(mode) {
  if (!mode) return true
  const sameBehavior = manualModes.value.filter((entry) => entry.behavior === mode.behavior)
  return sameBehavior.length <= 1
}

function nextManualModeName(behavior) {
  const base = DEFAULT_MANUAL_MODE_NAMES[behavior] ?? '自定系数模式'
  const used = new Set(manualModes.value.map((mode) => mode.name))
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

function addManualMode() {
  if (!manualStrategy.value) return
  beforeStructuralChange()
  manualStrategy.value.modes.push(
    createDefaultManualMode({ behavior: 'custom', name: nextManualModeName('custom') }),
  )
}

function removeManualMode(mode) {
  if (!manualStrategy.value || isRequiredManualMode(mode)) return
  const index = manualStrategy.value.modes.indexOf(mode)
  if (index < 0) return
  beforeStructuralChange()
  manualStrategy.value.modes.splice(index, 1)
}

// —— 手动策略：SKU 清单操作（直接写入手动清单文件，不经过配置草稿）——
async function updateManualRowMode(row, modeId) {
  const mode = manualModes.value.find((entry) => entry.id === modeId)
  if (!mode) return
  const entry = { modeId }
  if (mode.behavior === 'custom') {
    const source = row.entry.coefficients ?? mode.defaultCoefficients ?? {}
    entry.coefficients = {
      redLine: source.redLine ?? null,
      normal: source.normal ?? null,
      peak: source.peak ?? null,
    }
  }
  await stockingStore.setManualEntry(row.skuId, entry)
}

async function updateManualRowCoefficient(row, key, value) {
  const source = row.entry.coefficients ?? row.mode?.defaultCoefficients ?? {}
  await stockingStore.setManualEntry(row.skuId, {
    modeId: row.entry.modeId,
    coefficients: { ...source, [key]: value ?? null },
  })
}

async function clearManualRow(row) {
  await stockingStore.setManualEntry(row.skuId, null)
}

// 订单货模式在清单里只展示订单条数与订单明细，编辑在 SKU 弹窗里完成。
function orderRowsText(row) {
  const orders = row.entry.orders ?? []
  return orders.length ? `订单货：${orders.length} 单` : '订单货：待填写订单'
}

function orderRowsTitle(row) {
  const orders = row.entry.orders ?? []
  if (!orders.length) return '在 SKU 弹窗里为该 SKU 添加订单'
  return orders
    .map((order) => {
      const parts = [order.name || '未命名订单']
      if (order.factory) parts.push(`厂家：${order.factory}`)
      if (Number.isFinite(order.quantity)) parts.push(`数量：${order.quantity}`)
      if (order.note) parts.push(`备注：${order.note}`)
      return parts.join(' / ')
    })
    .join('\n')
}

async function clearManualSelection() {
  await stockingStore.removeManualEntries(manualSelection.value)
  manualSelection.value = []
}

async function clearDanglingEntries() {
  await stockingStore.removeManualEntries(danglingSkuIds.value)
}

// —— 配置方案 ——
function resetDraftFromStore() {
  configDraft.value = normalizeConfig(stockingStore.config)
  activeModeKey.value = autoModes.value[0]?.key ?? ''
  draftVersion.value += 1
  clearHistory()
}

async function confirmDiscardForProfile() {
  if (!configDirty.value) return true
  return ElMessageBox.confirm(
    '当前方案有未保存的修改，切换后将丢弃这些修改。是否继续？',
    '切换配置方案',
    { confirmButtonText: '继续', cancelButtonText: '取消', type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
}

async function switchProfile(profileId) {
  if (!profileId || profileId === activeProfileId.value) return
  if (!(await confirmDiscardForProfile())) {
    profileSelection.value = activeProfileId.value
    return
  }
  const saved = await stockingStore.selectProfile(profileId)
  resetDraftFromStore()
  ElMessage.success(`已切换到「${stockingStore.activeProfile?.name ?? ''}」`)
  return saved
}

async function duplicateProfile() {
  const name = await ElMessageBox.prompt('新方案名称', '复制配置方案', {
    confirmButtonText: '复制',
    cancelButtonText: '取消',
    inputValue: `${activeProfileName.value} 副本`,
    inputValidator: (value) => (String(value ?? '').trim() ? true : '名称不能为空'),
  })
    .then((result) => result.value)
    .catch(() => null)
  if (name === null) return

  if (configDirty.value) {
    const proceed = await ElMessageBox.confirm(
      '将以当前编辑中的草稿为准复制出新方案（草稿会一并保存）。是否继续？',
      '复制配置方案',
      { confirmButtonText: '继续', cancelButtonText: '取消', type: 'warning' },
    )
      .then(() => true)
      .catch(() => false)
    if (!proceed) return
    await stockingStore.apply(configDraft.value)
  }

  await stockingStore.duplicateProfile(name)
  resetDraftFromStore()
  ElMessage.success('已复制为新方案并切换')
}

async function renameProfile() {
  const name = await ElMessageBox.prompt('方案名称', '重命名配置方案', {
    confirmButtonText: '保存',
    cancelButtonText: '取消',
    inputValue: activeProfileName.value,
    inputValidator: (value) => (String(value ?? '').trim() ? true : '名称不能为空'),
  })
    .then((result) => result.value)
    .catch(() => null)
  if (name === null) return

  await stockingStore.renameProfile(activeProfileId.value, name)
  ElMessage.success('已重命名')
}

async function deleteProfile() {
  if (profiles.value.length <= 1) return
  const confirmed = await ElMessageBox.confirm(
    `删除配置方案「${activeProfileName.value}」？该方案的阈值与系数会一并删除。`,
    '删除配置方案',
    { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return

  await stockingStore.removeProfile(activeProfileId.value)
  resetDraftFromStore()
  ElMessage.success('已删除配置方案')
}

// 导出 / 导入都以整份方案文件为单位，导入会覆盖当前全部方案。
function currentProfileFile() {
  const active = stockingStore.activeProfile
  return {
    ...stockingStore.profileFile,
    profiles: stockingStore.profiles.map((profile) =>
      profile.id === active?.id ? { ...profile, config: configDraft.value } : profile,
    ),
  }
}

const importInputRef = ref(null)

function triggerImport() {
  importInputRef.value?.click()
}

async function handleImportFile(event) {
  const file = event.target?.files?.[0]
  if (event.target) event.target.value = ''
  if (!file) return

  let imported = null
  try {
    imported = importConfigFile(await file.text())
  } catch (error) {
    ElMessage.error('配置文件解析失败，请确认是导出的 JSON 文件')
    return
  }

  const confirmed = await ElMessageBox.confirm(
    `将导入 ${imported.profiles.length} 个配置方案，并覆盖当前全部方案。是否继续？`,
    '导入配置方案',
    { confirmButtonText: '导入', cancelButtonText: '取消', type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return

  await stockingStore.importProfiles(imported)
  resetDraftFromStore()
  ElMessage.success('已导入配置方案')
}

// —— 保存 / 放弃 / 恢复默认 ——
async function confirmConfig() {
  if (!validation.value.ok) {
    ElMessage.error(`还有 ${validation.value.errors.length} 处配置错误，请先修正`)
    return
  }

  const saved = await stockingStore.apply(configDraft.value)
  configDraft.value = normalizeConfig(saved.config)
  draftVersion.value += 1
  clearHistory()
  ElMessage.success(
    saved.written
      ? `「${activeProfileName.value}」已保存到 src/stocking/config.json`
      : `「${activeProfileName.value}」已保存到本地缓存（部署环境无法写源文件，可点击“导出方案”覆盖）`,
  )
}

function discardChanges() {
  resetDraftFromStore()
}

async function restoreDefaults() {
  const confirmed = await ElMessageBox.confirm(
    `恢复「${activeProfileName.value}」为内置默认配置并立即写回配置文件？当前方案的修改会丢失，其他方案不受影响。`,
    '恢复默认',
    { confirmButtonText: '恢复默认', cancelButtonText: '取消', type: 'warning' },
  )
    .then(() => true)
    .catch(() => false)
  if (!confirmed) return

  const saved = await stockingStore.restoreDefaults()
  configDraft.value = normalizeConfig(saved.config)
  activeModeKey.value = autoModes.value[0]?.key ?? ''
  draftVersion.value += 1
  clearHistory()
  ElMessage.success(`「${activeProfileName.value}」已恢复默认配置`)
}

function downloadConfig() {
  exportConfigFile(currentProfileFile())
  ElMessage.success('配置方案已导出，可覆盖 src/stocking/config.json')
}

// 「方案文件」下拉：导出 / 导入 / 恢复默认
function handleFileCommand(command) {
  if (command === 'export') downloadConfig()
  else if (command === 'import') triggerImport()
  else if (command === 'restore') restoreDefaults()
}
</script>

<template>
  <main class="config-page">
    <div class="config-content">
      <PanelNavigation />

      <div class="config-body">
        <header class="config-heading">
          <h1>{{ configLabel }}</h1>
          <p>{{ panelDescription }}</p>
        </header>

        <!-- 工作条：方案切换 + 保存状态 + 保存动作，滚动时吸顶 -->
        <div class="config-bar">
          <div class="config-bar__group">
            <span class="config-bar__label">配置方案</span>
            <ElTooltip content="每个方案独立保存阈值与系数；切换方案不影响其他方案。" placement="top">
              <span class="config-info">i</span>
            </ElTooltip>
            <ElSelect
              v-model="profileSelection"
              size="small"
              class="profile-bar__select"
              aria-label="配置方案"
              @change="switchProfile"
            >
              <ElOption
                v-for="profile in profiles"
                :key="profile.id"
                :label="profile.name"
                :value="profile.id"
              />
            </ElSelect>
            <ElButton size="small" @click="duplicateProfile">复制</ElButton>
            <ElButton size="small" @click="renameProfile">重命名</ElButton>
            <ElButton size="small" :disabled="profiles.length <= 1" @click="deleteProfile">
              删除
            </ElButton>
          </div>

          <div class="config-bar__group config-bar__group--end">
            <span class="config-bar__state" :class="{ 'config-bar__state--dirty': configDirty }">
              {{ configDirty ? '有未保存的修改' : '已保存' }}
            </span>
            <ElButton size="small" :disabled="!canUndo" title="回退上一步改动（Ctrl+Z）" @click="undo">
              撤销
            </ElButton>
            <ElButton
              size="small"
              :disabled="!canRedo"
              title="恢复刚撤销的改动（Ctrl+Shift+Z）"
              @click="redo"
            >
              重做
            </ElButton>
            <ElButton
              size="small"
              :disabled="!configDirty"
              title="放弃所有未保存的改动，回到上次保存的配置"
              @click="discardChanges"
            >
              放弃
            </ElButton>
            <ElDropdown trigger="click" @command="handleFileCommand">
              <ElButton size="small">方案文件</ElButton>
              <template #dropdown>
                <ElDropdownMenu>
                  <ElDropdownItem command="export">导出全部方案（JSON）</ElDropdownItem>
                  <ElDropdownItem command="import">导入方案文件</ElDropdownItem>
                  <ElDropdownItem command="restore" divided>当前方案恢复默认</ElDropdownItem>
                </ElDropdownMenu>
              </template>
            </ElDropdown>
            <ElButton size="small" type="primary" :disabled="!configDirty" @click="confirmConfig">
              确定
            </ElButton>
            <input
              ref="importInputRef"
              type="file"
              accept="application/json,.json"
              class="profile-import-input"
              @change="handleImportFile"
            />
          </div>
        </div>

        <section class="config-card config-card--open config-workspace">
          <div class="config-card__head">
            <div class="strategy-tabs" role="tablist" aria-label="策略">
              <button
                type="button"
                role="tab"
                class="strategy-tab"
                :class="{ 'strategy-tab--active': activeStrategy === 'auto' }"
                :aria-selected="activeStrategy === 'auto'"
                @click="activeStrategy = 'auto'"
              >
                自动策略
                <span class="strategy-tab__count">{{ autoModes.length }}</span>
              </button>
              <button
                type="button"
                role="tab"
                class="strategy-tab"
                :class="{ 'strategy-tab--active': activeStrategy === 'manual' }"
                :aria-selected="activeStrategy === 'manual'"
                @click="activeStrategy = 'manual'"
              >
                手动策略
                <span class="strategy-tab__count">{{ manualRows.length }}</span>
              </button>
            </div>

            <span class="config-workspace__hint">
              {{ activeStrategy === 'auto' ? '按「月均条数」从高到低判定' : '人为指定，跨导入保留' }}
            </span>
            <ElTooltip :content="strategyIntro" placement="top">
              <span class="config-info">i</span>
            </ElTooltip>
            <span class="config-card__spacer" />
          </div>

          <div v-if="activeStrategy === 'auto'" class="mode-workspace">
            <nav class="mode-list" aria-label="模式">
              <button
                v-for="mode in autoModes"
                :key="mode.key"
                type="button"
                class="mode-list__item"
                :class="{ 'mode-list__item--active': mode.key === activeMode?.key }"
                :aria-current="mode.key === activeMode?.key"
                @click="activeModeKey = mode.key"
              >
                <span class="mode-list__name">{{ mode.name }}</span>
                <span class="mode-list__count">{{ modeHitCount(mode.key) ?? 0 }}</span>
                <span class="mode-list__metric">{{ metricBadge(mode) }}</span>
              </button>
            </nav>

            <div v-if="activeMode" :key="`${activeMode.key}-${draftVersion}`" class="mode-editor">
              <div class="mode-editor__head">
                <ElInput
                  v-model="activeMode.name"
                  size="small"
                  class="rule-name-input"
                  aria-label="模式名称"
                />
                <ElTooltip :content="metricTitle(activeMode)" placement="top">
                  <span class="mode-editor__badge">{{ metricBadge(activeMode) }}</span>
                </ElTooltip>
                <span class="config-card__spacer" />
                <span class="mode-editor__badge mode-editor__badge--muted">
                  命中 {{ modeHitCount(activeMode.key) ?? '--' }} 个 SKU<template
                    v-if="activeMode.splitByCustomer"
                  >（专属品 {{ exclusiveHitCount(activeMode.key) ?? 0 }}）</template>
                </span>
              </div>

              <div class="mode-editor__row">
                <span class="mode-editor__label">月均条数</span>
                <ElInputNumber
                  v-model="activeMode.range.from"
                  :min="0"
                  :step="1"
                  :precision="2"
                  :controls="false"
                  :value-on-clear="null"
                  placeholder="不限"
                  size="small"
                  class="mode-threshold__input"
                  :aria-label="`${activeMode.name}的月均条数下界`"
                />
                <span class="mode-editor__tilde">~</span>
                <ElInputNumber
                  v-model="activeMode.range.to"
                  :min="0"
                  :step="1"
                  :precision="2"
                  :controls="false"
                  :value-on-clear="null"
                  placeholder="不限"
                  size="small"
                  class="mode-threshold__input"
                  :aria-label="`${activeMode.name}的月均条数上界`"
                />
                <span class="mode-editor__note">{{ thresholdHint(activeMode) }}</span>
              </div>

              <p v-if="!activeMode.participates" class="mode-editor__empty">
                该模式不参与计算，只在主面板「模式」列标注。
              </p>

              <template v-else>
                <div v-for="kind in coefficientKinds(activeMode)" :key="kind" class="coefficient-table">
                  <div class="coefficient-table__title">
                    {{ kind }}
                    <span class="coefficient-table__unit">单位：{{ coefficientUnit(activeMode) }}</span>
                  </div>
                  <div class="coefficient-table__head">
                    <span>色彩</span>
                    <span v-for="coefficient in COEFFICIENT_KEYS" :key="coefficient.key">
                      {{ coefficient.label }}
                    </span>
                  </div>
                  <div v-for="category in CATEGORIES" :key="category" class="coefficient-table__row">
                    <span class="coefficient-table__category">{{ category }}</span>
                    <ElInputNumber
                      v-for="coefficient in COEFFICIENT_KEYS"
                      :key="coefficient.key"
                      v-model="activeMode.coefficients[kind][category][coefficient.key]"
                      :min="0"
                      :step="1"
                      :precision="1"
                      :controls="false"
                      size="small"
                      class="coefficient-table__input"
                      :aria-label="`${activeMode.name} ${kind} ${category} ${coefficient.label}系数`"
                    />
                  </div>
                </div>
                <p v-if="activeMode.splitByCustomer" class="mode-editor__empty">
                  专属品（累计客户 = 1）不设系数，只在主面板标注。
                </p>

                <div v-if="activeMode.key === 'bulk'" class="bulk-score-rules">
                  <div class="coefficient-table__title">
                    健康度判定
                    <span class="coefficient-table__unit">按量模式 · SKU 弹窗里的 2 项判定</span>
                  </div>
                  <div class="mode-editor__row">
                    <span class="mode-editor__label">本次进销比</span>
                    <ElInputNumber
                      v-model="activeMode.healthScoring.ratio.normalFrom"
                      :min="0"
                      :step="1"
                      :precision="1"
                      :controls="false"
                      size="small"
                      class="mode-threshold__input"
                      aria-label="本次进销比正常区间下界"
                    />
                    <span class="mode-editor__tilde">~</span>
                    <ElInputNumber
                      v-model="activeMode.healthScoring.ratio.normalTo"
                      :min="0"
                      :step="1"
                      :precision="1"
                      :controls="false"
                      size="small"
                      class="mode-threshold__input"
                      aria-label="本次进销比正常区间上界"
                    />
                    <span class="mode-editor__note">
                      % 为正常：低于下界低风险，高于上界高风险
                    </span>
                  </div>
                  <div class="mode-editor__row">
                    <span class="mode-editor__label">累积客户数</span>
                    <ElInputNumber
                      v-model="activeMode.healthScoring.customers.normalFrom"
                      :min="0"
                      :step="1"
                      :precision="0"
                      :controls="false"
                      size="small"
                      class="mode-threshold__input"
                      aria-label="累积客户数中风险区间下界"
                    />
                    <span class="mode-editor__tilde">~</span>
                    <ElInputNumber
                      v-model="activeMode.healthScoring.customers.normalTo"
                      :min="0"
                      :step="1"
                      :precision="0"
                      :controls="false"
                      size="small"
                      class="mode-threshold__input"
                      aria-label="累积客户数中风险区间上界"
                    />
                    <span class="mode-editor__note">
                      个为中风险：少于下界高风险，多于上界低风险
                    </span>
                  </div>
                </div>
              </template>

              <div v-if="validation.errors.length || validation.warnings.length" class="rule-validation">
                <p v-for="error in validation.errors" :key="error.message" class="rule-validation__error">
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
          </div>

          <div v-else class="manual-config">
            <div class="manual-block">
              <div class="manual-block__head">
                <h3>手动模式</h3>
                <ElTooltip
                  content="行为由系统提供（自定系数 / 排除 / 订单货），名称、说明与默认系数可自行调整；内置的三种行为各保留一个。"
                  placement="top"
                >
                  <span class="config-info">i</span>
                </ElTooltip>
                <span class="config-card__spacer" />
                <ElButton size="small" text class="config-card__action" @click="addManualMode">
                  ＋ 新增手动模式
                </ElButton>
              </div>

              <div class="manual-mode-list">
                <div class="manual-mode-row manual-mode-row--head">
                  <span>名称</span>
                  <span>行为</span>
                  <span>说明</span>
                  <span>红线</span>
                  <span>正常</span>
                  <span>峰值</span>
                  <span />
                </div>
                <div v-for="mode in manualModes" :key="mode.id" class="manual-mode-row">
                  <ElInput
                    v-model="mode.name"
                    size="small"
                    class="manual-mode-row__name"
                    aria-label="手动模式名称"
                  />
                  <span class="manual-mode-row__behavior">
                    {{ MANUAL_MODE_BEHAVIOR_LABELS[mode.behavior] ?? '自定系数' }}
                  </span>
                  <ElInput
                    v-model="mode.description"
                    size="small"
                    class="manual-mode-row__desc"
                    placeholder="说明（可选）"
                    aria-label="手动模式说明"
                  />
                  <template v-if="mode.behavior === 'custom'">
                    <ElInputNumber
                      v-for="coefficient in COEFFICIENT_KEYS"
                      :key="coefficient.key"
                      v-model="mode.defaultCoefficients[coefficient.key]"
                      :min="0"
                      :step="1"
                      :precision="1"
                      :controls="false"
                      size="small"
                      class="manual-mode-row__coefficient"
                      :aria-label="`${mode.name}默认${coefficient.label}系数（公斤）`"
                    />
                  </template>
                  <template v-else>
                    <span class="manual-mode-row__skip">不参与</span>
                    <span class="manual-mode-row__skip" />
                    <span class="manual-mode-row__skip" />
                  </template>
                  <ElButton
                    size="small"
                    text
                    type="danger"
                    class="rule-row-remove"
                    :disabled="isRequiredManualMode(mode)"
                    :title="isRequiredManualMode(mode) ? '内置行为必须保留一个' : '删除模式'"
                    @click="removeManualMode(mode)"
                  >
                    <ElIcon><Delete /></ElIcon>
                  </ElButton>
                </div>
              </div>
            </div>

            <div class="manual-block">
              <div class="manual-block__head">
                <h3>手动 SKU 清单</h3>
                <ElTooltip
                  content="在 SKU 弹窗里切换策略后会自动出现在这里；这里也可直接改模式、改系数或恢复自动。自定系数按「公斤」比较；排除 / 订单货不参与备货策略，订单明细在 SKU 弹窗里维护。"
                  placement="top"
                >
                  <span class="config-info">i</span>
                </ElTooltip>
                <span class="config-card__spacer" />
                <ElButton
                  size="small"
                  :disabled="manualSelection.length === 0"
                  @click="clearManualSelection"
                >
                  恢复自动（{{ manualSelection.length }}）
                </ElButton>
              </div>

              <p v-if="danglingSkuIds.length" class="manual-list__dangling">
                清单中有 {{ danglingSkuIds.length }} 个商品不在当前数据里（可能已下架或改号）。
                <ElButton size="small" text class="config-card__action" @click="clearDanglingEntries">
                  一键清理
                </ElButton>
              </p>

              <ElTable
                v-if="manualRows.length"
                class="manual-table"
                :data="manualRows"
                row-key="skuId"
                max-height="320"
                border
                size="small"
                @selection-change="(rows) => (manualSelection = rows.map((row) => row.skuId))"
              >
                <ElTableColumn type="selection" width="42" />
                <ElTableColumn label="品名" min-width="140">
                  <template #default="{ row }">
                    <span :title="row.item.product">{{ row.item.product }}</span>
                  </template>
                </ElTableColumn>
                <ElTableColumn label="颜色" min-width="120">
                  <template #default="{ row }">{{ row.item.color }}</template>
                </ElTableColumn>
                <ElTableColumn label="模式" width="150">
                  <template #default="{ row }">
                    <ElSelect
                      :model-value="row.entry.modeId"
                      size="small"
                      class="manual-table__select"
                      @update:model-value="(value) => updateManualRowMode(row, value)"
                    >
                      <ElOption
                        v-for="mode in manualModes"
                        :key="mode.id"
                        :label="mode.name"
                        :value="mode.id"
                      />
                    </ElSelect>
                  </template>
                </ElTableColumn>
                <ElTableColumn label="系数（红线 / 正常 / 峰值，公斤）" min-width="220">
                  <template #default="{ row }">
                    <template v-if="row.mode?.behavior === 'custom'">
                      <ElInputNumber
                        v-for="coefficient in COEFFICIENT_KEYS"
                        :key="coefficient.key"
                        :model-value="row.entry.coefficients?.[coefficient.key] ?? null"
                        :min="0"
                        :step="1"
                        :precision="1"
                        :controls="false"
                        size="small"
                        class="manual-table__coefficient"
                        :aria-label="`${row.item.product} ${coefficient.label}系数`"
                        @update:model-value="(value) => updateManualRowCoefficient(row, coefficient.key, value)"
                      />
                    </template>
                    <span v-else-if="row.mode?.behavior === 'order'" class="manual-table__orders" :title="orderRowsTitle(row)">
                      {{ orderRowsText(row) }}
                    </span>
                    <span v-else class="manual-table__exclude">排除：不参与备货策略</span>
                  </template>
                </ElTableColumn>
                <ElTableColumn label="操作" width="96" align="center">
                  <template #default="{ row }">
                    <ElButton size="small" text @click="clearManualRow(row)">恢复自动</ElButton>
                  </template>
                </ElTableColumn>
              </ElTable>
              <p v-else class="manual-block__empty">
                还没有手动 SKU。到主面板点击颜色单元格的 ⓘ 打开 SKU 弹窗，把策略切成「手动策略」即可。
              </p>
            </div>
          </div>
        </section>

        <section class="config-card" :class="{ 'config-card--open': weightsOpen }">
          <div class="config-card__head">
            <button
              type="button"
              class="config-card__toggle"
              :aria-expanded="weightsOpen"
              @click="weightsOpen = !weightsOpen"
            >
              <span class="config-card__chevron">▾</span>
              <span class="config-card__title">销量加权</span>
              <span class="config-card__summary">{{ weightsSummary }}</span>
            </button>
            <ElTooltip :content="weightsIntro" placement="top">
              <span class="config-info">i</span>
            </ElTooltip>
            <span class="config-card__spacer" />
            <ElButton size="small" text class="config-card__action" @click="resetWeights">
              恢复 50 / 30 / 20
            </ElButton>
          </div>

          <div v-show="weightsOpen" class="config-card__body">
            <div class="sales-window">
              <label v-for="field in WEIGHT_FIELDS" :key="field.key" class="sales-window__item">
                <span class="sales-window__label">{{ field.label }}</span>
                <ElInputNumber
                  v-model="salesWeights[field.key]"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  :precision="2"
                  :controls="false"
                  size="small"
                  class="sales-window__input"
                  :aria-label="`${field.label}权重`"
                />
                <span class="sales-window__value">{{ formatPercent(salesWeights[field.key]) }}</span>
              </label>
              <span
                class="sales-window__total"
                :class="{ 'sales-window__total--warn': !weightsBalanced }"
              >
                合计 {{ formatPercent(weightsTotal) }}
              </span>
            </div>

            <div class="sales-window__months">
              <span v-for="(share, index) in monthWeights" :key="index" class="sales-window__month">
                {{ index === 0 ? '最新月' : `${index + 1} 个月前` }}
                <strong>{{ formatPercent(share) }}</strong>
              </span>
            </div>
          </div>
        </section>

        <ScoringSettings :scoring="scoring" @apply="applyScoring" />

        <SpuGradeSettings :grades="spuGrades" :totals="spuMonthlyTotals" @apply="applySpuGrades" />
      </div>
    </div>
  </main>
</template>



<style scoped>
.config-page {
  min-height: 100vh;
  padding: 8px 0 24px;
  color: var(--industrial-text);
  background: var(--industrial-page);
  /* 控件统一 28px 高，避免 24px 与 32px 混排 */
  --el-component-size-small: 28px;
}

.config-content {
  width: 100%;
  max-width: 100%;
  margin: 0 auto;
  padding: 0 12px;
  box-sizing: border-box;
}

/* 规则区居中限宽：宽屏下不再把输入框拉成一整行 */
.config-body {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}

.config-heading {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 2px 0 10px;
}

.config-heading h1 {
  margin: 0;
  font-size: 18px;
}

.config-heading p {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
}

/* —— 顶部工作条：方案 + 保存状态 + 保存动作 —— */
.config-bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 8px 10px;
  border: 1px solid var(--industrial-grid);
  border-radius: 6px;
  background: var(--industrial-surface);
  box-shadow: 0 2px 8px rgba(47, 59, 67, 0.08);
}

.config-bar__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.config-bar__group--end {
  margin-left: auto;
}

.config-bar__label {
  color: var(--industrial-muted);
  font-size: 12px;
  white-space: nowrap;
}

.config-bar__state {
  padding: 2px 8px;
  border-radius: 10px;
  color: var(--industrial-muted);
  background: rgba(47, 59, 67, 0.06);
  font-size: 12px;
  white-space: nowrap;
}

.config-bar__state--dirty {
  color: #fff;
  background: var(--industrial-replenish);
}

.profile-bar__select {
  width: 170px;
}

.profile-import-input {
  display: none;
}

.config-bar + .config-card {
  margin-top: 12px;
}

/* —— 策略 / 模式工作区 —— */
.config-workspace {
  overflow: hidden;
}

.config-workspace > .config-card__head {
  background: var(--industrial-page);
}

.config-workspace__hint {
  color: var(--industrial-muted);
  font-size: 12px;
}

.strategy-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 6px;
  background: rgba(47, 59, 67, 0.06);
}

.strategy-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: 0;
  border-radius: 4px;
  color: var(--industrial-text);
  background: transparent;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.strategy-tab--active {
  color: #fff;
  background: var(--industrial-primary);
  font-weight: 600;
}

.strategy-tab__count {
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.1);
  font-size: 11px;
}

.mode-workspace {
  display: grid;
  grid-template-columns: 176px minmax(0, 1fr);
  gap: 12px;
  padding: 10px;
}

.mode-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mode-list__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 6px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-left: 3px solid transparent;
  border-radius: 5px;
  color: inherit;
  background: var(--industrial-page);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mode-list__item:hover {
  border-color: var(--industrial-grid-light);
}

.mode-list__item--active {
  border-color: var(--industrial-grid-light);
  border-left-color: var(--industrial-primary);
  background: var(--industrial-surface);
}

.mode-list__name {
  font-size: 13px;
  font-weight: 600;
}

.mode-list__count {
  padding: 0 6px;
  border-radius: 9px;
  color: var(--industrial-muted);
  background: rgba(47, 59, 67, 0.08);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.mode-list__metric {
  grid-column: 1 / -1;
  color: var(--industrial-muted);
  font-size: 11px;
}

.mode-editor {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 5px;
}

.mode-editor__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}

.rule-name-input {
  width: 148px;
}

.mode-editor__badge {
  padding: 1px 8px;
  border-radius: 10px;
  color: var(--industrial-primary);
  background: var(--industrial-header);
  font-size: 11px;
}

.mode-editor__badge--muted {
  color: var(--industrial-muted);
  background: rgba(47, 59, 67, 0.05);
}

.mode-editor__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.mode-editor__label,
.mode-editor__note {
  color: var(--industrial-muted);
  font-size: 12px;
}

.mode-editor__empty {
  margin: 0 0 8px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.mode-threshold__input {
  width: 96px;
  font-variant-numeric: tabular-nums;
}

.mode-editor__tilde {
  color: var(--industrial-muted);
  font-size: 12px;
}

.coefficient-table + .coefficient-table {
  margin-top: 10px;
}

/* 按量模式在系数表下方追加的两项健康度判定区间 */
.bulk-score-rules {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--industrial-grid-light);
}

.bulk-score-rules .mode-editor__label {
  min-width: 72px;
}

.coefficient-table__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 600;
}

.coefficient-table__unit {
  color: var(--industrial-muted);
  font-size: 11px;
  font-weight: 400;
}

.coefficient-table__head,
.coefficient-table__row {
  display: grid;
  grid-template-columns: 72px repeat(3, 118px);
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.coefficient-table__head {
  color: var(--industrial-muted);
  font-size: 11px;
}

.coefficient-table__row + .coefficient-table__row {
  border-top: 1px dashed var(--industrial-grid-light);
}

.coefficient-table__category {
  font-size: 12px;
}

.coefficient-table__input {
  width: 118px;
  font-variant-numeric: tabular-nums;
}

.rule-validation {
  margin-top: 10px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--industrial-header);
  font-size: 12px;
  line-height: 1.7;
}

.rule-validation__error {
  margin: 0;
  color: var(--industrial-danger);
}

.rule-validation__warning {
  margin: 0;
  color: var(--industrial-muted);
}

/* —— 手动策略 —— */
.manual-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px;
}

.manual-block__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.manual-block__head h3 {
  margin: 0;
  font-size: 13px;
}

.manual-block__empty {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
}

.manual-mode-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.manual-mode-row {
  display: grid;
  grid-template-columns: 132px 72px minmax(0, 1fr) repeat(3, 76px) 28px;
  align-items: center;
  gap: 8px;
}

.manual-mode-row--head {
  color: var(--industrial-muted);
  font-size: 11px;
}

.manual-mode-row__behavior {
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.manual-mode-row__name,
.manual-mode-row__desc,
.manual-mode-row__coefficient {
  width: 100%;
}

.manual-mode-row__coefficient {
  font-variant-numeric: tabular-nums;
}

.manual-mode-row__skip {
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.rule-row-remove {
  padding: 0;
  color: var(--industrial-danger);
}

.manual-list__dangling {
  margin: 0 0 8px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--industrial-header);
  font-size: 12px;
}

.manual-table {
  width: 100%;
}

.manual-table__select {
  width: 100%;
}

.manual-table__coefficient {
  width: 62px;
  margin-right: 4px;
  font-variant-numeric: tabular-nums;
}

.manual-table__exclude {
  color: var(--industrial-muted);
  font-size: 12px;
}

.manual-table__orders {
  color: var(--industrial-muted);
  font-size: 12px;
  cursor: help;
}

/* —— 折叠卡片里的文字操作 —— */
.config-card__action {
  padding: 0;
  color: var(--industrial-primary);
}

/* —— 销量加权 —— */
.sales-window {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
}

.sales-window__item {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--industrial-text);
  font-size: 12px;
}

.sales-window__input {
  width: 76px;
  font-variant-numeric: tabular-nums;
}

.sales-window__value {
  min-width: 50px;
  color: var(--industrial-muted);
  font-variant-numeric: tabular-nums;
}

.sales-window__total {
  color: var(--industrial-normal);
  font-size: 12px;
}

.sales-window__total--warn {
  color: var(--industrial-danger);
}

.sales-window__months {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
  color: var(--industrial-muted);
  font-size: 11px;
}

.sales-window__month {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--industrial-page);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 720px) {
  .mode-workspace {
    grid-template-columns: 1fr;
  }

  .mode-list {
    flex-direction: row;
    overflow-x: auto;
  }

  .mode-list__item {
    min-width: 120px;
  }

  .manual-mode-row {
    grid-template-columns: 1fr 1fr;
  }

  .manual-mode-row--head {
    display: none;
  }
}
</style>
