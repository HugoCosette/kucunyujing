<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  ElButton,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTooltip,
} from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import PurchaseSettingsPanel from '@/components/PurchaseSettingsPanel.vue'
import ScoringSettings from '@/components/ScoringSettings.vue'
import SpuGradeSettings from '@/components/SpuGradeSettings.vue'
import {
  CATEGORIES,
  COEFFICIENT_KEYS,
  MANUAL_BEHAVIOR_LABELS,
  MANUAL_BEHAVIOR_NAMES,
  MODE_METRICS,
  SALES_WINDOW_MAX_MONTHS,
  createDefaultManualMode,
  createDefaultSalesWeights,
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
import { MAIN_PANEL } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { useStockingConfigStore } from '@/stores/stocking'

// 备货配置只有一份（src/stocking/config.json），改这里即全局生效。
// 销量加权是「近 N 个月的月均 × 权重」的列表，档位可增删，月数可填 1–12。
function weightLabel(months) {
  const value = Number(months)
  return value === 1 ? '近 1 个月' : `近 ${value} 个月月均`
}

const inventoryStore = useInventoryStore()
const stockingStore = useStockingConfigStore()
const inventoryItems = inventoryStore.inventoryItems
const configLabel = MAIN_PANEL.configLabel

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
  () => configDraft.value.salesWindow?.weights ?? createDefaultSalesWeights(),
)
const weightsTotal = computed(() =>
  salesWeights.value.reduce((sum, entry) => sum + Number(entry.weight || 0), 0),
)
const weightsBalanced = computed(() => Math.abs(weightsTotal.value - 1) <= 0.001)
const weightsDigest = computed(() => salesWeights.value.map((entry) => shortPercent(entry.weight)).join(' / '))

function formatPercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${(number * 100).toFixed(2)}%` : '—'
}

function shortPercent(value) {
  const number = Number(value)
  return Number.isFinite(number) ? `${Number((number * 100).toFixed(2))}%` : '—'
}

const strategyIntro = computed(() =>
  activeStrategy.value === 'auto'
    ? '自动策略按「月均条数」判定 5 个模式：热销 / 常规 按「够卖多少天」比较系数，按量按库存公斤数比较，尾货 / 滞销 仅标注不参与计算。判定从上一个模式往下依次进行，先命中先归属。'
    : '手动策略是人对单个 SKU 的长期决定：在 SKU 弹窗里切到手动模式即可加入清单，跨导入与刷新保留，不写进配置方案文件。',
)

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

// 内置的两种行为必须各保留一个，其余自定义模式可删。
function isRequiredManualMode(mode) {
  if (!mode) return true
  const sameBehavior = manualModes.value.filter((entry) => entry.behavior === mode.behavior)
  return sameBehavior.length <= 1
}

function nextManualModeName(behavior) {
  const base = MANUAL_BEHAVIOR_NAMES[behavior] ?? MANUAL_BEHAVIOR_NAMES.custom
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

// ---------------------------------------------------------------------------
// 以下只服务于新的展示层：分区切换、只读表格的弹窗草稿与派生文案。
// 不新增任何配置字段，保存路径仍走 configDraft + 原有 store 动作。
// ---------------------------------------------------------------------------

const activePanel = ref('strategy')

// 设置页一个壳两个域：左侧分区决定顶部工具条用哪一套。
const STOCKING_PANELS = ['strategy', 'weights', 'scoring', 'spu']
const isStockingPanel = computed(() => STOCKING_PANELS.includes(activePanel.value))

// 下单配置的草稿在子组件里；外壳只读它暴露的 dirty / meta，动作走 purchaseCall。
const purchasePanelRef = ref(null)
const purchaseDirty = computed(() => Boolean(purchasePanelRef.value?.dirty))
const purchaseMeta = computed(
  () =>
    purchasePanelRef.value?.meta ?? {
      vatRules: 0,
      factories: 0,
      enabledFactories: 0,
      people: 0,
      categories: 0,
      skus: 0,
    },
)
function purchaseCall(method) {
  purchasePanelRef.value?.[method]?.()
}

// 旧「下单设置」深链会带 ?panel=vat 跳到本页，直接落到对应分区。
const route = useRoute()
onMounted(() => {
  const panel = String(route.query.panel ?? '')
  const known = [...STOCKING_PANELS, 'vat', 'factories', 'people', 'categories', 'sku-factories']
  if (known.includes(panel)) activePanel.value = panel
})

// 分区脏点：与 configDirty 同一口径，只是按分区拆分，纯展示。
const savedConfig = computed(() => normalizeConfig(stockingStore.config))
const dirtySections = computed(() => ({
  strategy:
    JSON.stringify(configDraft.value.strategies) !== JSON.stringify(savedConfig.value.strategies),
  weights:
    JSON.stringify(configDraft.value.salesWindow) !== JSON.stringify(savedConfig.value.salesWindow),
  scoring:
    JSON.stringify(configDraft.value.scoring) !== JSON.stringify(savedConfig.value.scoring),
  spu: JSON.stringify(configDraft.value.spuGrades) !== JSON.stringify(savedConfig.value.spuGrades),
}))

const scoringDimensionCount = computed(() => Object.keys(scoring.value.dimensions ?? {}).length)

const allManualSelected = computed(
  () => manualRows.value.length > 0 && manualSelection.value.length === manualRows.value.length,
)
const someManualSelected = computed(
  () =>
    manualSelection.value.length > 0 && manualSelection.value.length < manualRows.value.length,
)

function toggleManualAll(event) {
  manualSelection.value = event.target?.checked
    ? manualRows.value.map((row) => row.skuId)
    : []
}

function manualCoefficientSummary(row) {
  if (row.mode?.behavior !== 'custom') return '按订单填量'
  const source = row.entry.coefficients ?? row.mode?.defaultCoefficients ?? {}
  return COEFFICIENT_KEYS.map((coefficient) => source[coefficient.key] ?? '—').join(' / ')
}

const panelStateText = computed(() => {
  if (!configDirty.value) return '已保存'
  const count = validation.value.errors.length
  return count ? `待修正 ${count} 项` : '未保存'
})

const panelStateTone = computed(() => {
  if (!configDirty.value) return ''
  return validation.value.errors.length ? 'state--error' : 'state--dirty'
})

function numberText(value) {
  if (value === null || value === undefined || value === '') return '不限'
  const number = Number(value)
  if (!Number.isFinite(number)) return '不限'
  return String(Math.round(number * 100) / 100)
}

// 模式的月均条数区间，只用于展示。
function strategyRangeText(mode) {
  const from = mode?.range?.from ?? null
  const to = mode?.range?.to ?? null
  if (from === null && to === null) return '不限区间'
  if (to === null) return `≥ ${numberText(from)} 条/月`
  if (from === null) return `≤ ${numberText(to)} 条/月`
  return `${numberText(from)} ~ ${numberText(to)} 条/月`
}

function strategyRowCount(mode) {
  const kinds = coefficientKinds(mode)
  let count = 0
  for (const kind of kinds) {
    count += Object.keys(mode.coefficients[kind] ?? {}).length
  }
  return count
}

function healthScoringRows(mode) {
  if (!mode?.healthScoring) return []
  const ratio = mode.healthScoring.ratio
  const customers = mode.healthScoring.customers
  return [
    {
      key: 'ratio',
      label: '本次进销比',
      text:
        ratio.normalFrom === null && ratio.normalTo === null
          ? '不限'
          : `${numberText(ratio.normalFrom)}% ~ ${numberText(ratio.normalTo)}% 为正常`,
    },
    {
      key: 'customers',
      label: '累积客户数',
      text:
        customers.normalFrom === null && customers.normalTo === null
          ? '不限'
          : `${numberText(customers.normalFrom)} ~ ${numberText(customers.normalTo)} 个为中风险`,
    },
  ]
}

// —— 模式编辑弹窗 ——
const modeDialogVisible = ref(false)
const modeDraft = reactive({
  name: '',
  from: null,
  to: null,
  coefficients: {},
  healthScoring: null,
})

function openModeDialog() {
  const mode = activeMode.value
  if (!mode) return
  modeDraft.name = mode.name
  modeDraft.from = mode.range?.from ?? null
  modeDraft.to = mode.range?.to ?? null
  modeDraft.coefficients = mode.coefficients
    ? JSON.parse(JSON.stringify(mode.coefficients))
    : null
  modeDraft.healthScoring = mode.healthScoring
    ? JSON.parse(JSON.stringify(mode.healthScoring))
    : null
  modeDialogVisible.value = true
}

const modeDraftKinds = computed(() => {
  if (!modeDraft.coefficients) return []
  return Object.keys(modeDraft.coefficients).filter((kind) => modeDraft.coefficients[kind])
})

function saveModeDraft() {
  const mode = activeMode.value
  if (!mode) return
  beforeStructuralChange()
  mode.name = String(modeDraft.name ?? '').trim()
  mode.range.from = modeDraft.from ?? null
  mode.range.to = modeDraft.to ?? null
  if (mode.coefficients && modeDraft.coefficients) {
    for (const kind of Object.keys(mode.coefficients)) {
      if (!mode.coefficients[kind]) continue
      // 直接写回同一份对象，保持 configDraft 的引用不变。
      for (const category of Object.keys(mode.coefficients[kind])) {
        for (const coefficient of COEFFICIENT_KEYS) {
          mode.coefficients[kind][category][coefficient.key] =
            modeDraft.coefficients[kind]?.[category]?.[coefficient.key] ?? null
        }
      }
    }
  }
  if (mode.healthScoring && modeDraft.healthScoring) {
    mode.healthScoring.ratio.normalFrom = modeDraft.healthScoring.ratio?.normalFrom ?? null
    mode.healthScoring.ratio.normalTo = modeDraft.healthScoring.ratio?.normalTo ?? null
    mode.healthScoring.customers.normalFrom =
      modeDraft.healthScoring.customers?.normalFrom ?? null
    mode.healthScoring.customers.normalTo = modeDraft.healthScoring.customers?.normalTo ?? null
  }
  draftVersion.value += 1
  modeDialogVisible.value = false
}

// —— 销量加权弹窗 ——
// 草稿用「百分比整数」编辑（50 而不是 0.5），保存时再除以 100 写回配置。
const weightsDialogVisible = ref(false)
const weightsDraft = ref([])
const weightsDraftTotal = computed(() =>
  weightsDraft.value.reduce((sum, entry) => sum + (Number(entry.weight) || 0), 0),
)
const weightsDraftError = computed(() => {
  if (weightsDraft.value.some((entry) => !Number.isInteger(Number(entry.months)))) {
    return '月数必须是整数'
  }
  if (
    weightsDraft.value.some(
      (entry) => Number(entry.months) < 1 || Number(entry.months) > SALES_WINDOW_MAX_MONTHS,
    )
  ) {
    return `月数需在 1–${SALES_WINDOW_MAX_MONTHS} 之间`
  }
  if (weightsDraft.value.some((entry) => !(Number(entry.weight) >= 0))) {
    return '权重不能为负'
  }
  if (Math.abs(weightsDraftTotal.value - 100) > 0.1) {
    return `合计需为 100%，当前 ${weightsDraftTotal.value.toFixed(2)}%`
  }
  return ''
})
const weightsDraftBalanced = computed(() => weightsDraftError.value === '')

function openWeightsDialog() {
  weightsDraft.value = salesWeights.value.map((entry) => ({
    months: Number(entry.months),
    weight: Number((Number(entry.weight || 0) * 100).toFixed(2)),
  }))
  weightsDialogVisible.value = true
}

function addWeightDraft() {
  if (weightsDraft.value.length >= SALES_WINDOW_MAX_MONTHS) return
  const used = new Set(weightsDraft.value.map((entry) => Number(entry.months)))
  let months = SALES_WINDOW_MAX_MONTHS
  for (let candidate = 1; candidate <= SALES_WINDOW_MAX_MONTHS; candidate += 1) {
    if (!used.has(candidate)) {
      months = candidate
      break
    }
  }
  weightsDraft.value.push({ months, weight: 0 })
}

function removeWeightDraft(index) {
  if (weightsDraft.value.length <= 1) return
  weightsDraft.value.splice(index, 1)
}

function saveWeightsDraft() {
  if (!weightsDraftBalanced.value) return
  beforeStructuralChange()
  configDraft.value.salesWindow = {
    weights: weightsDraft.value.map((entry) => ({
      months: Math.trunc(Number(entry.months)),
      weight: Number(entry.weight) / 100,
    })),
  }
  weightsDialogVisible.value = false
}

// —— 手动模式弹窗 ——
const manualModeDialogVisible = ref(false)
const manualModeEditingId = ref('')
const manualModeDraft = reactive({
  name: '',
  behavior: 'custom',
  description: '',
  redLine: 20,
  normal: 40,
  peak: 60,
})

function openCreateManualMode() {
  const behavior = 'custom'
  const template = createDefaultManualMode({
    behavior,
    name: nextManualModeName(behavior),
  })
  manualModeEditingId.value = ''
  manualModeDraft.name = template.name
  manualModeDraft.behavior = template.behavior
  manualModeDraft.description = template.description ?? ''
  manualModeDraft.redLine = template.defaultCoefficients?.redLine ?? 20
  manualModeDraft.normal = template.defaultCoefficients?.normal ?? 40
  manualModeDraft.peak = template.defaultCoefficients?.peak ?? 60
  manualModeDialogVisible.value = true
}

function openManualModeDialog(mode) {
  manualModeEditingId.value = mode.id
  manualModeDraft.name = mode.name
  manualModeDraft.behavior = mode.behavior
  manualModeDraft.description = mode.description ?? ''
  manualModeDraft.redLine = mode.defaultCoefficients?.redLine ?? null
  manualModeDraft.normal = mode.defaultCoefficients?.normal ?? null
  manualModeDraft.peak = mode.defaultCoefficients?.peak ?? null
  manualModeDialogVisible.value = true
}

function saveManualModeDraft() {
  const target = manualModes.value.find((mode) => mode.id === manualModeEditingId.value)
  beforeStructuralChange()
  const payload = {
    name: String(manualModeDraft.name ?? '').trim(),
    description: String(manualModeDraft.description ?? '').trim(),
  }
  if (target) {
    Object.assign(target, payload)
    if (target.behavior === 'custom') {
      target.defaultCoefficients = {
        redLine: manualModeDraft.redLine ?? null,
        normal: manualModeDraft.normal ?? null,
        peak: manualModeDraft.peak ?? null,
      }
    }
  } else {
    const mode = createDefaultManualMode({
      behavior: manualModeDraft.behavior,
      name: payload.name,
      description: payload.description,
    })
    if (mode.behavior === 'custom') {
      mode.defaultCoefficients = {
        redLine: manualModeDraft.redLine ?? null,
        normal: manualModeDraft.normal ?? null,
        peak: manualModeDraft.peak ?? null,
      }
    }
    if (manualStrategy.value) manualStrategy.value.modes.push(mode)
  }
  manualModeDialogVisible.value = false
}

// —— 手动 SKU 弹窗 ——
const manualSkuDialogVisible = ref(false)
const manualSkuRowKey = ref('')
const manualSkuDraft = reactive({ modeId: '', coefficients: {} })
const manualSkuRow = computed(
  () => manualRows.value.find((row) => row.skuId === manualSkuRowKey.value) ?? null,
)
const manualSkuBehavior = computed(
  () => manualModes.value.find((mode) => mode.id === manualSkuDraft.modeId)?.behavior ?? '',
)

function openManualSkuDialog(row) {
  manualSkuRowKey.value = row.skuId
  manualSkuDraft.modeId = row.entry.modeId ?? manualModes.value[0]?.id ?? ''
  const mode = manualModes.value.find((entry) => entry.id === manualSkuDraft.modeId)
  const source = row.entry.coefficients ?? mode?.defaultCoefficients ?? {}
  manualSkuDraft.coefficients = {
    redLine: source.redLine ?? null,
    normal: source.normal ?? null,
    peak: source.peak ?? null,
  }
  manualSkuDialogVisible.value = true
}

async function saveManualSkuDraft() {
  const row = manualSkuRow.value
  const mode = manualModes.value.find((entry) => entry.id === manualSkuDraft.modeId)
  if (!row || !mode) return
  const entry = { modeId: mode.id }
  if (mode.behavior === 'custom') {
    entry.coefficients = {
      redLine: manualSkuDraft.coefficients.redLine ?? null,
      normal: manualSkuDraft.coefficients.normal ?? null,
      peak: manualSkuDraft.coefficients.peak ?? null,
    }
  }
  await stockingStore.setManualEntry(row.skuId, entry)
  manualSkuDialogVisible.value = false
}

// —— 顶栏方案菜单 ——
function handleProfileMenu(command) {
  if (typeof command === 'string' && command.startsWith('profile:')) {
    const profileId = command.slice('profile:'.length)
    profileSelection.value = profileId
    switchProfile(profileId)
    return
  }
  if (command === 'duplicate') duplicateProfile()
  else if (command === 'rename') renameProfile()
  else if (command === 'delete') deleteProfile()
  else handleFileCommand(command)
}
</script>

<template>
  <main class="config-shell">
    <PanelNavigation />

    <div v-if="isStockingPanel" class="config-bar">
      <h1 class="config-bar__title">设置</h1>
      <span class="config-bar__domain">备货配置</span>

      <ElDropdown trigger="click" placement="bottom-start" @command="handleProfileMenu">
        <button type="button" class="btn btn--plan" aria-label="配置方案">
          {{ activeProfileName }}
          <svg class="btn__caret" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 4.5 6 7.5l3-3"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <template #dropdown>
          <ElDropdownMenu>
            <ElDropdownItem
              v-for="profile in profiles"
              :key="profile.id"
              :command="`profile:${profile.id}`"
            >
              <span class="profile-menu__check">{{ profile.id === activeProfileId ? '✓' : '' }}</span>
              {{ profile.name }}
            </ElDropdownItem>
            <ElDropdownItem divided command="duplicate">复制为新方案</ElDropdownItem>
            <ElDropdownItem command="rename">重命名</ElDropdownItem>
            <ElDropdownItem command="delete" :disabled="profiles.length <= 1">删除方案</ElDropdownItem>
            <ElDropdownItem divided command="export">导出方案文件</ElDropdownItem>
            <ElDropdownItem command="import">导入方案文件</ElDropdownItem>
            <ElDropdownItem divided command="restore">恢复默认</ElDropdownItem>
          </ElDropdownMenu>
        </template>
      </ElDropdown>

      <span class="state" :class="panelStateTone">{{ panelStateText }}</span>

      <div class="config-bar__end">
        <button
          type="button"
          class="icon-btn"
          title="撤销（Ctrl+Z）"
          :disabled="!canUndo"
          @click="undo"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M6 3.5 3 6.5l3 3"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path d="M3 6.5h5.6a3.4 3.4 0 0 1 0 6.8H6.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          title="重做（Ctrl+Shift+Z）"
          :disabled="!canRedo"
          @click="redo"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M10 3.5 13 6.5l-3 3"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path d="M13 6.5H7.4a3.4 3.4 0 0 0 0 6.8h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
        <span class="config-bar__divider"></span>
        <button
          type="button"
          class="btn btn--text"
          :disabled="!configDirty"
          title="放弃所有未保存的改动，回到上次保存的配置"
          @click="discardChanges"
        >
          放弃
        </button>
        <button type="button" class="btn btn--primary" :disabled="!configDirty" @click="confirmConfig">
          保存
        </button>
        <input
          ref="importInputRef"
          type="file"
          accept="application/json,.json"
          class="profile-import-input"
          @change="handleImportFile"
        />
      </div>
    </div>

    <!-- 下单配置：工具条跟着分区切换，保存 / 放弃走 PurchaseSettingsPanel 暴露的方法 -->
    <div v-else class="config-bar">
      <h1 class="config-bar__title">设置</h1>
      <span class="config-bar__domain">下单配置</span>
      <span class="state" :class="{ 'state--dirty': purchaseDirty }">
        {{ purchaseDirty ? '未保存' : '已保存' }}
      </span>
      <div class="config-bar__end">
        <button type="button" class="btn btn--sm" @click="purchaseCall('pickSettingsFile')">
          导入设置文件
        </button>
        <button type="button" class="btn btn--sm" @click="purchaseCall('exportSettings')">
          导出设置文件
        </button>
        <span class="config-bar__divider"></span>
        <button
          type="button"
          class="btn btn--text"
          :disabled="!purchaseDirty"
          @click="purchaseCall('discard')"
        >
          放弃
        </button>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="!purchaseDirty"
          @click="purchaseCall('confirm')"
        >
          确定
        </button>
      </div>
    </div>

    <div class="config-layout">
      <aside class="rail">
        <div class="rail__group">
          <div class="rail__group-title">备货配置</div>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'strategy', 'is-dirty': dirtySections.strategy }"
            @click="activePanel = 'strategy'"
          >
            <span class="rail__title">策略与模式</span>
            <span class="rail__meta">{{ autoModes.length }} 个模式 · {{ manualRows.length }} 个手动 SKU</span>
          </button>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'weights', 'is-dirty': dirtySections.weights }"
            @click="activePanel = 'weights'"
          >
            <span class="rail__title">销量加权</span>
            <span class="rail__meta">{{ weightsDigest }}</span>
          </button>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'scoring', 'is-dirty': dirtySections.scoring }"
            @click="activePanel = 'scoring'"
          >
            <span class="rail__title">健康度评分</span>
            <span class="rail__meta">{{ scoringDimensionCount }} 个维度</span>
          </button>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'spu', 'is-dirty': dirtySections.spu }"
            @click="activePanel = 'spu'"
          >
            <span class="rail__title">SPU 分级</span>
            <span class="rail__meta">{{ spuGrades.tiers.length }} 档</span>
          </button>
        </div>

        <div class="rail__group">
          <div class="rail__group-title">下单配置</div>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'vat' }"
            @click="activePanel = 'vat'"
          >
            <span class="rail__title">缸规则</span>
            <span class="rail__meta">{{ purchaseMeta.vatRules }} 条规则</span>
          </button>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'factories' }"
            @click="activePanel = 'factories'"
          >
            <span class="rail__title">染厂清单</span>
            <span class="rail__meta">
              {{ purchaseMeta.factories }} 家 · {{ purchaseMeta.enabledFactories }} 家启用
            </span>
          </button>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'people' }"
            @click="activePanel = 'people'"
          >
            <span class="rail__title">分单人员表</span>
            <span class="rail__meta">{{ purchaseMeta.people }} 人</span>
          </button>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'categories' }"
            @click="activePanel = 'categories'"
          >
            <span class="rail__title">树形分类与分单</span>
            <span class="rail__meta">{{ purchaseMeta.categories }} 个分类</span>
          </button>
          <button
            type="button"
            class="rail__item"
            :class="{ 'is-active': activePanel === 'sku-factories' }"
            @click="activePanel = 'sku-factories'"
          >
            <span class="rail__title">SKU 可选染厂</span>
            <span class="rail__meta">{{ purchaseMeta.skus }} 个 SKU 有约束</span>
          </button>
        </div>
      </aside>

      <div class="config-panels">
        <div class="config-panels__inner">
          <!-- 策略与模式 -->
          <section v-show="activePanel === 'strategy'" class="panel">
            <div class="panel__head">
              <h2 class="panel__title">策略与模式</h2>
              <div class="segmented" role="tablist" aria-label="策略">
                <button
                  type="button"
                  role="tab"
                  class="segmented__btn"
                  :class="{ 'is-active': activeStrategy === 'auto' }"
                  :aria-selected="activeStrategy === 'auto'"
                  @click="activeStrategy = 'auto'"
                >
                  自动策略
                </button>
                <button
                  type="button"
                  role="tab"
                  class="segmented__btn"
                  :class="{ 'is-active': activeStrategy === 'manual' }"
                  :aria-selected="activeStrategy === 'manual'"
                  @click="activeStrategy = 'manual'"
                >
                  手动策略
                </button>
              </div>
            </div>

            <div v-if="activeStrategy === 'auto'" class="master">
              <nav class="mode-list" aria-label="模式">
                <button
                  v-for="mode in autoModes"
                  :key="mode.key"
                  type="button"
                  class="mode-item"
                  :class="{ 'is-active': mode.key === activeMode?.key }"
                  :aria-current="mode.key === activeMode?.key"
                  @click="activeModeKey = mode.key"
                >
                  <span class="mode-item__row">
                    <span class="mode-item__name">{{ mode.name }}</span>
                    <span class="mode-item__hits">{{ modeHitCount(mode.key) ?? '--' }}</span>
                  </span>
                  <span class="mode-item__range">{{ strategyRangeText(mode) }}</span>
                </button>
              </nav>

              <div v-if="activeMode" :key="`${activeMode.key}-${draftVersion}`" class="mode-editor">
                <div class="editor-head">
                  <h3 class="editor-head__title">{{ activeMode.name }}</h3>
                  <span class="tag">{{ strategyRangeText(activeMode) }}</span>
                  <ElTooltip :content="metricTitle(activeMode)" placement="top">
                    <span class="tag tag--muted">{{ metricBadge(activeMode) }}</span>
                  </ElTooltip>
                  <span class="editor-head__meta">
                    命中 {{ modeHitCount(activeMode.key) ?? '--' }} 个 SKU<template
                      v-if="activeMode.splitByCustomer"
                    >（专属品 {{ exclusiveHitCount(activeMode.key) ?? 0 }}）</template>
                  </span>
                </div>

                <div class="tbl-block">
                  <div class="section-label">
                    备货系数
                    <span v-if="activeMode.participates">单位：{{ coefficientUnit(activeMode) }}</span>
                  </div>
                  <div v-if="!activeMode.participates" class="table-empty">不参与备货计算</div>
                  <template v-else>
                    <table
                      v-for="kind in coefficientKinds(activeMode)"
                      :key="kind"
                      class="coef-table"
                    >
                      <thead>
                        <tr>
                          <th class="coef-table__cat">客户类别</th>
                          <th class="coef-table__color">色彩</th>
                          <th class="is-num">红线（{{ coefficientUnit(activeMode) }}）</th>
                          <th class="is-num">正常（{{ coefficientUnit(activeMode) }}）</th>
                          <th class="is-num">峰值（{{ coefficientUnit(activeMode) }}）</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(category, index) in CATEGORIES" :key="category">
                          <td v-if="index === 0" :rowspan="CATEGORIES.length" class="coef-table__cat">
                            {{ kind }}
                          </td>
                          <td class="coef-table__color">{{ category }}</td>
                          <td
                            v-for="coefficient in COEFFICIENT_KEYS"
                            :key="coefficient.key"
                            class="is-num"
                          >
                            {{ activeMode.coefficients[kind]?.[category]?.[coefficient.key] ?? '—' }}
                          </td>
                        </tr>
                        <tr v-if="activeMode.splitByCustomer">
                          <td class="coef-table__cat">专属品</td>
                          <td colspan="4" class="coef-table__skip">不设系数</td>
                        </tr>
                      </tbody>
                    </table>
                  </template>
                  <div class="tbl-foot">
                    <span class="tbl-foot__hint">
                      {{ activeMode.participates ? thresholdHint(activeMode) : '该模式只在主面板标注，不参与计算' }}
                    </span>
                    <button type="button" class="btn btn--sm" @click="openModeDialog">编辑</button>
                  </div>
                </div>

                <div v-if="activeMode.healthScoring" class="tbl-block tbl-block--gap">
                  <div class="section-label">
                    健康度判定
                    <span>按量模式 · SKU 弹窗里的 2 项判定</span>
                  </div>
                  <table class="coef-table">
                    <tbody>
                      <tr v-for="row in healthScoringRows(activeMode)" :key="row.key">
                        <td class="coef-table__cat">{{ row.label }}</td>
                        <td>{{ row.text }}</td>
                      </tr>
                    </tbody>
                  </table>
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
            </div>

            <div v-else class="manual-config">
              <div class="tbl-block">
                <div class="tbl-cap">
                  <span class="tbl-cap__title">手动模式</span>
                  <span class="tbl-cap__meta">
                    {{ manualModes.length }} 个模式 · 内置行为各保留一个
                  </span>
                </div>
                <table class="score-table">
                  <thead>
                    <tr>
                      <th style="width: 168px">名称</th>
                      <th style="width: 92px">行为</th>
                      <th>说明</th>
                      <th class="is-num" style="width: 70px">红线</th>
                      <th class="is-num" style="width: 70px">正常</th>
                      <th class="is-num" style="width: 70px">峰值</th>
                      <th class="is-actions" style="width: 64px">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="mode in manualModes" :key="mode.id">
                      <td>{{ mode.name }}</td>
                      <td>
                        {{ MANUAL_BEHAVIOR_LABELS[mode.behavior] ?? MANUAL_BEHAVIOR_LABELS.custom }}
                      </td>
                      <td class="score-table__muted">{{ mode.description || '—' }}</td>
                      <template v-if="mode.behavior === 'custom'">
                        <td
                          v-for="coefficient in COEFFICIENT_KEYS"
                          :key="coefficient.key"
                          class="is-num"
                        >
                          {{ mode.defaultCoefficients?.[coefficient.key] ?? '—' }}
                        </td>
                      </template>
                      <td v-else colspan="3" class="is-num score-table__muted">按订单填量</td>
                      <td class="is-actions">
                        <span class="row-acts">
                          <button
                            type="button"
                            class="icon-btn"
                            title="编辑"
                            @click="openManualModeDialog(mode)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="m10.6 2.9 2.5 2.5-7.1 7.1-3.1.6.6-3.1 7.1-7.1Z"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="icon-btn icon-btn--danger"
                            :title="isRequiredManualMode(mode) ? '内置行为必须保留一个' : '删除模式'"
                            :disabled="isRequiredManualMode(mode)"
                            @click="removeManualMode(mode)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8M6.7 6.6v4M9.3 6.6v4"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linecap="round"
                              />
                            </svg>
                          </button>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div class="tbl-foot">
                  <span class="tbl-foot__hint">系数单位：公斤</span>
                  <button type="button" class="btn btn--sm" @click="openCreateManualMode">新增</button>
                </div>
              </div>

              <div class="tbl-block tbl-block--gap">
                <div class="tbl-cap">
                  <span class="tbl-cap__title">手动 SKU</span>
                  <span class="tbl-cap__meta">{{ manualRows.length }} 个 SKU</span>
                </div>

                <p v-if="danglingSkuIds.length" class="manual-list__dangling">
                  清单中有 {{ danglingSkuIds.length }} 个商品不在当前数据里（可能已下架或改号）。
                  <button type="button" class="btn btn--text btn--sm" @click="clearDanglingEntries">
                    一键清理
                  </button>
                </p>

                <table v-if="manualRows.length" class="score-table">
                  <thead>
                    <tr>
                      <th style="width: 32px">
                        <input
                          type="checkbox"
                          aria-label="全选手动 SKU"
                          :checked="allManualSelected"
                          :indeterminate.prop="someManualSelected"
                          @change="toggleManualAll"
                        />
                      </th>
                      <th style="width: 146px">唯一标识</th>
                      <th>品名 / 颜色</th>
                      <th style="width: 118px">模式</th>
                      <th style="width: 176px" class="is-num">红线 / 正常 / 峰值</th>
                      <th class="is-actions" style="width: 64px">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in manualRows" :key="row.skuId">
                      <td>
                        <input
                          v-model="manualSelection"
                          type="checkbox"
                          :value="row.skuId"
                          :aria-label="`选择 ${row.item.product} ${row.item.color}`"
                        />
                      </td>
                      <td class="score-table__mono">{{ row.skuId }}</td>
                      <td>{{ row.item.product }} · {{ row.item.color }}</td>
                      <td>{{ row.mode?.name ?? '—' }}</td>
                      <td class="is-num">{{ manualCoefficientSummary(row) }}</td>
                      <td class="is-actions">
                        <span class="row-acts">
                          <button
                            type="button"
                            class="icon-btn"
                            title="编辑"
                            @click="openManualSkuDialog(row)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="m10.6 2.9 2.5 2.5-7.1 7.1-3.1.6.6-3.1 7.1-7.1Z"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="icon-btn icon-btn--danger"
                            title="恢复自动"
                            @click="clearManualRow(row)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M5.5 3.5 3 6l2.5 2.5M3 6h6a4 4 0 0 1 0 8H6"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-else class="manual-block__empty">
                  还没有手动 SKU。到主面板点击颜色单元格旁的详情按钮打开 SKU 弹窗，把策略切成「手动策略」即可。
                </p>

                <div class="tbl-foot">
                  <span class="tbl-foot__hint">
                    {{ manualRows.length ? '勾选后可批量恢复自动' : '手动 SKU 跨导入与刷新保留' }}
                  </span>
                  <button
                    type="button"
                    class="btn btn--text btn--sm"
                    :disabled="manualSelection.length === 0"
                    @click="clearManualSelection"
                  >
                    恢复自动（{{ manualSelection.length }}）
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- 销量加权 -->
          <section v-show="activePanel === 'weights'" class="panel">
            <div class="panel__head">
              <h2 class="panel__title">销量加权</h2>
            </div>
            <div class="panel__body">
              <div class="tbl-block">
                <table class="score-table">
                  <thead>
                    <tr>
                      <th>统计区间</th>
                      <th class="is-num" style="width: 120px">权重</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(entry, index) in salesWeights" :key="index">
                      <td>{{ weightLabel(entry.months) }}</td>
                      <td class="is-num">{{ formatPercent(entry.weight) }}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>合计</td>
                      <td class="is-num" :class="{ 'is-bad': !weightsBalanced }">
                        {{ formatPercent(weightsTotal) }}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <div class="tbl-foot">
                  <span class="tbl-foot__hint">
                    {{
                      weightsBalanced
                        ? '各档权重只影响「够卖多少天」的系数比较，不参与模式判定'
                        : `合计需为 100%，当前 ${formatPercent(weightsTotal)}`
                    }}
                  </span>
                  <button type="button" class="btn btn--sm" @click="openWeightsDialog">编辑</button>
                </div>
              </div>
            </div>
          </section>

          <!-- 健康度评分 -->
          <ScoringSettings v-show="activePanel === 'scoring'" :scoring="scoring" @apply="applyScoring" />

          <!-- SPU 分级 -->
          <SpuGradeSettings
            v-show="activePanel === 'spu'"
            :grades="spuGrades"
            :totals="spuMonthlyTotals"
            @apply="applySpuGrades"
          />

          <!-- 下单配置：内容与旧「下单设置」一致，只换了外壳 -->
          <PurchaseSettingsPanel
            v-show="!isStockingPanel"
            ref="purchasePanelRef"
            :active-panel="activePanel"
          />
        </div>
      </div>
    </div>

    <!-- 模式编辑 -->
    <ElDialog
      v-model="modeDialogVisible"
      class="ui-dialog"
      width="560px"
      append-to-body
      align-center
      :title="`编辑模式 · ${activeMode?.name ?? ''}`"
    >
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">名称</span>
          <div class="form__row-ctrl">
            <ElInput v-model="modeDraft.name" size="small" aria-label="模式名称" />
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">月均条数</span>
          <div class="form__row-ctrl">
            <ElInputNumber
              v-model="modeDraft.from"
              :controls="false"
              :value-on-clear="null"
              :precision="2"
              placeholder="不限"
              size="small"
              aria-label="月均条数下界"
            />
            <span class="form__static">~</span>
            <ElInputNumber
              v-model="modeDraft.to"
              :controls="false"
              :value-on-clear="null"
              :precision="2"
              placeholder="不限"
              size="small"
              aria-label="月均条数上界"
            />
            <span class="form__row-hint">留空表示不限；判定按模式列表顺序，先命中先归属。</span>
          </div>
        </div>

        <div v-for="kind in modeDraftKinds" :key="kind" class="form__group">
          <div class="form__group-head">
            备货系数 · {{ kind }}
            <span class="form__group-unit">单位：{{ coefficientUnit(activeMode) }}</span>
          </div>
          <div class="coef-grid">
            <div class="coef-grid__head">
              <span>色彩</span>
              <span>红线</span>
              <span>正常</span>
              <span>峰值</span>
            </div>
            <div v-for="category in CATEGORIES" :key="category" class="coef-grid__row">
              <span>{{ category }}</span>
              <ElInputNumber
                v-for="coefficient in COEFFICIENT_KEYS"
                :key="coefficient.key"
                v-model="modeDraft.coefficients[kind][category][coefficient.key]"
                :min="0"
                :step="1"
                :precision="1"
                :controls="false"
                size="small"
                :aria-label="`${category} ${coefficient.label}系数`"
              />
            </div>
          </div>
          <p class="form__group-hint">同一行需满足 红线 ≤ 正常 ≤ 峰值。</p>
        </div>

        <div v-if="modeDraft.healthScoring" class="form__group">
          <div class="form__group-head">健康度判定</div>
          <div class="form__row">
            <span class="form__row-label">本次进销比</span>
            <div class="form__row-ctrl">
              <ElInputNumber
                v-model="modeDraft.healthScoring.ratio.normalFrom"
                :controls="false"
                :precision="1"
                :value-on-clear="null"
                size="small"
              />
              <span class="form__static">~</span>
              <ElInputNumber
                v-model="modeDraft.healthScoring.ratio.normalTo"
                :controls="false"
                :precision="1"
                :value-on-clear="null"
                size="small"
              />
              <span class="form__row-hint">% 为正常：低于下界低风险，高于上界高风险。</span>
            </div>
          </div>
          <div class="form__row">
            <span class="form__row-label">累积客户数</span>
            <div class="form__row-ctrl">
              <ElInputNumber
                v-model="modeDraft.healthScoring.customers.normalFrom"
                :controls="false"
                :precision="0"
                :value-on-clear="null"
                size="small"
              />
              <span class="form__static">~</span>
              <ElInputNumber
                v-model="modeDraft.healthScoring.customers.normalTo"
                :controls="false"
                :precision="0"
                :value-on-clear="null"
                size="small"
              />
              <span class="form__row-hint">个为中风险：少于下界高风险，多于上界低风险。</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="modeDialogVisible = false">取消</button>
          <button type="button" class="btn btn--primary btn--sm" @click="saveModeDraft">确定</button>
        </div>
      </template>
    </ElDialog>

    <!-- 销量加权编辑 -->
    <ElDialog
      v-model="weightsDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      title="编辑销量加权"
    >
      <p class="form__note">
        各档权重相加必须等于 100%；每档是「最近 N 个月的月均 × 权重」，月数可填 1–12。加权结果决定备货系数的基数。
      </p>
      <div class="form">
        <div v-for="(entry, index) in weightsDraft" :key="index" class="form__row">
          <span class="form__row-label">第 {{ index + 1 }} 档</span>
          <div class="form__row-ctrl">
            <span class="form__static">近</span>
            <div class="num-field">
              <input
                v-model.number="entry.months"
                class="input input--num weight-draft__months"
                type="number"
                min="1"
                :max="SALES_WINDOW_MAX_MONTHS"
                step="1"
                :aria-label="`第 ${index + 1} 档的月数`"
              />
              <span class="num-field__unit">个月月均</span>
            </div>
            <span class="form__static">×</span>
            <div class="num-field">
              <input
                v-model.number="entry.weight"
                class="input input--num weight-draft__percent"
                type="number"
                min="0"
                max="100"
                step="5"
                :aria-label="`第 ${index + 1} 档的权重`"
              />
              <span class="num-field__unit">%</span>
            </div>
            <button
              type="button"
              class="icon-btn weight-draft__remove"
              :disabled="weightsDraft.length <= 1"
              :aria-label="`删除第 ${index + 1} 档`"
              title="删除这一档"
              @click="removeWeightDraft(index)"
            >
              <svg viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        <div class="form__inline">
          <button
            type="button"
            class="btn btn--text btn--sm"
            :disabled="weightsDraft.length >= SALES_WINDOW_MAX_MONTHS"
            @click="addWeightDraft"
          >
            + 添加一档
          </button>
        </div>

        <div class="form__sum">
          合计
          <b :class="{ 'is-bad': !weightsDraftBalanced }">
            {{ weightsDraftTotal.toFixed(2) }}%
          </b>
        </div>
        <p v-if="weightsDraftError" class="form__error">{{ weightsDraftError }}</p>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="weightsDialogVisible = false">取消</button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            :disabled="!weightsDraftBalanced"
            @click="saveWeightsDraft"
          >
            确定
          </button>
        </div>
      </template>
    </ElDialog>

    <!-- 手动模式编辑 -->
    <ElDialog
      v-model="manualModeDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      :title="manualModeEditingId ? '编辑手动模式' : '新增手动模式'"
    >
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">名称</span>
          <div class="form__row-ctrl">
            <ElInput v-model="manualModeDraft.name" size="small" aria-label="手动模式名称" />
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">行为</span>
          <div class="form__row-ctrl">
            <span class="tag">
              {{ MANUAL_BEHAVIOR_LABELS[manualModeDraft.behavior] ?? MANUAL_BEHAVIOR_LABELS.custom }}
            </span>
            <span class="form__row-hint">行为由系统提供，新增只会是「自定系数」。</span>
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">说明</span>
          <div class="form__row-ctrl">
            <ElInput v-model="manualModeDraft.description" size="small" placeholder="说明（可选）" />
          </div>
        </div>
        <div v-if="manualModeDraft.behavior === 'custom'" class="form__row">
          <span class="form__row-label">默认系数</span>
          <div class="form__row-ctrl">
            <div v-for="coefficient in COEFFICIENT_KEYS" :key="coefficient.key" class="num-field">
              <input
                class="input input--num"
                type="number"
                min="0"
                step="1"
                :value="manualModeDraft[coefficient.key]"
                :aria-label="`默认${coefficient.label}系数`"
                @input="
                  manualModeDraft[coefficient.key] =
                    $event.target.value === '' ? null : Number($event.target.value)
                "
              />
              <span class="num-field__unit">{{ coefficient.label }}</span>
            </div>
            <span class="form__row-hint">单位：公斤。</span>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="manualModeDialogVisible = false">
            取消
          </button>
          <button type="button" class="btn btn--primary btn--sm" @click="saveManualModeDraft">
            确定
          </button>
        </div>
      </template>
    </ElDialog>

    <!-- 手动 SKU 编辑 -->
    <ElDialog
      v-model="manualSkuDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      title="编辑手动 SKU"
    >
      <div v-if="manualSkuRow" class="form">
        <div class="form__row">
          <span class="form__row-label">唯一标识</span>
          <div class="form__row-ctrl">
            <span class="form__static score-table__mono">{{ manualSkuRow.skuId }}</span>
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">品名 / 颜色</span>
          <div class="form__row-ctrl">
            <span class="form__static">
              {{ manualSkuRow.item.product }} · {{ manualSkuRow.item.color }}
            </span>
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">模式</span>
          <div class="form__row-ctrl">
            <ElSelect v-model="manualSkuDraft.modeId" size="small" aria-label="手动模式">
              <ElOption
                v-for="mode in manualModes"
                :key="mode.id"
                :label="mode.name"
                :value="mode.id"
              />
            </ElSelect>
          </div>
        </div>
        <div v-if="manualSkuBehavior === 'custom'" class="form__row">
          <span class="form__row-label">系数</span>
          <div class="form__row-ctrl">
            <div v-for="coefficient in COEFFICIENT_KEYS" :key="coefficient.key" class="num-field">
              <input
                class="input input--num"
                type="number"
                min="0"
                step="1"
                :value="manualSkuDraft.coefficients[coefficient.key]"
                :aria-label="coefficient.label"
                @input="
                  manualSkuDraft.coefficients[coefficient.key] =
                    $event.target.value === '' ? null : Number($event.target.value)
                "
              />
              <span class="num-field__unit">{{ coefficient.label }}</span>
            </div>
            <span class="form__row-hint">单位：公斤。</span>
          </div>
        </div>
        <p v-else class="form__note" style="margin: 0">
          订单货：按客户订单填量，不计预警、不做评分。
        </p>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="manualSkuDialogVisible = false">
            取消
          </button>
          <button type="button" class="btn btn--primary btn--sm" @click="saveManualSkuDraft">
            确定
          </button>
        </div>
      </template>
    </ElDialog>
  </main>
</template>

<style scoped>
.profile-import-input {
  display: none;
}

.profile-menu__check {
  display: inline-block;
  width: 14px;
  color: var(--industrial-primary);
  font-weight: 700;
}

/* 模式列表 + 编辑器 */
.master {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
}

.mode-list {
  padding: 6px;
  border-right: 1px solid var(--industrial-grid-light);
}

.mode-item {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-left: 2px solid transparent;
  border-radius: 2px;
  background: none;
  text-align: left;
  cursor: pointer;
}

.mode-item:hover {
  background: #e9eff2;
}

.mode-item.is-active {
  border-color: var(--industrial-grid-light);
  border-left-color: var(--industrial-primary);
  background: #e5edf1;
}

.mode-item__row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.mode-item__name {
  font-size: 12.5px;
  font-weight: 600;
}

.mode-item__hits {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.mode-item__range {
  display: block;
  margin-top: 1px;
  color: var(--industrial-muted);
  font-size: 11px;
}

.mode-editor {
  min-width: 0;
  padding: 10px 12px 12px;
}

.editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.editor-head__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.editor-head__meta {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 12px;
}

.section-label {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--industrial-text);
  font-size: 12px;
  font-weight: 600;
}

.section-label span {
  color: var(--industrial-muted);
  font-size: 11.5px;
  font-weight: 400;
}

.coef-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--industrial-grid);
  background: var(--industrial-surface);
  font-size: 12px;
  table-layout: fixed;
}

.coef-table th {
  height: 27px;
  padding: 0 8px;
  border-right: 1px solid var(--industrial-grid);
  border-bottom: 1px solid var(--industrial-grid);
  background: var(--industrial-header);
  color: #33424b;
  font-size: 11.5px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}

.coef-table th:last-child {
  border-right: 0;
}

.coef-table td {
  height: 36px;
  padding: 0 8px;
  border-right: 1px solid var(--line-soft);
  border-bottom: 1px solid var(--line-soft);
  color: var(--industrial-text);
  vertical-align: middle;
}

.coef-table td:last-child {
  border-right: 0;
}

.coef-table tr:last-child td {
  border-bottom: 0;
}

.coef-table__cat {
  width: 120px;
  color: var(--industrial-muted);
}

.coef-table__color {
  width: 76px;
}

.coef-table__skip {
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.coef-table th.is-num,
.coef-table td.is-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.manual-config {
  padding: 10px;
}

.manual-block__empty {
  margin: 0;
  padding: 14px 10px;
  border: 1px solid var(--industrial-grid-light);
  background: #f0f4f6;
  color: var(--industrial-muted);
  font-size: 12px;
}

.manual-list__dangling {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  padding: 6px 9px;
  border-left: 2px solid var(--industrial-replenish);
  background: #f8f3e8;
  color: #7d6330;
  font-size: 11.5px;
}

.rule-validation {
  margin-top: 10px;
  padding: 7px 9px;
  border-left: 2px solid var(--industrial-danger);
  background: #f9efee;
}

.rule-validation__error,
.rule-validation__warning {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
}

.rule-validation__error {
  color: var(--industrial-danger);
}

.rule-validation__warning {
  color: #8a6a24;
}

.weight-draft__months {
  width: 64px;
}

.weight-draft__percent {
  width: 76px;
}

.weight-draft__remove {
  margin-left: 2px;
}

.weight-draft__remove:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

:deep(.ui-dialog .el-input-number) {
  width: 100%;
}

:deep(.coef-grid .el-input-number) {
  width: 100%;
}

:deep(.el-input-number .el-input__wrapper) {
  min-height: 28px;
  border-radius: 3px;
  box-shadow: 0 0 0 1px var(--industrial-grid) inset;
}
</style>
