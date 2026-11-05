<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  ElButton,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElSelect,
  ElTable,
  ElTableColumn,
} from 'element-plus'
import { zipSync } from 'fflate'
// 系数由 store 维护，便于配置页修改后全局生效。
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import PanelNavigation from '@/components/PanelNavigation.vue'
import ImportSourcesDialog from '@/components/ImportSourcesDialog.vue'
import { useSourceImport } from '@/composables/useSourceImport'
import { useInventoryStore } from '@/stores/inventory'
import { groupRowsByProduct } from '@/utils/productGroups'
import {
  calculateInventoryRow,
  formatFactors,
  formatQuantity,
  formatRate,
  formatRatio,
  normalizeProductName,
} from '@/utils/inventory'
import { useStockingConfigStore } from '@/stores/stocking'
import { createEvaluator, evaluateItem } from '@/stocking'
import { IMPORT_TEMPLATE_COLUMNS, IMPORT_TEMPLATE_SAMPLE_ROWS } from '@/utils/inventoryImport'

const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const inventoryStore = useInventoryStore(props.panelKey)
// 备货配置全应用唯一：规则判定、热度分档与系数都按这份配置计算。
const stockingStore = useStockingConfigStore()
const stockingEvaluator = computed(() => createEvaluator(stockingStore.config))
const inventoryItems = inventoryStore.inventoryItems
const purchaseList = inventoryStore.purchaseList
const plannedUndoHistory = inventoryStore.plannedUndoHistory
const purchaseListRows = computed(() =>
  purchaseList.map((purchaseItem) => {
    const item = inventoryItems.find((entry) => entry.id === purchaseItem.id)
    return item
      ? { ...purchaseItem, product: item.product, color: item.color }
      : purchaseItem
  }),
)
const productDrafts = reactive({})
const plannedDrafts = reactive({})
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const selectedWarningTones = ref([])
const selectedRuleNames = ref([])
const selectedTierNames = ref([])
const productFilter = ref('')
const colorFilter = ref('')
const expandingProductKeys = ref(new Set())
const selectedRowId = ref(null)

// 导入成功提示（带 5 秒进度条）
const importToast = reactive({ visible: false, message: '', progress: 100 })
let importToastTimer = null
let importToastStart = 0
function showImportToast(message) {
  if (importToastTimer) clearInterval(importToastTimer)
  importToast.message = message
  importToast.progress = 100
  importToast.visible = true
  importToastStart = Date.now()
  const duration = 5000
  importToastTimer = setInterval(() => {
    const elapsed = Date.now() - importToastStart
    const remaining = Math.max(0, 1 - elapsed / duration)
    importToast.progress = remaining * 100
    if (elapsed >= duration) {
      clearInterval(importToastTimer)
      importToastTimer = null
      importToast.visible = false
    }
  }, 50)
}
const urgentPlanDialogVisible = ref(false)
const urgentPlanRows = ref([])
const purchaseListDialogVisible = ref(false)
const flyingPurchaseIcon = ref(null)
const purchaseListPulse = ref(false)
// 导入只对主面板开放，示例面板保持原始演示数据。
const canImportExcel = computed(() => props.panelKey === DEFAULT_PANEL_KEY)

// 主面板与销售表共用同一条导入流程：一次可选总表 + 销售表，按表头识别，顺序不限。
const {
  fileInputRef: importFileInputRef,
  dialogVisible: importDialogVisible,
  summary: importSummary,
  trigger: triggerImportExcel,
  handleFilesChange: handleImportFileChange,
  cancel: cancelImport,
  confirm: confirmImport,
} = useSourceImport({ panelKey: props.panelKey, onApplied: handleSourcesImported })
let purchaseFlyTimer = 0
let purchasePulseTimer = 0

// —— 派生数据 ——
// 3 万行量级下不能靠 computed 全量重算，改为「单行缓存 + 增量刷新」：
// 结构性变化（导入/新增/改品名）才重建排序，编辑数值时只重算该行。
const itemById = computed(() => {
  const map = new Map()
  for (const item of inventoryItems) map.set(item.id, item)
  return map
})

function buildLeafRow(item) {
  // 规则 / 热度档 / 系数按当前配置现算：配置改动后重新渲染即同步，无需额外回写。
  const row = calculateInventoryRow(evaluateItem(item, stockingEvaluator.value))
  return {
    ...row,
    searchProduct: row.product.toLocaleLowerCase('zh-CN'),
    searchColor: row.color.toLocaleLowerCase('zh-CN'),
  }
}

const inventoryLeafRows = shallowRef([])
const leafRowIndexById = new Map()

// 规则 / 热度档筛选项取当前数据里实际出现的名称，配置改动后自动跟随。
const ruleOptions = computed(() =>
  [...new Set(inventoryLeafRows.value.map((row) => row.ruleName).filter(Boolean))].sort(
    (first, second) => productCollator.compare(first, second),
  ),
)
const tierOptions = computed(() =>
  [...new Set(inventoryLeafRows.value.map((row) => row.tierName).filter(Boolean))].sort(
    (first, second) => productCollator.compare(first, second),
  ),
)

function rebuildLeafRows() {
  const rows = inventoryItems.map((item) => buildLeafRow(item))
  // 按品名聚合月均条数，品名按聚合值降序排列；同品名内按月均条数降序，再按颜色。
  const productMonthlyAvg = new Map()
  for (const row of rows) {
    productMonthlyAvg.set(row.product, (productMonthlyAvg.get(row.product) ?? 0) + (row.monthlyAvgCount ?? 0))
  }
  rows.sort((first, second) => {
    const productDiff =
      (productMonthlyAvg.get(second.product) ?? 0) - (productMonthlyAvg.get(first.product) ?? 0)
    if (productDiff !== 0) return productDiff
    const monthlyDiff = (second.monthlyAvgCount ?? 0) - (first.monthlyAvgCount ?? 0)
    if (monthlyDiff !== 0) return monthlyDiff
    return productCollator.compare(first.color, second.color) || first.id - second.id
  })
  leafRowIndexById.clear()
  rows.forEach((row, index) => leafRowIndexById.set(row.id, index))
  inventoryLeafRows.value = rows
}

function refreshLeafRow(id) {
  const index = leafRowIndexById.get(id)
  const item = itemById.value.get(id)
  if (index === undefined || !item) return

  const rows = inventoryLeafRows.value.slice()
  rows[index] = buildLeafRow(item)
  inventoryLeafRows.value = rows
}

rebuildLeafRows()
// 新增、导入等改变行数的情况兜底重建。
watch(() => inventoryItems.length, rebuildLeafRows)
// 备货配置（规则 / 热度档 / 系数）修改后，整表按新配置重算。
watch(() => stockingStore.config, rebuildLeafRows)

// 需安排草稿只影响该行的预警预览色（采纳后会叠加进预计库存），单独存放，避免整表重算。
const plannedPreviewTones = reactive({})

function refreshPlannedPreviewTone(item) {
  if (!item || !Reflect.has(plannedDrafts, item.id)) {
    if (item) delete plannedPreviewTones[item.id]
    return
  }

  plannedPreviewTones[item.id] = calculateInventoryRow(
    evaluateItem(
      { ...item, planned: plannedDrafts[item.id] ?? 0 },
      stockingEvaluator.value,
    ),
  ).urgencyTone
}

function getPlannedTone(row) {
  if (!Reflect.has(plannedDrafts, row.id)) return row.urgencyTone
  return plannedPreviewTones[row.id] ?? row.urgencyTone
}

const warningFilters = [
  { key: 'all', label: '全部' },
  { key: 'red', label: '紧急' },
  { key: 'yellow', label: '常规' },
  { key: 'green', label: '正常' },
  { key: 'purple', label: '超库存' },
]
const warningCounts = computed(() => {
  const counts = { all: 0, red: 0, yellow: 0, green: 0, purple: 0 }
  for (const row of inventoryLeafRows.value) {
    counts.all += 1
    if (row.urgencyTone in counts) counts[row.urgencyTone] += 1
  }
  return counts
})
const hasActiveFilters = computed(
  () =>
    productFilter.value.trim() !== '' ||
    colorFilter.value.trim() !== '' ||
    selectedWarningTones.value.length > 0 ||
    selectedRuleNames.value.length > 0 ||
    selectedTierNames.value.length > 0,
)

// 关键词筛选输入防抖，避免大表逐键全量过滤。
const appliedProductFilter = ref('')
const appliedColorFilter = ref('')
let filterDebounceTimer = 0

function applyKeywordFilters() {
  appliedProductFilter.value = productFilter.value.trim().toLocaleLowerCase('zh-CN')
  appliedColorFilter.value = colorFilter.value.trim().toLocaleLowerCase('zh-CN')
}

watch([productFilter, colorFilter], () => {
  if (filterDebounceTimer) clearTimeout(filterDebounceTimer)
  if (!productFilter.value.trim() && !colorFilter.value.trim()) {
    applyKeywordFilters()
    return
  }
  filterDebounceTimer = window.setTimeout(() => {
    filterDebounceTimer = 0
    applyKeywordFilters()
  }, 250)
})

const filteredInventoryLeafRows = computed(() => {
  const product = appliedProductFilter.value
  const color = appliedColorFilter.value
  const tones = selectedWarningTones.value
  const rules = selectedRuleNames.value
  const tiers = selectedTierNames.value
  if (!product && !color && tones.length === 0 && rules.length === 0 && tiers.length === 0) {
    return inventoryLeafRows.value
  }

  const toneSet = tones.length > 0 ? new Set(tones) : null
  const ruleSet = rules.length > 0 ? new Set(rules) : null
  const tierSet = tiers.length > 0 ? new Set(tiers) : null
  return inventoryLeafRows.value.filter(
    (row) =>
      (!product || row.searchProduct.includes(product)) &&
      (!color || row.searchColor.includes(color)) &&
      (!toneSet || toneSet.has(row.urgencyTone)) &&
      (!ruleSet || ruleSet.has(row.ruleName)) &&
      (!tierSet || tierSet.has(row.tierName)),
  )
})
const inventoryRows = computed(() => groupRowsByProduct(filteredInventoryLeafRows.value))

function resetFilters() {
  productFilter.value = ''
  colorFilter.value = ''
  selectedWarningTones.value = []
  selectedRuleNames.value = []
  selectedTierNames.value = []
}

function toggleWarningFilter(key) {
  if (key === 'all') {
    resetFilters()
    return
  }

  const selectedTones = new Set(selectedWarningTones.value)
  if (selectedTones.has(key)) selectedTones.delete(key)
  else selectedTones.add(key)
  selectedWarningTones.value = [...selectedTones]
}

const expandedProductKeys = ref(inventoryRows.value.map((row) => row.id))
let knownProductKeys = new Set(expandedProductKeys.value)
const productTransitionTimers = new Map()
const productTransitionDuration = 120

function clearProductTransition(productKey) {
  const timer = productTransitionTimers.get(productKey)
  if (timer) clearTimeout(timer)
  productTransitionTimers.delete(productKey)
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

watch(inventoryRows, (groups) => {
  const currentKeys = new Set(groups.map((row) => row.id))
  const expandedKeys = new Set(expandedProductKeys.value.filter((key) => currentKeys.has(key)))
  for (const group of groups) {
    if (!knownProductKeys.has(group.id)) expandedKeys.add(group.id)
  }
  knownProductKeys = currentKeys
  expandedProductKeys.value = [...expandedKeys]
})

function toggleProductGroup(row) {
  if (!row.isProductGroup) return

  const keys = new Set(expandedProductKeys.value)
  if (keys.has(row.id)) {
    keys.delete(row.id)
    clearProductTransition(row.id)
  } else {
    keys.add(row.id)
    animateProductExpansion(row.id)
  }
  expandedProductKeys.value = [...keys]
}

function toggleAllProductGroups() {
  const groupIds = inventoryRows.value.map((row) => row.id)
  const allExpanded = groupIds.length > 0 && groupIds.every((id) => expandedProductKeys.value.includes(id))
  if (allExpanded) {
    expandedProductKeys.value = []
    for (const id of groupIds) clearProductTransition(id)
  } else {
    expandedProductKeys.value = [...groupIds]
    for (const id of groupIds) animateProductExpansion(id)
  }
}

// —— 虚拟滚动 ——
// 只渲染视口内的行，DOM 节点数量与数据量解耦。
const TABLE_ROW_HEIGHT = 34
const TABLE_OVERSCAN = 8
const TABLE_COLUMNS = [
  { key: 'skuId', label: '唯一标识', width: 110, group: '信息' },
  { key: 'rule', label: '规则', width: 96, group: '信息' },
  { key: 'tier', label: '热度', width: 84, group: '信息' },
  { key: 'product', label: '品名', width: 150, group: '商品' },
  { key: 'color', label: '颜色', width: 132, group: '商品' },
  { key: 'urgency', label: '预警', width: 44, group: '商品' },
  { key: 'planned', label: '需安排', width: 142, group: '入口' },
  { key: 'producing', label: '生产中', width: 76, group: '入口' },
  { key: 'backorder', label: '欠货', width: 68, group: '出口' },
  { key: 'weeklyUsage', label: '周消耗', width: 76, group: '出口' },
  { key: 'turnoverIn', label: '周转入', width: 74, group: '库存' },
  { key: 'inTransitStock', label: '在途库存', width: 84, group: '库存' },
  { key: 'warehouseStock', label: '在仓库存', width: 84, group: '库存' },
  { key: 'theoreticalStock', label: '理论库存', width: 84, group: '库存' },
  { key: 'projectedStock', label: '预计库存', width: 84, group: '库存' },
  { key: 'shortage', label: '缺口量', width: 72, group: '数据反馈' },
  { key: 'shortageRate', label: '缺口率', width: 76, group: '数据反馈' },
  { key: 'stockSalesRatio', label: '库销比', width: 68, group: '数据反馈' },
]
// 各列按自身宽度分配剩余空间，始终铺满可用宽度，避免右侧出现空列
const tableGridTemplate = TABLE_COLUMNS.map(
  (column) => `minmax(${column.width}px, ${column.width}fr)`,
).join(' ')
const TABLE_TOTAL_WIDTH = TABLE_COLUMNS.reduce((total, column) => total + column.width, 0)
const tableColumnGroups = (() => {
  const groups = []
  for (const column of TABLE_COLUMNS) {
    const last = groups[groups.length - 1]
    if (last && last.label === column.group) last.span += 1
    else groups.push({ label: column.group, span: 1 })
  }
  return groups
})()

const tableScrollRef = ref(null)
const tableScrollTop = ref(0)
const tableViewportHeight = ref(600)
let tableScrollFrame = 0
let tableResizeObserver = null

function handleTableScroll() {
  if (tableScrollFrame) return
  tableScrollFrame = requestAnimationFrame(() => {
    tableScrollFrame = 0
    tableScrollTop.value = tableScrollRef.value?.scrollTop ?? 0
  })
}

const expandedProductKeySet = computed(() => new Set(expandedProductKeys.value))

// 展开后的可见行（品名父行 + 已展开的颜色子行），虚拟滚动在此基础上切片。
const tableRows = computed(() => {
  const expanded = expandedProductKeySet.value
  const rows = []
  for (const group of inventoryRows.value) {
    rows.push(group)
    if (!expanded.has(group.id)) continue
    for (const child of group.children) rows.push(child)
  }
  return rows
})

const tableVirtualRows = computed(() => {
  const rows = tableRows.value
  const total = rows.length
  if (total === 0) return { rows: [], offset: 0, total: 0 }

  const start = Math.max(0, Math.floor(tableScrollTop.value / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN)
  const count = Math.ceil(tableViewportHeight.value / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN * 2
  const end = Math.min(total, start + count)

  return {
    rows: rows.slice(start, end),
    offset: start * TABLE_ROW_HEIGHT,
    total,
  }
})
const tableBodyHeight = computed(() => tableVirtualRows.value.total * TABLE_ROW_HEIGHT)

onMounted(() => {
  const element = tableScrollRef.value
  if (!element) return
  tableViewportHeight.value = element.clientHeight || tableViewportHeight.value
  if (typeof ResizeObserver === 'undefined') return

  tableResizeObserver = new ResizeObserver((entries) => {
    tableViewportHeight.value = entries[0]?.contentRect.height ?? tableViewportHeight.value
  })
  tableResizeObserver.observe(element)
})

onBeforeUnmount(() => {
  productTransitionTimers.forEach((timer) => clearTimeout(timer))
  if (purchaseFlyTimer) clearTimeout(purchaseFlyTimer)
  if (purchasePulseTimer) clearTimeout(purchasePulseTimer)
  if (filterDebounceTimer) clearTimeout(filterDebounceTimer)
  if (tableScrollFrame) cancelAnimationFrame(tableScrollFrame)
  if (importToastTimer) clearInterval(importToastTimer)
  tableResizeObserver?.disconnect()
})

const urgentRows = computed(() =>
    inventoryLeafRows.value.filter((row) => row.urgencyTone === 'red'),
)
const hasUrgentPlan = computed(() =>
  urgentPlanRows.value.some((row) => row.additionalPlan > 0),
)

function openUrgentPlanDialog() {
  urgentPlanRows.value = urgentRows.value.map((row) => ({
    id: row.id,
    product: row.product,
    color: row.color,
    currentPlanned: row.planned ?? 0,
    additionalPlan: 0,
    recommendedPlan: Math.max(0, Math.ceil(row.normalStock * 0.8 - row.projectedStock)),
  }))
  urgentPlanDialogVisible.value = true
}

function submitUrgentPlans() {
  for (const planRow of urgentPlanRows.value) {
    if (planRow.additionalPlan <= 0) continue

    const item = itemById.value.get(planRow.id)
    if (item) {
      plannedUndoHistory[planRow.id] = {
        previousPlanned: item.planned,
        previousPurchaseItem: snapshotPurchaseItem(planRow.id),
      }
      item.planned = (item.planned ?? 0) + planRow.additionalPlan
      delete plannedDrafts[planRow.id]
      delete plannedPreviewTones[planRow.id]
      refreshLeafRow(planRow.id)
      syncPurchaseItem(item)
    }
  }

  urgentPlanDialogVisible.value = false
  urgentPlanRows.value = []
}

function applyAllRecommendedPlans() {
  urgentPlanRows.value.forEach((row) => {
    row.additionalPlan = row.recommendedPlan
  })
}

function hasPlannedDraft(id) {
  return Object.prototype.hasOwnProperty.call(plannedDrafts, id)
}

function hasPlannedUndo(id) {
  return Object.prototype.hasOwnProperty.call(plannedUndoHistory, id)
}

function getPlannedDraft(row) {
  return hasPlannedDraft(row.id) ? plannedDrafts[row.id] : row.planned
}

// 需安排建议值：补到“正常库存 80% 下限”的差额（基于理论库存，采纳后叠加为预计库存）。
function getPlannedPlaceholder(row) {
  if (!row.strategyAvailable) return ''

  const targetPlanned = Math.max(
    row.planned ?? 0,
    0,
    Math.ceil(row.normalStock * 0.8 - row.theoreticalStock),
  )
  return `${formatQuantity(targetPlanned)}`
}

function getPlannedPlaceholderTitle(row) {
  if (!row.strategyAvailable) return `备货规则缺省，无法计算建议需安排量：${row.strategyIssue || '系数不可用'}`

  return `建议填写 ${getPlannedPlaceholder(row)}，采纳后预计库存达到正常库存的 80% 下限；该建议不会自动采纳`}

function updatePlannedDraft(id, value) {
  if (Reflect.has(plannedUndoHistory, id)) return

  plannedDrafts[id] = value
  refreshPlannedPreviewTone(itemById.value.get(id))
}

function snapshotPurchaseItem(id) {
  const purchaseItem = purchaseList.find((entry) => entry.id === id)
  return purchaseItem ? { ...purchaseItem } : null
}

function syncPurchaseItem(item) {
  const purchaseIndex = purchaseList.findIndex((entry) => entry.id === item.id)
  if (purchaseIndex === -1) {
    purchaseList.push({
      id: item.id,
      product: item.product,
      color: item.color,
      planned: item.planned ?? 0,
      actualPlan: null,
    })
    return
  }

  purchaseList[purchaseIndex].product = item.product
  purchaseList[purchaseIndex].color = item.color
  purchaseList[purchaseIndex].planned = item.planned ?? 0
}

function restorePurchaseItem(id, previousPurchaseItem) {
  const purchaseIndex = purchaseList.findIndex((entry) => entry.id === id)
  if (previousPurchaseItem) {
    if (purchaseIndex === -1) purchaseList.push({ ...previousPurchaseItem })
    else purchaseList.splice(purchaseIndex, 1, { ...previousPurchaseItem })
  } else if (purchaseIndex !== -1) {
    purchaseList.splice(purchaseIndex, 1)
  }
}

function updatePurchaseActualPlan(id, value) {
  const purchaseItem = purchaseList.find((entry) => entry.id === id)
  if (purchaseItem) purchaseItem.actualPlan = value
}

function acceptPlannedDraft(row) {
  if (!hasPlannedDraft(row.id)) {
    undoPlannedAcceptance(row)
    return
  }

  const item = itemById.value.get(row.id)
  if (!item) return

  plannedUndoHistory[row.id] = {
    previousPlanned: item.planned,
    previousPurchaseItem: snapshotPurchaseItem(row.id),
  }
  item.planned = plannedDrafts[row.id] ?? 0
  delete plannedDrafts[row.id]
  delete plannedPreviewTones[row.id]
  refreshLeafRow(row.id)
  syncPurchaseItem(item)
}

function handlePlannedAction(row, event) {
  const isAccepting = hasPlannedDraft(row.id)
  acceptPlannedDraft(row)
  if (isAccepting) animatePurchaseListButton(event.currentTarget)
}

function animatePurchaseListButton(sourceElement) {
  const targetElement = document.querySelector('.purchase-list-button')
  if (!sourceElement || !targetElement) return

  const source = sourceElement.getBoundingClientRect()
  const target = targetElement.getBoundingClientRect()
  const iconSize = 20

  if (purchaseFlyTimer) clearTimeout(purchaseFlyTimer)

  flyingPurchaseIcon.value = {
    left: source.left + source.width / 2 - iconSize / 2,
    top: source.top + source.height / 2 - iconSize / 2,
    offsetX: target.left + target.width / 2 - source.left - source.width / 2,
    offsetY: target.top + target.height / 2 - source.top - source.height / 2,
  }

  purchaseFlyTimer = window.setTimeout(clearFlyingPurchaseIcon, 1350)
}

function clearFlyingPurchaseIcon() {
  if (purchaseFlyTimer) clearTimeout(purchaseFlyTimer)
  purchaseFlyTimer = 0
  flyingPurchaseIcon.value = null
}

function pulsePurchaseListButton() {
  purchaseListPulse.value = true
  if (purchasePulseTimer) clearTimeout(purchasePulseTimer)
  purchasePulseTimer = window.setTimeout(() => {
    purchaseListPulse.value = false
    purchasePulseTimer = 0
  }, 650)
}

function onPurchaseIconAnimationEnd() {
  if (!flyingPurchaseIcon.value) return
  clearFlyingPurchaseIcon()
  pulsePurchaseListButton()
}

function undoPlannedAcceptance(row) {
  const undo = plannedUndoHistory[row.id]
  if (!undo) return

  const item = itemById.value.get(row.id)
  if (!item) return

  item.planned = undo.previousPlanned
  restorePurchaseItem(row.id, undo.previousPurchaseItem)
  delete plannedDrafts[row.id]
  delete plannedPreviewTones[row.id]
  delete plannedUndoHistory[row.id]
  refreshLeafRow(row.id)
}

function getRowClassName({ row }) {
  return [
    row.isProductGroup ? 'product-group-row' : 'product-color-row',
    expandingProductKeys.value.has(`product:${row.product}`)
      ? 'product-group-expanding'
      : '',
    !row.isProductGroup && row.id === selectedRowId.value ? 'inventory-row-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function handleRowClick(row) {
  if (row.isProductGroup) {
    // 点击 SPU 汇总行时保留之前选中的 SKU 高亮，不清除。
    return
  }

  selectedRowId.value = row.id
}

function handleProductCellClick(row) {
  toggleProductGroup(row)
  if (!row.isProductGroup) {
    selectedRowId.value = row.id
  }
}

function getColorInputWidth(color) {
  const textWidth = [...color].reduce(
    (width, character) => width + (/[^\x00-\xff]/.test(character) ? 14 : 8),
    0,
  )

  return `${Math.min(84, Math.max(44, textWidth + 12))}px`
}

function updateValue(id, field, value) {
  if (value !== null || field === 'planned') {
    const item = itemById.value.get(id)
    if (!item) return
    item[field] = value
    refreshLeafRow(id)
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function getExcelColumnName(index) {
  let name = ''
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

function createExcelCell(value, reference, styleIndex = 0) {
  const style = styleIndex > 0 ? ` s="${styleIndex}"` : ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`
  }

  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value ?? '')}</t></is></c>`
}

function exportInventoryToExcel() {
  const columnGroups = [
    { label: '信息', columns: ['唯一标识', '规则', '热度', '等级', '色彩'] },
    { label: '商品', columns: ['品名', '颜色', '预警'] },
    { label: '入口', columns: ['需安排', '生产中'] },
    { label: '出口', columns: ['欠货', '周消耗'] },
    { label: '库存', columns: ['周转入', '在途库存', '在仓库存', '理论库存', '预计库存'] },
    { label: '数据反馈', columns: ['缺口量', '缺口率', '库销比'] },
    { label: '备货策略', columns: ['红线库存', '正常库存', '峰值库存', '系数'] },
  ]
  const groupHeaders = []
  const merges = []
  let columnIndex = 0

  columnGroups.forEach(({ label, columns }) => {
    const start = columnIndex
    groupHeaders.push(label, ...Array(columns.length - 1).fill(''))
    columnIndex += columns.length
    if (columns.length > 1) {
      merges.push({ s: { r: 0, c: start }, e: { r: 0, c: columnIndex - 1 } })
    }
  })

  const headers = columnGroups.flatMap(({ columns }) => columns)
  const data = inventoryLeafRows.value.map((row) => [
    row.skuId,
    row.ruleName,
    row.tierName,
    row.gradeSummary,
    row.category,
    row.product,
    row.color,
    row.urgencyText,
    row.planned,
    row.producing,
    row.backorder,
    row.weeklyUsage,
    row.turnoverIn,
    row.inTransitStock,
    row.warehouseStock,
    row.theoreticalStock,
    row.projectedStock,
    row.shortage ?? '缺省',
    formatRate(row.shortageRate, row.strategyAvailable),
    formatRatio(row.stockSalesRatio),
    row.redLineStock ?? '缺省',
    row.normalStock ?? '缺省',
    row.peakStock ?? '缺省',
    formatFactors(row),
  ])
  const rows = [groupHeaders, headers, ...data]
  const worksheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (rowIndex === 0 && columnIndex > 0 && groupHeaders[columnIndex] === '') return ''
          const styleIndex = rowIndex === 0 ? 1 : rowIndex === 1 ? 2 : 0
          const reference = `${getExcelColumnName(columnIndex)}${rowIndex + 1}`
          return createExcelCell(value, reference, styleIndex)
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  const mergeReferences = merges
    .map(
      ({ s, e }) =>
        `${getExcelColumnName(s.c)}${s.r + 1}:${getExcelColumnName(e.c)}${e.r + 1}`,
    )
    .join(' ')
  const columnWidths = headers
    .map((label, index) => {
      const width = label === '品名' ? 20 : label === '颜色' ? 14 : 12
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
    })
    .join('')
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columnWidths}</cols><sheetData>${worksheetRows}</sheetData><autoFilter ref="A2:${getExcelColumnName(headers.length - 1)}${rows.length}"/><mergeCells count="${merges.length}">${mergeReferences
    .split(' ')
    .filter(Boolean)
    .map((ref) => `<mergeCell ref="${ref}"/>`)
    .join('')}</mergeCells></worksheet>`
  const styleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF2F3B43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5EDF1"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="库存数据" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml,
    'xl/styles.xml': styleXml,
  }

  try {
    const workbookBytes = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]),
      ),
      { level: 6 },
    )
    const workbookBlob = new Blob([workbookBytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const downloadUrl = URL.createObjectURL(workbookBlob)
    const link = document.createElement('a')
    const timestamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')
    link.href = downloadUrl
    link.download = `库存数据-${timestamp}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    ElMessage.success('Excel 文件已保存')
  } catch (error) {
    console.error('Failed to export inventory workbook', error)
    ElMessage.error(`Excel 导出失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function exportPurchaseListToExcel() {
  const rows = [
    ['品名', '颜色', '需安排', '实际计划'],
    ...purchaseListRows.value.map((item) => [
      item.product,
      item.color,
      item.planned,
      item.actualPlan ?? '',
    ]),
  ]
  const worksheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${getExcelColumnName(columnIndex)}${rowIndex + 1}`
          return createExcelCell(value, reference, rowIndex === 0 ? 1 : 0)
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/><col min="3" max="4" width="16" customWidth="1"/></cols><sheetData>${worksheetRows}</sheetData><autoFilter ref="A1:D${rows.length}"/></worksheet>`
  const styleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF2F3B43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="本次采购清单" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml,
    'xl/styles.xml': styleXml,
  }

  try {
    const workbookBytes = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]),
      ),
      { level: 6 },
    )
    const workbookBlob = new Blob([workbookBytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const downloadUrl = URL.createObjectURL(workbookBlob)
    const link = document.createElement('a')
    const timestamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')
    link.href = downloadUrl
    link.download = `本次采购清单-${timestamp}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    ElMessage.success('本次采购清单已导出')
  } catch (error) {
    console.error('Failed to export purchase list workbook', error)
    ElMessage.error(`采购清单导出失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

// 导入成功后清空需安排/品名草稿并重建表格；总表与销售表的写入已在 useSourceImport 内完成。
function handleSourcesImported(summary) {
  for (const key of Object.keys(plannedDrafts)) delete plannedDrafts[key]
  for (const key of Object.keys(plannedPreviewTones)) delete plannedPreviewTones[key]
  for (const key of Object.keys(productDrafts)) delete productDrafts[key]

  rebuildLeafRows()
  selectedRowId.value = null

  const messages = []
  if (summary.inventory) {
    const { items, errors, blankRows } = summary.inventory
    const spuCount = new Set(items.map((item) => item.product)).size
    const skippedRows = errors.length + blankRows
    messages.push(
      `总表 ${items.length} 行（${spuCount} 个SPU）${skippedRows > 0 ? `，跳过 ${skippedRows} 行` : ''}`,
    )
  }
  if (summary.sales) {
    const { merge, errors, blankRows } = summary.sales
    const skippedRows = merge.unmatched + errors.length + blankRows
    messages.push(
      `销售表 ${merge.matched} 个SKU${skippedRows > 0 ? `，跳过 ${skippedRows} 行` : ''}`,
    )
  }
  showImportToast(`成功导入：${messages.join('；')}`)
}

function buildSimpleWorkbook({ sheetName, rows, columnWidths }) {
  const worksheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${getExcelColumnName(columnIndex)}${rowIndex + 1}`
          return createExcelCell(value, reference, rowIndex === 0 ? 1 : 0)
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  const cols = columnWidths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('')
  const dimension = `A1:${getExcelColumnName(rows[0].length - 1)}${rows.length}`
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${worksheetRows}</sheetData></worksheet>`
  const styleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF2F3B43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml,
    'xl/styles.xml': styleXml,
  }

  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]),
    ),
    { level: 6 },
  )
}

function saveWorkbookFile(workbookBytes, fileName) {
  const blob = new Blob([workbookBytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const downloadUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
}

function downloadImportTemplate() {
  try {
    const workbookBytes = buildSimpleWorkbook({
      sheetName: '导入模板',
      rows: [IMPORT_TEMPLATE_COLUMNS, ...IMPORT_TEMPLATE_SAMPLE_ROWS],
      columnWidths: IMPORT_TEMPLATE_COLUMNS.map((column) =>
        column === '品名' ? 18 : column === '颜色' ? 16 : 12,
      ),
    })
    saveWorkbookFile(workbookBytes, '库存导入模板.xlsx')
    ElMessage.success('导入模板已保存，模板中的示例行请替换为真实数据')
  } catch (error) {
    console.error('Failed to build inventory import template', error)
    ElMessage.error(`模板生成失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function updateProductDraft(product, value) {
  productDrafts[product] = value
}

function commitProduct(currentProduct) {
  const updatedProduct = productDrafts[currentProduct]
  if (updatedProduct === undefined) return

  const product = normalizeProductName(updatedProduct)
  if (product && product !== currentProduct) {
    const affectedIds = []
    inventoryItems.forEach((item) => {
      if (item.product !== currentProduct) return
      item.product = product
      affectedIds.push(item.id)
    })
    rebuildLeafRows()

    const keys = new Set(expandedProductKeys.value)
    keys.delete(`product:${currentProduct}`)
    keys.add(`product:${product}`)
    expandedProductKeys.value = [...keys]
    knownProductKeys = new Set(inventoryRows.value.map((row) => row.id))
  }

  delete productDrafts[currentProduct]
}

</script>

<template>
  <main class="inventory-page">
    <div v-if="importToast.visible" class="import-toast" role="status" aria-live="polite">
      <span class="import-toast__icon" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path d="M6.5 11.5 3 8l1.06-1.06 2.44 2.44 5.44-5.44L13 5l-6.5 6.5Z" fill="currentColor" />
        </svg>
      </span>
      <span class="import-toast__message">{{ importToast.message }}</span>
      <div class="import-toast__progress">
        <div class="import-toast__progress-bar" :style="{ width: `${importToast.progress}%` }"></div>
      </div>
    </div>
    <span
      v-if="flyingPurchaseIcon"
      class="purchase-fly-icon"
      :style="{
        left: `${flyingPurchaseIcon.left}px`,
        top: `${flyingPurchaseIcon.top}px`,
        '--purchase-fly-x': `${flyingPurchaseIcon.offsetX}px`,
        '--purchase-fly-y': `${flyingPurchaseIcon.offsetY}px`,
      }"
      aria-hidden="true"
      @animationend="onPurchaseIconAnimationEnd"
    >
      <svg viewBox="0 0 20 20">
        <path
          d="M4 6.5h12l-1 9H5l-1-9Zm3 0V5a3 3 0 0 1 6 0v1.5M8 10v2m4-2v2"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.6"
        />
      </svg>
    </span>
    <div class="page-sticky-header">
      <PanelNavigation />
      <div class="inventory-filters" aria-label="库存筛选">
        <ElInput
          v-model="productFilter"
          class="text-filter"
          placeholder="按品名筛选"
          aria-label="按品名筛选"
          clearable
        />
        <ElInput
          v-model="colorFilter"
          class="text-filter"
          placeholder="按颜色筛选"
          aria-label="按颜色筛选"
          clearable
        />
        <ElSelect
          v-model="selectedRuleNames"
          class="text-filter"
          multiple
          collapse-tags
          clearable
          placeholder="按规则筛选"
          aria-label="按规则筛选"
        >
          <ElOption v-for="name in ruleOptions" :key="name" :label="name" :value="name" />
        </ElSelect>
        <ElSelect
          v-model="selectedTierNames"
          class="text-filter"
          multiple
          collapse-tags
          clearable
          placeholder="按热度筛选"
          aria-label="按热度筛选"
        >
          <ElOption v-for="name in tierOptions" :key="name" :label="name" :value="name" />
        </ElSelect>
        <div class="warning-filters" role="group" aria-label="按预警状态筛选">
          <button
            v-for="filter in warningFilters"
            :key="filter.key"
            type="button"
            class="warning-filter"
            :class="[
              `warning-filter--${filter.key}`,
              {
                'warning-filter--active':
                  filter.key === 'all'
                    ? !hasActiveFilters
                    : selectedWarningTones.includes(filter.key),
              },
            ]"
            :aria-pressed="
              filter.key === 'all'
                ? !hasActiveFilters
                : selectedWarningTones.includes(filter.key)
            "
            @click="toggleWarningFilter(filter.key)"
          >
            <span
              v-if="filter.key !== 'all'"
              class="warning-filter-indicator"
              :class="`urgency-indicator--${filter.key}`"
              aria-hidden="true"
            />
            {{ filter.label }}
            <span class="warning-filter-count">{{ warningCounts[filter.key] }}</span>
          </button>
        </div>
        <ElButton class="reset-filters-button" @click="resetFilters">重置</ElButton>
        <div class="table-actions">
          <ElButton class="toggle-groups-button" size="small" @click="toggleAllProductGroups">
            {{ inventoryRows.length > 0 && inventoryRows.every((row) => expandedProductKeys.includes(row.id)) ? '全部收起' : '全部展开' }}
          </ElButton>
          <ElButton class="export-excel-button" @click="exportInventoryToExcel">
            保存Excel
          </ElButton>
          <template v-if="canImportExcel">
            <ElButton
              class="import-excel-button"
              title="可一次选择总表与销售表两个文件"
              @click="triggerImportExcel"
            >
              导入Excel
            </ElButton>
            <ElButton class="import-template-button" @click="downloadImportTemplate">
              导入模板
            </ElButton>
            <input
              ref="importFileInputRef"
              class="import-file-input"
              type="file"
              multiple
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              @change="handleImportFileChange"
            />
          </template>
          <ElButton
            class="urgent-plan-button"
            :disabled="urgentRows.length === 0"
            @click="openUrgentPlanDialog"
          >
            紧急补货 <span class="urgent-count">{{ urgentRows.length }}</span>
          </ElButton>
          <ElButton
            class="purchase-list-button"
            :class="{ 'purchase-list-button--received': purchaseListPulse }"
            @click="purchaseListDialogVisible = true"
          >
            本次采购清单 <span class="urgent-count">{{ purchaseList.length }}</span>
          </ElButton>
        </div>
      </div>
    </div>
    <div
      ref="tableScrollRef"
      class="inventory-vtable"
      role="table"
      aria-label="库存明细"
      @scroll.passive="handleTableScroll"
    >
      <div class="inventory-vtable__canvas" :style="{ width: `max(100%, ${TABLE_TOTAL_WIDTH}px)` }">
        <div class="inventory-vtable__head">
          <div
            class="inventory-vtable__row inventory-vtable__row--group"
            :style="{ gridTemplateColumns: tableGridTemplate }"
          >
            <div
              v-for="group in tableColumnGroups"
              :key="group.label"
              class="inventory-vtable__head-cell inventory-vtable__head-cell--group"
              :style="{ gridColumn: `span ${group.span}` }"
            >
              {{ group.label }}
            </div>
          </div>
          <div
            class="inventory-vtable__row inventory-vtable__row--header"
            :style="{ gridTemplateColumns: tableGridTemplate }"
          >
            <div
              v-for="column in TABLE_COLUMNS"
              :key="column.key"
              class="inventory-vtable__head-cell"
              :class="{
                'inventory-vtable__head-cell--deep-right':
                  column.key === 'planned' || column.key === 'warehouseStock',
              }"
            >
              {{ column.label }}
            </div>
          </div>
        </div>

        <div class="inventory-vtable__body" :style="{ height: `${tableBodyHeight}px` }">
          <div
            class="inventory-vtable__rows"
            :style="{ transform: `translateY(${tableVirtualRows.offset}px)` }"
          >
            <div
              v-for="row in tableVirtualRows.rows"
              :key="row.id"
              class="inventory-vtable__row inventory-vtable__row--body"
              :class="getRowClassName({ row })"
              :style="{
                height: `${TABLE_ROW_HEIGHT}px`,
                gridTemplateColumns: tableGridTemplate,
              }"
              @click="handleRowClick(row)"
            >
              <div class="inventory-vtable__cell inventory-vtable__cell--stocking">
                <span
                  v-if="!row.isProductGroup"
                  class="stocking-text"
                  :title="row.skuId ? `唯一标识：${row.skuId}` : ''"
                >
                  {{ row.skuId }}
                </span>
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--stocking">
                <span
                  v-if="!row.isProductGroup && row.ruleName"
                  class="stocking-text"
                  :class="{ 'stocking-text--conflict': row.ruleConflict }"
                  :title="
                    row.ruleConflict
                      ? '命中多条规则，已按列表中靠前的规则处理，请收窄规则条件'
                      : row.ruleName
                  "
                >
                  {{ row.ruleName }}
                </span>
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--stocking">
                <span
                  v-if="!row.isProductGroup && row.tierName"
                  class="stocking-text"
                  :title="`等级明细：${row.gradeSummary || '--'}`"
                >
                  {{ row.tierName }}
                </span>
              </div>
              <div
                class="inventory-vtable__cell inventory-vtable__cell--product"
                @click.stop="handleProductCellClick(row)"
              >
                <template v-if="row.isProductGroup">
                  <span
                    class="inventory-vtable__caret"
                    :class="{
                      'inventory-vtable__caret--expanded': expandedProductKeySet.has(row.id),
                    }"
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 12 12">
                      <path
                        d="M4 2.5 8 6l-4 3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.4"
                      />
                    </svg>
                  </span>
                  <span class="inventory-vtable__product-input" @click.stop>
                    <ElInput
                      :model-value="productDrafts[row.product] ?? row.product"
                      class="product-input"
                      aria-label="品名"
                      @update:model-value="updateProductDraft(row.product, $event)"
                      @blur="commitProduct(row.product)"
                    />
                  </span>
                </template>
                <span v-else class="product-name-text" :title="row.product">{{ row.product }}</span>
              </div>
              <div class="inventory-vtable__cell">
                <ElInput
                  v-if="!row.isProductGroup"
                  :model-value="row.color"
                  :style="{ width: getColorInputWidth(row.color) }"
                  size="small"
                  class="editable-text"
                  aria-label="颜色"
                  @update:model-value="updateValue(row.id, 'color', $event)"
                />
              </div>
              <div
                class="inventory-vtable__cell"
                :class="`urgency-cell urgency-cell--${row.urgencyTone}`"
              >
                <span
                  v-if="!row.isProductGroup"
                  class="urgency-indicator"
                  :class="`urgency-indicator--${row.urgencyTone}`"
                  :title="row.strategyIssue || row.urgencyText"
                  :aria-label="`紧急状态：${row.urgencyText}`"
                />
              </div>
              <div
                class="inventory-vtable__cell inventory-vtable__cell--deep-right"
                :class="`planned-cell planned-cell--${getPlannedTone(row)}`"
              >
                <template v-if="row.isProductGroup">{{ formatQuantity(row.planned) }}</template>
                <div v-else class="planned-entry">
                  <div
                    class="planned-input-shell"
                    :class="{ 'planned-input-shell--locked': hasPlannedUndo(row.id) }"
                  >
                    <ElInputNumber
                      :model-value="getPlannedDraft(row)"
                      :placeholder="getPlannedPlaceholder(row)"
                      :title="
                        hasPlannedUndo(row.id)
                          ? '已采纳，点击撤销后可修改'
                          : getPlannedPlaceholderTitle(row)
                      "
                      :min="0"
                      :controls="false"
                      size="small"
                      class="editable-number planned-input"
                      aria-label="需安排"
                      :disabled="hasPlannedUndo(row.id)"
                      @input="updatePlannedDraft(row.id, $event)"
                      @update:model-value="updatePlannedDraft(row.id, $event)"
                    />
                    <svg
                      v-if="hasPlannedUndo(row.id)"
                      class="planned-lock-icon"
                      viewBox="0 0 16 16"
                      aria-label="已采纳并锁定"
                      role="img"
                    >
                      <path
                        d="M4.5 6V4.75a3.5 3.5 0 0 1 7 0V6m-8 0h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm4.5 3v2"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.5"
                      />
                    </svg>
                  </div>
                  <ElButton
                    class="planned-accept-button"
                    size="small"
                    :disabled="!hasPlannedDraft(row.id) && !hasPlannedUndo(row.id)"
                    :aria-label="`${row.product} ${row.color} ${
                      hasPlannedDraft(row.id) || !hasPlannedUndo(row.id)
                        ? '采纳需安排'
                        : '撤销需安排'
                    }`"
                    @click.stop="handlePlannedAction(row, $event)"
                  >
                    {{ hasPlannedDraft(row.id) || !hasPlannedUndo(row.id) ? '采纳' : '撤销' }}
                  </ElButton>
                </div>
              </div>
              <div class="inventory-vtable__cell">
                <template v-if="row.isProductGroup">{{ formatQuantity(row.producing) }}</template>
                <ElInputNumber
                  v-else
                  :model-value="row.producing"
                  :min="0"
                  :controls="false"
                  size="small"
                  class="editable-number"
                  aria-label="生产中"
                  @update:model-value="updateValue(row.id, 'producing', $event)"
                />
              </div>
              <div class="inventory-vtable__cell">
                <template v-if="row.isProductGroup">{{ formatQuantity(row.backorder) }}</template>
                <ElInputNumber
                  v-else
                  :model-value="row.backorder"
                  :min="0"
                  :controls="false"
                  size="small"
                  class="editable-number"
                  aria-label="欠货"
                  @update:model-value="updateValue(row.id, 'backorder', $event)"
                />
              </div>
              <div class="inventory-vtable__cell">
                <template v-if="row.isProductGroup">{{ formatQuantity(row.weeklyUsage) }}</template>
                <ElInputNumber
                  v-else
                  :model-value="row.weeklyUsage"
                  :min="0"
                  :controls="false"
                  size="small"
                  class="editable-number"
                  aria-label="周消耗"
                  @update:model-value="updateValue(row.id, 'weeklyUsage', $event)"
                />
              </div>
              <div class="inventory-vtable__cell">
                <template v-if="row.isProductGroup">{{ formatQuantity(row.turnoverIn) }}</template>
                <ElInputNumber
                  v-else
                  :model-value="row.turnoverIn"
                  :min="0"
                  :controls="false"
                  size="small"
                  class="editable-number"
                  aria-label="周转入"
                  @update:model-value="updateValue(row.id, 'turnoverIn', $event)"
                />
              </div>
              <div class="inventory-vtable__cell">
                <template v-if="row.isProductGroup">
                  {{ formatQuantity(row.inTransitStock) }}
                </template>
                <ElInputNumber
                  v-else
                  :model-value="row.inTransitStock"
                  :min="0"
                  :controls="false"
                  size="small"
                  class="editable-number"
                  aria-label="在途库存"
                  @update:model-value="updateValue(row.id, 'inTransitStock', $event)"
                />
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--deep-right">
                <template v-if="row.isProductGroup">{{ formatQuantity(row.warehouseStock) }}</template>
                <ElInputNumber
                  v-else
                  :model-value="row.warehouseStock"
                  :min="0"
                  :controls="false"
                  size="small"
                  class="editable-number"
                  aria-label="在仓库存"
                  @update:model-value="updateValue(row.id, 'warehouseStock', $event)"
                />
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.theoreticalStock) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.projectedStock) }}
              </div>
              <div class="inventory-vtable__cell">{{ formatQuantity(row.shortage) }}</div>
              <div class="inventory-vtable__cell">
                {{ formatRate(row.shortageRate, row.strategyAvailable) }}
              </div>
              <div class="inventory-vtable__cell">{{ formatRatio(row.stockSalesRatio) }}</div>
            </div>
          </div>
        </div>

        <div v-if="tableVirtualRows.total === 0" class="inventory-vtable__empty">暂无数据</div>
      </div>
    </div>

    <ElDialog
      v-model="urgentPlanDialogVisible"
      title="紧急补货计划"
      width="820px"
      class="urgent-plan-dialog"
      :close-on-click-modal="false"
    >
      <p class="urgent-plan-hint">
        填写新增计划数量，提交后将累加到主表“需安排”。推荐计划数按补至绿色状态的最低数量计算。
      </p>
      <div class="urgent-plan-table" role="table" aria-label="紧急补货计划">
        <div class="urgent-plan-header" role="row">
          <span role="columnheader">商品信息</span>
          <span role="columnheader">目前需安排</span>
          <span role="columnheader">新增计划</span>
          <span role="columnheader">推荐计划数</span>
        </div>
        <div
          v-for="row in urgentPlanRows"
          :key="row.id"
          class="urgent-plan-row"
          role="row"
        >
          <div class="urgent-plan-product" role="cell">
            <strong>{{ row.product }}</strong>
            <span>{{ row.color }}</span>
          </div>
          <span role="cell">{{ formatQuantity(row.currentPlanned) }}</span>
          <div role="cell">
            <ElInputNumber
              v-model="row.additionalPlan"
              :min="0"
              :precision="0"
              :controls="false"
              size="small"
              class="urgent-plan-input"
              :aria-label="`${row.product} ${row.color} 新增计划`"
            />
          </div>
          <div class="urgent-plan-recommendation" role="cell">
            <strong>{{ formatQuantity(row.recommendedPlan) }}</strong>
            <ElButton
              text
              type="primary"
              @click="row.additionalPlan = row.recommendedPlan"
            >
              采用
            </ElButton>
          </div>
        </div>
        <div v-if="urgentPlanRows.length === 0" class="urgent-plan-empty">
          当前没有紧急补货商品
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <ElButton @click="urgentPlanDialogVisible = false">取消</ElButton>
          <ElButton
            class="apply-all-button"
            :disabled="urgentPlanRows.length === 0"
            @click="applyAllRecommendedPlans"
          >
            全部采用
          </ElButton>
          <ElButton type="primary" :disabled="!hasUrgentPlan" @click="submitUrgentPlans">
            确认提交
          </ElButton>
        </div>
      </template>
    </ElDialog>

    <ImportSourcesDialog
      v-model="importDialogVisible"
      :summary="importSummary"
      @confirm="confirmImport"
      @cancel="cancelImport"
    />

    <ElDialog
      v-model="purchaseListDialogVisible"
      title="本次采购清单"
      width="680px"
      class="purchase-list-dialog"
      :close-on-click-modal="false"
    >
      <p class="purchase-list-hint">
        已采纳的需安排会加入清单；同一商品颜色只保留一条。实际计划仅作采购记录，不影响库存计算。
      </p>
      <ElTable
        :data="purchaseListRows"
        row-key="id"
        border
        table-layout="fixed"
        class="purchase-list-table"
        empty-text="暂无已采纳的采购计划"
      >
        <ElTableColumn prop="product" label="品名" min-width="190" />
        <ElTableColumn prop="color" label="颜色" width="110" align="center" />
        <ElTableColumn prop="planned" label="需安排" width="120" align="center">
          <template #default="{ row }">{{ formatQuantity(row.planned) }}</template>
        </ElTableColumn>
        <ElTableColumn label="实际计划" width="170" align="center">
          <template #default="{ row }">
            <ElInputNumber
              :model-value="row.actualPlan"
              :min="0"
              :precision="0"
              :controls="false"
              size="small"
              class="purchase-list-actual-input"
              :aria-label="`${row.product} ${row.color} 实际计划`"
              @update:model-value="updatePurchaseActualPlan(row.id, $event)"
            />
          </template>
        </ElTableColumn>
      </ElTable>
      <template #footer>
        <div class="dialog-footer">
          <ElButton @click="purchaseListDialogVisible = false">关闭</ElButton>
          <ElButton
            type="primary"
            :disabled="purchaseList.length === 0"
            @click="exportPurchaseListToExcel"
          >
            导出 Excel
          </ElButton>
        </div>
      </template>
    </ElDialog>
  </main>
</template>

<style scoped>
.inventory-page {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 12px;
  overflow: hidden;
  background: var(--industrial-page);
}

.import-toast {
  position: fixed;
  top: 16px;
  left: 50%;
  z-index: 5000;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 320px;
  max-width: 480px;
  padding: 12px 16px 10px;
  color: var(--industrial-text);
  border: 1px solid #e1f3d8;
  border-radius: 4px;
  background: #f0f9eb;
  box-shadow: 0 4px 12px rgba(34, 57, 69, 0.15);
  overflow: hidden;
}

.import-toast__icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  color: #67c23a;
}

.import-toast__icon svg {
  width: 16px;
  height: 16px;
}

.import-toast__message {
  flex: 1;
  font-size: 14px;
  line-height: 1.5;
  text-align: left;
}

.import-toast__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(103, 194, 58, 0.15);
}

.import-toast__progress-bar {
  height: 100%;
  background: #67c23a;
  transition: width 50ms linear;
}

.page-sticky-header {
  position: relative;
  z-index: 20;
  flex: 0 0 auto;
  margin: -12px -12px 0;
  padding: 12px 12px 0;
  background: var(--industrial-page);
  box-shadow: 0 6px 12px -10px rgba(34, 57, 69, 0.45);
}

.purchase-fly-icon {
  position: fixed;
  z-index: 4000;
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  background: var(--industrial-primary);
  box-shadow: 0 2px 7px rgba(34, 57, 69, 0.35);
  pointer-events: none;
  animation: purchase-icon-fly 900ms cubic-bezier(0.2, 0.75, 0.25, 1) both;
}

.purchase-fly-icon svg {
  width: 14px;
  height: 14px;
}

@keyframes purchase-icon-fly {
  to {
    transform: translate3d(var(--purchase-fly-x), var(--purchase-fly-y), 0) scale(0.45);
    opacity: 0.2;
  }
}

@media (prefers-reduced-motion: reduce) {
  .purchase-fly-icon {
    animation-duration: 1ms;
  }

  .purchase-list-button--received {
    animation-duration: 1ms;
  }
}

.table-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.table-actions :deep(.el-button) {
  margin-left: 0;
}

.inventory-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 8px;
}

.text-filter {
  width: 150px;
}

.warning-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.warning-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 3px 9px;
  color: var(--industrial-muted);
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: var(--industrial-surface);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.warning-filter:hover,
.warning-filter--active {
  color: var(--industrial-primary);
  border-color: var(--industrial-primary);
  background: #e5edf1;
}

.warning-filter:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: 2px;
}

.warning-filter-indicator {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border: 1px solid rgba(47, 59, 67, 0.25);
  border-radius: 1px;
}

.warning-filter-indicator.urgency-indicator--red {
  background: var(--industrial-urgent);
}

.warning-filter-indicator.urgency-indicator--yellow {
  background: var(--industrial-replenish);
}

.warning-filter-indicator.urgency-indicator--green {
  background: var(--industrial-normal);
}

.warning-filter-indicator.urgency-indicator--purple {
  background: var(--industrial-overstock);
}

.warning-filter-count {
  min-width: 16px;
  color: var(--industrial-text);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.urgent-plan-button {
  --el-button-text-color: #fff;
  --el-button-bg-color: var(--industrial-danger);
  --el-button-border-color: var(--industrial-danger);
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: var(--industrial-danger-hover);
  --el-button-hover-border-color: var(--industrial-danger-hover);
  --el-button-active-bg-color: var(--industrial-danger-active);
  --el-button-active-border-color: var(--industrial-danger-active);
}

.urgent-count {
  min-width: 18px;
  margin-left: 4px;
  font-weight: 700;
}

.export-excel-button,
.import-excel-button,
.import-template-button {
  --el-button-text-color: var(--industrial-primary);
  --el-button-bg-color: var(--industrial-surface);
  --el-button-border-color: var(--industrial-primary);
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: var(--industrial-primary-hover);
  --el-button-hover-border-color: var(--industrial-primary-hover);
  --el-button-active-text-color: #fff;
  --el-button-active-bg-color: var(--industrial-primary-active);
  --el-button-active-border-color: var(--industrial-primary-active);
}

.import-file-input {
  display: none;
}

.purchase-list-button {
  --el-button-text-color: var(--industrial-primary);
  --el-button-bg-color: #e5edf1;
  --el-button-border-color: #8da2ad;
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: var(--industrial-primary-hover);
  --el-button-hover-border-color: var(--industrial-primary-hover);
  --el-button-active-text-color: #fff;
  --el-button-active-bg-color: var(--industrial-primary-active);
  --el-button-active-border-color: var(--industrial-primary-active);
}

.purchase-list-button--received {
  animation: purchase-list-pulse 600ms ease-out;
}

@keyframes purchase-list-pulse {
  35% {
    transform: scale(1.08);
    box-shadow: 0 0 0 4px rgba(63, 113, 141, 0.2);
  }
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:global(.urgent-plan-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
}

:global(.purchase-list-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
}

.purchase-list-hint {
  margin: 0 0 14px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.purchase-list-table {
  width: 100%;
  --el-table-border-color: var(--industrial-grid);
  --el-table-header-bg-color: transparent;
  --el-table-tr-bg-color: var(--industrial-surface);
  --el-table-row-hover-bg-color: #edf1f3;
  --el-bg-color: var(--industrial-surface);
  --el-fill-color-blank: var(--industrial-surface);
  color: var(--industrial-text);
}

.purchase-list-actual-input {
  width: 130px;
}

.urgent-plan-hint {
  margin: 0 0 16px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.urgent-plan-table {
  max-height: min(55vh, 480px);
  overflow: auto;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
}

.urgent-plan-header,
.urgent-plan-row {
  display: grid;
  grid-template-columns: minmax(190px, 1.5fr) repeat(3, minmax(120px, 1fr));
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 6px 12px;
  text-align: center;
}

.urgent-plan-header {
  position: sticky;
  top: 0;
  z-index: 1;
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-weight: 600;
}

.urgent-plan-row {
  border-top: 1px solid var(--industrial-grid-light);
  color: var(--industrial-text);
}

.urgent-plan-product {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
}

.urgent-plan-product span {
  color: var(--industrial-muted);
}

.urgent-plan-input {
  width: 100%;
}

.urgent-plan-recommendation {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--industrial-primary);
}

.urgent-plan-empty {
  padding: 28px 12px;
  color: var(--industrial-muted);
  text-align: center;
}

.inventory-vtable {
  --vtable-border: var(--industrial-grid);
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--industrial-grid);
  background: var(--industrial-surface);
  color: var(--industrial-text);
  font-size: 13px;
}

.inventory-vtable__canvas {
  position: relative;
  min-width: 100%;
}

.inventory-vtable__head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--industrial-header);
}

.inventory-vtable__row {
  display: grid;
  align-items: stretch;
  border-bottom: 1px solid var(--industrial-grid);
}

.inventory-vtable__head-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 3px 4px;
  overflow: hidden;
  color: var(--industrial-text);
  border-right: 1px solid var(--industrial-grid);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.inventory-vtable__head-cell--group {
  border-bottom: 1px solid var(--industrial-grid);
  font-weight: 600;
}

.inventory-vtable__row > :last-child {
  border-right: 0;
}

.inventory-vtable__body {
  position: relative;
}

.inventory-vtable__rows {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
}

.inventory-vtable__row--body {
  background: var(--industrial-surface);
}

.inventory-vtable__row--body.product-group-row {
  background: var(--industrial-header);
  font-weight: 600;
  cursor: pointer;
}

.inventory-vtable__cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 0 2px;
  overflow: hidden;
  border-right: 1px solid var(--industrial-grid-light);
  line-height: 20px;
  white-space: nowrap;
}

.inventory-vtable__cell--deep-right {
  border-right: 2px solid var(--industrial-grid);
}

.inventory-vtable__head-cell--deep-right {
  border-right: 2px solid var(--industrial-grid);
}

.inventory-vtable__cell--product {
  justify-content: flex-start;
  gap: 2px;
  padding-left: 6px;
  overflow: visible;
}

.inventory-vtable__cell--stocking {
  padding: 0 4px;
  overflow: hidden;
}

.stocking-text {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stocking-text--conflict {
  color: var(--industrial-out-of-stock, #b44242);
  text-decoration: underline dotted;
}

.inventory-vtable__row--body.product-color-row > .inventory-vtable__cell--product {
  padding-left: 24px;
}

.inventory-vtable__caret {
  display: inline-flex;
  flex: 0 0 14px;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: var(--industrial-muted);
  transition: transform 120ms ease;
}

.inventory-vtable__caret--expanded {
  transform: rotate(90deg);
}

.inventory-vtable__caret svg {
  width: 12px;
  height: 12px;
}

.inventory-vtable__product-input {
  display: flex;
  flex: 1;
  min-width: 0;
}

.inventory-vtable__empty {
  padding: 40px 0;
  color: var(--industrial-muted);
  font-size: 13px;
  text-align: center;
}

.inventory-vtable__row--body:hover .inventory-vtable__cell {
  box-shadow:
    inset 0 2px rgba(63, 113, 141, 0.58),
    inset 0 -2px rgba(63, 113, 141, 0.58);
}

.inventory-vtable__row--body:hover .inventory-vtable__cell:first-child {
  box-shadow:
    inset 2px 0 rgba(63, 113, 141, 0.58),
    inset 0 2px rgba(63, 113, 141, 0.58),
    inset 0 -2px rgba(63, 113, 141, 0.58);
}

.inventory-vtable__row--body:hover .inventory-vtable__cell:last-child {
  box-shadow:
    inset -2px 0 rgba(63, 113, 141, 0.58),
    inset 0 2px rgba(63, 113, 141, 0.58),
    inset 0 -2px rgba(63, 113, 141, 0.58);
}

.inventory-vtable__row--body.inventory-row-selected .inventory-vtable__cell {
  box-shadow:
    inset 0 2px rgba(63, 113, 141, 0.82),
    inset 0 -2px rgba(63, 113, 141, 0.82);
}

.inventory-vtable__row--body.inventory-row-selected .inventory-vtable__cell:first-child {
  box-shadow:
    inset 2px 0 rgba(63, 113, 141, 0.82),
    inset 0 2px rgba(63, 113, 141, 0.82),
    inset 0 -2px rgba(63, 113, 141, 0.82);
}

.inventory-vtable__row--body.inventory-row-selected .inventory-vtable__cell:last-child {
  box-shadow:
    inset -2px 0 rgba(63, 113, 141, 0.82),
    inset 0 2px rgba(63, 113, 141, 0.82),
    inset 0 -2px rgba(63, 113, 141, 0.82);
}

.inventory-vtable__row--body.product-color-row.product-group-expanding .inventory-vtable__cell {
  animation: sku-row-enter 120ms ease-out both;
}

.inventory-vtable {
  --el-color-primary: var(--industrial-primary);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-bg-color: var(--industrial-surface);
  --el-fill-color-blank: var(--industrial-surface);
}

@keyframes sku-row-enter {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.inventory-vtable :deep(.editable-number) {
  width: 100%;
}

.inventory-vtable :deep(.editable-number .el-input),
.inventory-vtable :deep(.editable-number .el-input__wrapper),
.inventory-vtable :deep(.editable-number .el-input__inner) {
  width: 100%;
}

.inventory-vtable :deep(.editable-number .el-input__wrapper) {
  padding: 0 2px;
  background: transparent;
  box-shadow: none;
}

.inventory-vtable :deep(.editable-number .el-input__inner),
.inventory-vtable :deep(.editable-text .el-input__inner),
.inventory-vtable :deep(.editable-select .el-select__selected-item) {
  color: var(--industrial-text);
}

.inventory-vtable :deep(.editable-number .el-input__inner) {
  text-align: center;
}

.inventory-vtable :deep(.editable-text .el-input__wrapper) {
  padding: 0 3px;
  background: transparent;
  box-shadow: none;
}

.inventory-vtable :deep(.editable-text .el-input__inner) {
  text-align: center;
}

.inventory-vtable :deep(.product-input) {
  width: 100%;
  /* 用右侧留白抵消左侧展开图标，使父行品名与子行品名同样居中 */
  max-width: calc(100% - 29px);
  margin-right: 14px;
}

.inventory-vtable :deep(.product-input .el-input__wrapper) {
  padding: 0 2px;
  background: transparent;
  box-shadow: none;
}

.inventory-vtable :deep(.product-input .el-input__inner) {
  text-align: center;
  color: inherit;
  text-overflow: clip;
}

.inventory-vtable :deep(.product-input .el-input__wrapper.is-focus) {
  border-color: var(--industrial-primary);
  box-shadow: 0 0 0 1px rgba(63, 113, 141, 0.24);
}

.inventory-vtable :deep(.product-name-text) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inventory-vtable :deep(.editable-text .el-input__inner) {
  text-overflow: clip;
}

.inventory-vtable :deep(.editable-select) {
  width: 100%;
}

.inventory-vtable :deep(.editable-select .el-select__wrapper) {
  min-height: 22px;
  padding: 0 2px;
  background: transparent;
  box-shadow: none;
}

.inventory-vtable :deep(.editable-select .el-select__selected-item) {
  font-size: 13px;
}

.inventory-vtable :deep(.planned-cell) {
  font-weight: 700;
}

.inventory-vtable :deep(.planned-cell .editable-number .el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--industrial-primary) inset !important;
}

.planned-entry {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}

.inventory-vtable :deep(.planned-input) {
  width: 84px;
  flex: 0 0 84px;
}

.planned-input-shell {
  position: relative;
  width: 84px;
  flex: 0 0 84px;
}

.inventory-vtable :deep(.planned-cell .planned-input-shell--locked .planned-input .el-input__wrapper) {
  padding-right: 20px;
  background-color: #dce6eb !important;
  box-shadow: 0 0 0 1px #8da2ad inset !important;
}

.inventory-vtable :deep(.planned-input-shell--locked .el-input__inner) {
  color: #263d49 !important;
  -webkit-text-fill-color: #263d49 !important;
}

.planned-lock-icon {
  position: absolute;
  top: 50%;
  right: 5px;
  z-index: 1;
  width: 12px;
  height: 12px;
  color: #496777;
  pointer-events: none;
  transform: translateY(-50%);
}

.inventory-vtable :deep(.planned-accept-button) {
  min-height: 22px;
  height: 22px;
  padding: 0 4px;
  font-size: 11px;
}

.inventory-vtable :deep(.planned-cell--red .editable-number .el-input__wrapper) {
  background-color: #f8e5e3 !important;
}

.inventory-vtable :deep(.planned-cell--yellow .editable-number .el-input__wrapper) {
  background-color: #f7efdc !important;
}

.inventory-vtable :deep(.planned-cell--green .editable-number .el-input__wrapper) {
  background-color: #e8efe9 !important;
}

.inventory-vtable :deep(.planned-cell--purple .editable-number .el-input__wrapper) {
  background-color: #eee8f0 !important;
}

.inventory-vtable :deep(.planned-cell--unavailable .editable-number .el-input__wrapper) {
  background-color: var(--industrial-surface) !important;
}

.inventory-vtable :deep(.planned-cell .editable-number .el-input__inner) {
  font-weight: 700;
}

.inventory-vtable :deep(.urgency-indicator) {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 1px solid rgba(47, 59, 67, 0.18);
  border-radius: 2px;
  vertical-align: middle;
}

.inventory-vtable :deep(.urgency-indicator--red) {
  width: 20px;
  height: 20px;
  background-color: var(--industrial-urgent);
}

.inventory-vtable :deep(.urgency-indicator--purple) {
  width: 16px;
  height: 16px;
  background-color: var(--industrial-overstock);
}

.inventory-vtable :deep(.urgency-indicator--green) {
  width: 10px;
  height: 10px;
  background-color: var(--industrial-normal);
}

.inventory-vtable :deep(.urgency-indicator--yellow) {
  width: 16px;
  height: 16px;
  background-color: var(--industrial-replenish);
}

.inventory-vtable :deep(.urgency-indicator--unavailable) {
  width: 10px;
  height: 10px;
  background-color: var(--industrial-unavailable);
}
</style>
