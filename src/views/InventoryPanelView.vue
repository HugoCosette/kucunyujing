<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  ElButton,
  ElCheckbox,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElSelect,
} from 'element-plus'
import { zipSync } from 'fflate'
// 系数由 store 维护，便于配置页修改后全局生效。
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import PanelNavigation from '@/components/PanelNavigation.vue'
import ImportSourcesDialog from '@/components/ImportSourcesDialog.vue'
import ImportSplitTablesDialog from '@/components/ImportSplitTablesDialog.vue'
import SkuDetailDialog from '@/components/SkuDetailDialog.vue'
import SkuDetailTrigger from '@/components/SkuDetailTrigger.vue'
import VirtualList from '@/components/VirtualList.vue'
import { useSourceImport } from '@/composables/useSourceImport'
import { useSplitImport } from '@/composables/useSplitImport'
import { useInventoryStore } from '@/stores/inventory'
import { groupRowsByProduct } from '@/utils/productGroups'
import {
  calculateInventoryRow,
  formatFactors,
  formatQuantity,
  formatRate,
  formatRatio,
  getSuggestedPlanned,
} from '@/utils/inventory'
import { useStockingConfigStore } from '@/stores/stocking'
import {
  createEvaluator,
  describeSpuGradeThresholds,
  evaluateItem,
  normalizeSpuGrades,
  resolveSpuGrade,
} from '@/stocking'
import { IMPORT_TEMPLATE_COLUMNS, IMPORT_TEMPLATE_SAMPLE_ROWS } from '@/utils/inventoryImport'

const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const inventoryStore = useInventoryStore(props.panelKey)
// 备货配置全应用唯一：模式判定与系数都按这份配置计算。
const stockingStore = useStockingConfigStore()
// 「近 N 个月」的基准月：数据里最后一个有销量的月份（导入时算好存在 salesSheet 上）。
const baselineMonth = computed(() => {
  const month = inventoryStore.salesSheet?.baselineMonth
  return Number.isFinite(month) && month > 0 ? month : null
})
const stockingEvaluator = computed(() =>
  createEvaluator(stockingStore.config, {
    manualOverrides: stockingStore.manualOverrides,
    baselineMonth: baselineMonth.value,
  }),
)
// SPU 等级只按「该品名全部 SKU 的月均条数合计」判定，与备货模式 / 系数无关，改配置立刻生效。
const spuGrades = computed(() => normalizeSpuGrades(stockingStore.config.spuGrades))
const spuGradeThresholds = computed(() => describeSpuGradeThresholds(spuGrades.value))
const inventoryItems = inventoryStore.inventoryItems
const purchaseList = inventoryStore.purchaseList
const plannedUndoHistory = inventoryStore.plannedUndoHistory
const purchaseListRows = computed(() =>
  purchaseList.map((purchaseItem) => {
    const item = itemById.value.get(purchaseItem.id)
    // 品名/颜色没变时复用原对象，避免清单上万条时每次打开都重新分配上万个对象。
    if (!item || (item.product === purchaseItem.product && item.color === purchaseItem.color)) {
      return purchaseItem
    }
    return { ...purchaseItem, product: item.product, color: item.color }
  }),
)
const plannedDrafts = reactive({})
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const selectedWarningTones = ref([])
const selectedModeLabels = ref([])
const productFilter = ref('')
const colorFilter = ref('')
const expandingProductKeys = ref(new Set())
const selectedRowId = ref(null)
// 批量补货勾选：只记 SKU 标识集合。行会随虚拟滚动装卸，选择状态不能挂在行上。
const selectedSkuIds = ref(new Set())
// SKU 详情弹窗只保留一个实例并挂在页面层级：放在虚拟滚动行里会随行卸载，
// 遮罩还会被列表的 transform 容器裁掉。
const skuDetailVisible = ref(false)
const skuDetailItem = ref(null)

function openSkuDetail(item) {
  skuDetailItem.value = item
  skuDetailVisible.value = true
}

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
// 弹窗里的长列表按虚拟滚动渲染：上万个紧急 SKU / 采购条目时
// 直接 v-for 会把主线程卡住十几秒。
const URGENT_PLAN_ROW_HEIGHT = 48
const PURCHASE_LIST_ROW_HEIGHT = 44
const flyingPurchaseIcon = ref(null)
const purchaseListPulse = ref(false)
// 批量确认补货：先落成可编辑的「需安排」清单，确认后覆盖写入并进入采购清单。
const restockDialogVisible = ref(false)
const restockRows = ref([])
const RESTOCK_ROW_HEIGHT = 48
// 导入只对主面板开放，示例面板保持原始演示数据。
const canImportExcel = computed(() => props.panelKey === DEFAULT_PANEL_KEY)

// 主面板与销售表共用同一条导入流程：一次可选总表 + 销售表，按表头识别，顺序不限。
const sourceImport = useSourceImport({
  panelKey: props.panelKey,
  onApplied: handleSourcesImported,
})
const {
  fileInputRef: importFileInputRef,
  dialogVisible: importDialogVisible,
  summary: importSummary,
  trigger: triggerImportExcel,
  handleFilesChange: handleImportFileChange,
  cancel: cancelImport,
  confirm: confirmImport,
} = sourceImport

// 导入分表：选 5 张分表 → 清洗出总表 + 销售表 → 复用上面的导入流程确认写入。
const {
  dialogVisible: splitImportDialogVisible,
  roles: splitImportRoles,
  matching: splitImportMatching,
  progress: splitImportProgress,
  open: triggerSplitImport,
  select: selectSplitImportFiles,
  clear: clearSplitImportFiles,
  start: startSplitImport,
  cancel: cancelSplitImport,
} = useSplitImport({ sourceImport })
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
  // 模式与系数按当前配置现算：配置改动后重新渲染即同步，无需额外回写。
  const row = calculateInventoryRow(evaluateItem(item, stockingEvaluator.value))
  return {
    ...row,
    searchProduct: row.product.toLocaleLowerCase('zh-CN'),
    searchColor: row.color.toLocaleLowerCase('zh-CN'),
  }
}

const inventoryLeafRows = shallowRef([])
// 每个品名的月均条数合计（含该品名全部 SKU）：SPU 等级按它判定，不随筛选变化。
const productMonthlyTotals = shallowRef(new Map())
const leafRowIndexById = new Map()

// 模式列悬停说明：该模式怎么比较、为什么可能不参与计算。
function modeTitle(row) {
  if (!row) return ''
  if (row.strategy === 'manual') {
    const orders = row.manualOrders ?? []
    if (!orders.length) return `手动策略 · ${row.modeLabel}`
    const lines = orders.map((order) =>
      [
        order.name || '未命名订单',
        order.factory ? `厂家：${order.factory}` : '',
        Number.isFinite(order.quantity) ? `数量：${order.quantity}` : '',
        order.note ? `备注：${order.note}` : '',
      ]
        .filter(Boolean)
        .join(' / '),
    )
    return [`手动策略 · ${row.modeLabel}`, ...lines].join('\n')
  }
  if (row.exclusive) return `${row.modeLabel}：累计客户为 1，不参与备货计算`
  if (!row.modeParticipates) return `${row.modeLabel}：不参与备货计算，仅做标注`
  return row.modeMetric === 'days'
    ? `${row.modeLabel}：按日库销比（天）比较`
    : `${row.modeLabel}：按库存条数比较`
}

// SPU 汇总行的模式列：展示等级，并说明月均条数合计与命中的区间。
function spuGradeTitle(row) {
  if (!row?.spuGrade) return `${row?.product ?? '该品名'}：没有月均条数，无法分级`
  const threshold = spuGradeThresholds.value[row.spuGrade.key] ?? ''
  return `SPU 等级 ${row.spuGrade.label}：全部 SKU 月均合计 ${formatQuantity(row.spuMonthlyAvg)} 条（${threshold}）`
}

// 模式筛选项取当前数据里实际出现的模式标签（含「热销·专属品」这类标记），配置改动后自动跟随。
const modeOptions = computed(() =>
  [...new Set(inventoryLeafRows.value.map((row) => row.modeLabel).filter(Boolean))].sort(
    (first, second) => productCollator.compare(first, second),
  ),
)

function rebuildLeafRows() {
  const rows = inventoryItems.map((item) => buildLeafRow(item))
  // 按品名聚合月均条数，品名按聚合值降序排列；同品名内按月均条数降序，再按颜色。
  const productMonthlyAvg = new Map()
  // SPU 等级用的合计：整个品名都没有月均值时记 null，界面显示「—」而不是硬判 Z。
  const monthlyTotals = new Map()
  for (const row of rows) {
    productMonthlyAvg.set(row.product, (productMonthlyAvg.get(row.product) ?? 0) + (row.monthlyAvgCount ?? 0))
    if (Number.isFinite(row.monthlyAvgCount)) {
      monthlyTotals.set(row.product, (monthlyTotals.get(row.product) ?? 0) + row.monthlyAvgCount)
    } else if (!monthlyTotals.has(row.product)) {
      monthlyTotals.set(row.product, null)
    }
  }
  rows.sort((first, second) => {
    // 尾货 / 滞销 / 专属品不参与备货排名，统一沉到列表末尾。
    const slowDiff = Number(Boolean(first.excluded)) - Number(Boolean(second.excluded))
    if (slowDiff !== 0) return slowDiff
    const productDiff =
      (productMonthlyAvg.get(second.product) ?? 0) - (productMonthlyAvg.get(first.product) ?? 0)
    if (productDiff !== 0) return productDiff
    // 聚合值相同时按品名排序，保证同一品名的行连续：父行按相邻行分组，
    // 同品名一旦被拆开就会生成重复的父行标识，虚拟滚动的行 key 会互相顶替。
    const productNameDiff = productCollator.compare(first.product, second.product)
    if (productNameDiff !== 0) return productNameDiff
    // 排序器把大小写、全半角视为相等，再按原串分一次，避免近似品名被交错排列。
    if (first.product !== second.product) return first.product < second.product ? -1 : 1
    const monthlyDiff = (second.monthlyAvgCount ?? 0) - (first.monthlyAvgCount ?? 0)
    if (monthlyDiff !== 0) return monthlyDiff
    return productCollator.compare(first.color, second.color) || first.id - second.id
  })
  leafRowIndexById.clear()
  rows.forEach((row, index) => leafRowIndexById.set(row.id, index))
  productMonthlyTotals.value = monthlyTotals
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

// 批量重算：几千行逐条调用 refreshLeafRow 会把 3 万行数组复制几千次，
// 这里只复制一次再整体替换（行顺序不受需安排影响，无需重新排序）。
function refreshLeafRows(ids) {
  if (ids.length === 0) return

  const rows = inventoryLeafRows.value.slice()
  let changed = false
  for (const id of ids) {
    const index = leafRowIndexById.get(id)
    const item = itemById.value.get(id)
    if (index === undefined || !item) continue
    rows[index] = buildLeafRow(item)
    changed = true
  }
  if (changed) inventoryLeafRows.value = rows
}

rebuildLeafRows()
// 新增、导入等改变行数的情况兜底重建。
watch(() => inventoryItems.length, rebuildLeafRows)
// 备货配置（模式 / 系数）修改后，整表按新配置重算。
watch(() => stockingStore.config, rebuildLeafRows)
// 手动清单变化（策略切换、改系数、恢复自动）同样要整表重算。
watch(() => stockingStore.manual, rebuildLeafRows)

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
    selectedModeLabels.value.length > 0,
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
  const modes = selectedModeLabels.value
  if (!product && !color && tones.length === 0 && modes.length === 0) {
    return inventoryLeafRows.value
  }

  const toneSet = tones.length > 0 ? new Set(tones) : null
  const modeSet = modes.length > 0 ? new Set(modes) : null
  return inventoryLeafRows.value.filter(
    (row) =>
      (!product || row.searchProduct.includes(product)) &&
      (!color || row.searchColor.includes(color)) &&
      (!toneSet || toneSet.has(row.urgencyTone)) &&
      (!modeSet || modeSet.has(row.modeLabel)),
  )
})
const inventoryRows = computed(() => {
  const groups = groupRowsByProduct(filteredInventoryLeafRows.value)
  const totals = productMonthlyTotals.value
  const grades = spuGrades.value
  return groups.map((group) => {
    if (!group.isProductGroup) return group
    const spuMonthlyAvg = totals.get(group.product) ?? null
    return { ...group, spuMonthlyAvg, spuGrade: resolveSpuGrade(spuMonthlyAvg, grades) }
  })
})

function resetFilters() {
  productFilter.value = ''
  colorFilter.value = ''
  selectedWarningTones.value = []
  selectedModeLabels.value = []
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
  // 批量补货勾选列：表头是全选（作用于当前筛选结果），品名父行勾选连带其下所有 SKU。
  { key: 'select', label: '选择', width: 44, group: '选择' },
  { key: 'rule', label: '模式', width: 96, group: '信息' },
  { key: 'product', label: '品名', width: 150, group: '商品' },
  { key: 'color', label: '颜色', width: 132, group: '商品' },
  { key: 'urgency', label: '预警', width: 44, group: '商品' },
  { key: 'planned', label: '需安排', width: 142, group: '入口' },
  { key: 'producing', label: '生产中', width: 76, group: '入口' },
  { key: 'backorder', label: '欠货', width: 68, group: '出口' },
  { key: 'weeklySales', label: '周销量', width: 76, group: '出口' },
  { key: 'turnoverIn', label: '周转入', width: 74, group: '库存(公斤)' },
  { key: 'inTransitStock', label: '在途库存', width: 84, group: '库存(公斤)' },
  { key: 'warehouseStock', label: '在仓库存', width: 84, group: '库存(公斤)' },
  { key: 'theoreticalStock', label: '理论库存', width: 84, group: '库存(公斤)' },
  { key: 'projectedStock', label: '预计库存', width: 84, group: '库存(公斤)' },
  { key: 'daysOfStock', label: '日库销比', width: 80, group: '数据反馈' },
  { key: 'shortage', label: '缺口量', width: 72, group: '数据反馈' },
  { key: 'shortageRate', label: '缺口率', width: 76, group: '数据反馈' },
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
    recommendedPlan: Math.max(0, Math.ceil(row.normalStock - row.projectedStock)),
  }))
  urgentPlanDialogVisible.value = true
}

function submitUrgentPlans() {
  const accepted = []
  for (const planRow of urgentPlanRows.value) {
    if (planRow.additionalPlan <= 0) continue

    const item = itemById.value.get(planRow.id)
    if (item) {
      // 紧急补货是「在现有需安排上追加」，批量补货是「覆盖」，这里先换算成绝对值再统一写入。
      accepted.push({ id: item.id, planned: (item.planned ?? 0) + planRow.additionalPlan })
    }
  }

  applyRestockPlans(accepted)
  urgentPlanDialogVisible.value = false
  urgentPlanRows.value = []
}

// 采购清单的唯一写入路径：同一 SKU 只保留一条，重复写入按覆盖处理。
// plans 里的 planned 是「需安排」的绝对值，返回实际写入的行数。
function applyRestockPlans(plans) {
  const accepted = plans.filter((plan) => Number(plan.planned) > 0)
  if (accepted.length === 0) return 0

  // 采购清单按 id 建一次索引：逐行 find / findIndex 会把整份清单重扫几千遍。
  const purchaseIndexById = new Map(purchaseList.map((entry, index) => [entry.id, index]))
  const changedIds = []
  for (const plan of accepted) {
    const item = itemById.value.get(plan.id)
    if (!item) continue

    plannedUndoHistory[item.id] = {
      previousPlanned: item.planned,
      previousPurchaseItem:
        purchaseIndexById.has(item.id) ? { ...purchaseList[purchaseIndexById.get(item.id)] } : null,
    }
    item.planned = Number(plan.planned)
    delete plannedDrafts[item.id]
    delete plannedPreviewTones[item.id]

    const purchaseIndex = purchaseIndexById.get(item.id)
    if (purchaseIndex === undefined) {
      purchaseIndexById.set(item.id, purchaseList.length)
      purchaseList.push({
        id: item.id,
        product: item.product,
        color: item.color,
        planned: item.planned ?? 0,
        actualPlan: null,
      })
    } else {
      const purchaseItem = purchaseList[purchaseIndex]
      purchaseItem.product = item.product
      purchaseItem.color = item.color
      purchaseItem.planned = item.planned ?? 0
    }
    changedIds.push(item.id)
  }

  refreshLeafRows(changedIds)
  return changedIds.length
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

// 需安排建议值：补到绿色带中位（正常库存）的差额，基于理论库存；批量补货的默认数量与单行占位同一口径。
function getPlannedPlaceholder(row) {
  if (!row.strategyAvailable) return ''
  return `${formatQuantity(getSuggestedPlanned(row))}`
}

function getPlannedPlaceholderTitle(row) {
  if (!row.strategyAvailable) {
    return `备货模式缺省，无法计算建议需安排量：${row.strategyIssue || '系数不可用'}`
  }

  return `建议填写 ${getPlannedPlaceholder(row)}，采纳后预计库存达到正常库存（绿色带中位）；该建议不会自动采纳`
}

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

// —— 批量补货 ——
// 勾选只认 SKU 标识：父行（品名）按子行全选 / 半选推导，不单独存状态。
function isSkuSelected(id) {
  return selectedSkuIds.value.has(id)
}

function toggleSkuSelection(id, checked) {
  const next = new Set(selectedSkuIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedSkuIds.value = next
}

function isGroupFullySelected(row) {
  const children = row.children ?? []
  return children.length > 0 && children.every((child) => selectedSkuIds.value.has(child.id))
}

function isGroupPartiallySelected(row) {
  const children = row.children ?? []
  let selected = 0
  for (const child of children) {
    if (selectedSkuIds.value.has(child.id)) selected += 1
  }
  return selected > 0 && selected < children.length
}

function toggleGroupSelection(row, checked) {
  const next = new Set(selectedSkuIds.value)
  for (const child of row.children ?? []) {
    if (checked) next.add(child.id)
    else next.delete(child.id)
  }
  selectedSkuIds.value = next
}

// 表头全选取当前筛选结果（含未展开品名下的 SKU），筛选之外的选择保持不变。
const filteredSkuCount = computed(() => filteredInventoryLeafRows.value.length)
const selectedFilteredCount = computed(() => {
  let count = 0
  for (const row of filteredInventoryLeafRows.value) {
    if (selectedSkuIds.value.has(row.id)) count += 1
  }
  return count
})
const allFilteredSkuSelected = computed(
  () => filteredSkuCount.value > 0 && selectedFilteredCount.value === filteredSkuCount.value,
)
const someFilteredSkuSelected = computed(
  () => selectedFilteredCount.value > 0 && selectedFilteredCount.value < filteredSkuCount.value,
)

function toggleSelectAllFiltered(checked) {
  const next = new Set(selectedSkuIds.value)
  for (const row of filteredInventoryLeafRows.value) {
    if (checked) next.add(row.id)
    else next.delete(row.id)
  }
  selectedSkuIds.value = next
}

function clearSkuSelection() {
  selectedSkuIds.value = new Set()
}

// 导入换表后清掉已不存在的 SKU，避免选中数把幽灵行也算进去。
watch(
  () => inventoryItems.length,
  () => {
    if (selectedSkuIds.value.size === 0) return
    const next = new Set()
    for (const id of selectedSkuIds.value) {
      if (itemById.value.has(id)) next.add(id)
    }
    if (next.size !== selectedSkuIds.value.size) selectedSkuIds.value = next
  },
)

function openRestockDialog() {
  restockRows.value = inventoryLeafRows.value
    .filter((row) => selectedSkuIds.value.has(row.id))
    .map((row) => {
      const suggested = getSuggestedPlanned(row)
      return {
        id: row.id,
        product: row.product,
        color: row.color,
        strategyAvailable: row.strategyAvailable,
        currentPlanned: row.planned ?? 0,
        suggested,
        planned: suggested,
      }
    })
  restockDialogVisible.value = true
}

const hasRestockPlan = computed(() => restockRows.value.some((row) => Number(row.planned) > 0))

function applyAllSuggestedRestock() {
  restockRows.value.forEach((row) => {
    row.planned = row.suggested
  })
}

function submitRestock() {
  const appliedCount = applyRestockPlans(restockRows.value)
  if (appliedCount > 0) {
    ElMessage.success(`已加入本次采购清单：${appliedCount} 个 SKU`)
    pulsePurchaseListButton()
  }
  restockDialogVisible.value = false
  restockRows.value = []
  clearSkuSelection()
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

// 点击整行等同于点击该行复选框：SKU 行切换自身，SPU 汇总行切换其下全部 SKU。
function handleRowClick(row) {
  if (row.isProductGroup) {
    toggleGroupSelection(row, !isGroupFullySelected(row))
    return
  }

  toggleSkuSelection(row.id, !isSkuSelected(row.id))
  selectedRowId.value = row.id
}

function handleProductCellClick(row) {
  if (row.isProductGroup) {
    toggleProductGroup(row)
    return
  }

  toggleSkuSelection(row.id, !isSkuSelected(row.id))
  selectedRowId.value = row.id
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
    { label: '信息', columns: ['唯一标识', '模式', '色彩'] },
    { label: '商品', columns: ['品名', '颜色', '预警'] },
    { label: '入口', columns: ['需安排', '生产中'] },
    { label: '出口', columns: ['欠货', '周销量'] },
    { label: '库存(公斤)', columns: ['周转入', '在途库存', '在仓库存', '理论库存', '预计库存'] },
    { label: '数据反馈', columns: ['日库销比', '缺口量', '缺口率'] },
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
    row.modeLabel,
    row.category,
    row.product,
    row.color,
    row.urgencyText,
    row.planned,
    row.producing,
    row.backorder,
    row.weeklySales,
    row.turnoverIn,
    row.inTransitStock,
    row.warehouseStock,
    row.theoreticalStock,
    row.projectedStock,
    row.excluded ? '—' : formatRatio(row.daysOfStock),
    row.excluded ? '—' : row.shortage ?? '缺省',
    row.excluded ? '—' : formatRate(row.shortageRate, row.strategyAvailable),
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

// 导入成功后清空需安排草稿并重建表格；总表与销售表的写入已在 useSourceImport 内完成。
function handleSourcesImported(summary) {
  for (const key of Object.keys(plannedDrafts)) delete plannedDrafts[key]
  for (const key of Object.keys(plannedPreviewTones)) delete plannedPreviewTones[key]

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
          v-model="selectedModeLabels"
          class="text-filter"
          multiple
          collapse-tags
          clearable
          placeholder="按模式筛选"
          aria-label="按模式筛选"
        >
          <ElOption v-for="name in modeOptions" :key="name" :label="name" :value="name" />
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
              class="import-split-button"
              title="选择 5 张分表，先清洗出总表与销售表再导入"
              @click="triggerSplitImport"
            >
              导入分表
            </ElButton>
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
      :class="{ 'inventory-vtable--batch-bar': selectedSkuIds.size > 0 }"
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
              <ElCheckbox
                v-if="column.key === 'select'"
                :model-value="allFilteredSkuSelected"
                :indeterminate="someFilteredSkuSelected"
                :disabled="filteredSkuCount === 0"
                aria-label="全选当前筛选结果"
                @change="toggleSelectAllFiltered"
              />
              <template v-else>{{ column.label }}</template>
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
              <div class="inventory-vtable__cell inventory-vtable__cell--select" @click.stop>
                <ElCheckbox
                  v-if="row.isProductGroup"
                  :model-value="isGroupFullySelected(row)"
                  :indeterminate="isGroupPartiallySelected(row)"
                  :aria-label="`选择 ${row.product} 下的全部 SKU`"
                  @change="toggleGroupSelection(row, $event)"
                />
                <ElCheckbox
                  v-else
                  :model-value="isSkuSelected(row.id)"
                  :aria-label="`选择 ${row.product} ${row.color}`"
                  @change="toggleSkuSelection(row.id, $event)"
                />
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--stocking">
                <span
                  v-if="row.isProductGroup"
                  class="spu-grade"
                  :class="row.spuGrade ? `spu-grade--${row.spuGrade.tone}` : 'spu-grade--empty'"
                  :title="spuGradeTitle(row)"
                >
                  {{ row.spuGrade?.label ?? '—' }}
                </span>
                <span
                  v-else-if="row.modeLabel"
                  class="stocking-text"
                  :class="{
                    'stocking-text--manual': row.excluded,
                  }"
                  :title="modeTitle(row)"
                >
                  {{ row.modeLabel }}
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
                </template>
                <span class="product-name-text" :title="row.product">{{ row.product }}</span>
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--color">
                <template v-if="!row.isProductGroup">
                  <span class="color-name-text" :title="row.color">{{ row.color }}</span>
                  <SkuDetailTrigger :item="row" @open="openSkuDetail" />
                </template>
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
                    @click.stop
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
                {{ formatQuantity(row.producing) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.backorder) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.weeklySales) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.turnoverIn) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.inTransitStock) }}
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--deep-right">
                {{ formatQuantity(row.warehouseKg) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.theoreticalStock) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.projectedStock) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ row.excluded ? '—' : formatRatio(row.daysOfStock) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ row.excluded ? '—' : formatQuantity(row.shortage) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ row.excluded ? '—' : formatRate(row.shortageRate, row.strategyAvailable) }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="tableVirtualRows.total === 0" class="inventory-vtable__empty">暂无数据</div>
      </div>
    </div>

    <div v-if="selectedSkuIds.size > 0" class="batch-restock-bar" role="region" aria-label="批量补货">
      <span class="batch-restock-count">
        已选 <strong>{{ selectedSkuIds.size }}</strong> 个 SKU
      </span>
      <ElButton text class="batch-restock-clear" @click="clearSkuSelection">清空</ElButton>
      <ElButton type="primary" class="batch-restock-confirm" @click="openRestockDialog">
        确认补货
      </ElButton>
    </div>

    <ElDialog
      v-model="urgentPlanDialogVisible"
      title="紧急补货计划"
      width="820px"
      class="urgent-plan-dialog"
      :close-on-click-modal="false"
      destroy-on-close
      align-center
    >
      <p class="urgent-plan-hint">
        填写新增计划数量，提交后将累加到主表“需安排”。推荐计划数按补至绿色带中位（正常库存）的数量计算。
      </p>
      <div class="urgent-plan-table" role="table" aria-label="紧急补货计划">
        <VirtualList
          v-if="urgentPlanRows.length > 0"
          :items="urgentPlanRows"
          :item-height="URGENT_PLAN_ROW_HEIGHT"
          class="urgent-plan-list"
        >
          <template #header>
            <div class="urgent-plan-header" role="row">
              <span role="columnheader">商品信息</span>
              <span role="columnheader">目前需安排</span>
              <span role="columnheader">新增计划</span>
              <span role="columnheader">推荐计划数</span>
            </div>
          </template>
          <template #default="{ item: row }">
            <div class="urgent-plan-row" role="row">
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
          </template>
        </VirtualList>
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

    <ElDialog
      v-model="restockDialogVisible"
      title="确认补货"
      width="820px"
      class="restock-dialog"
      :close-on-click-modal="false"
      destroy-on-close
      align-center
    >
      <p class="restock-hint">
        默认填入与主表一致的建议需安排量；确认后按填写数量覆盖“需安排”，并写入本次采购清单（同一 SKU 只保留一条）。
      </p>
      <div class="restock-table" role="table" aria-label="确认补货">
        <VirtualList
          v-if="restockRows.length > 0"
          :items="restockRows"
          :item-height="RESTOCK_ROW_HEIGHT"
          class="restock-list"
        >
          <template #header>
            <div class="restock-header" role="row">
              <span role="columnheader">商品信息</span>
              <span role="columnheader">当前需安排</span>
              <span role="columnheader">补货数量</span>
              <span role="columnheader">建议量</span>
            </div>
          </template>
          <template #default="{ item: row }">
            <div class="restock-row" role="row">
              <div class="restock-product" role="cell">
                <strong>{{ row.product }}</strong>
                <span>{{ row.color }}</span>
              </div>
              <span role="cell">{{ formatQuantity(row.currentPlanned) }}</span>
              <div role="cell">
                <ElInputNumber
                  v-model="row.planned"
                  :min="0"
                  :precision="0"
                  :controls="false"
                  size="small"
                  class="restock-input"
                  :aria-label="`${row.product} ${row.color} 补货数量`"
                />
              </div>
              <div class="restock-suggestion" role="cell">
                <strong>{{ row.strategyAvailable ? formatQuantity(row.suggested) : '缺省' }}</strong>
                <ElButton
                  text
                  type="primary"
                  :disabled="!row.strategyAvailable"
                  @click="row.planned = row.suggested"
                >
                  采用
                </ElButton>
              </div>
            </div>
          </template>
        </VirtualList>
        <div v-if="restockRows.length === 0" class="restock-empty">尚未选择 SKU</div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <ElButton @click="restockDialogVisible = false">取消</ElButton>
          <ElButton
            class="apply-all-button"
            :disabled="restockRows.length === 0"
            @click="applyAllSuggestedRestock"
          >
            全部采用
          </ElButton>
          <ElButton type="primary" :disabled="!hasRestockPlan" @click="submitRestock">
            确认补货
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

    <ImportSplitTablesDialog
      v-model="splitImportDialogVisible"
      :roles="splitImportRoles"
      :matching="splitImportMatching"
      :progress="splitImportProgress"
      @select="selectSplitImportFiles"
      @clear="clearSplitImportFiles"
      @start="startSplitImport"
      @cancel="cancelSplitImport"
    />

    <ElDialog
      v-model="purchaseListDialogVisible"
      title="本次采购清单"
      width="680px"
      class="purchase-list-dialog"
      :close-on-click-modal="false"
      destroy-on-close
      align-center
    >
      <p class="purchase-list-hint">
        已采纳的需安排会加入清单；同一商品颜色只保留一条。实际计划仅作采购记录，不影响库存计算。
      </p>
      <div class="purchase-list-table" role="table" aria-label="本次采购清单">
        <VirtualList
          v-if="purchaseListRows.length > 0"
          :items="purchaseListRows"
          :item-height="PURCHASE_LIST_ROW_HEIGHT"
          class="purchase-list-rows"
        >
          <template #header>
            <div class="purchase-list-header" role="row">
              <span role="columnheader">品名</span>
              <span role="columnheader">颜色</span>
              <span role="columnheader">需安排</span>
              <span role="columnheader">实际计划</span>
            </div>
          </template>
          <template #default="{ item: row }">
            <div class="purchase-list-row" role="row">
              <span class="purchase-list-product" role="cell" :title="row.product">
                {{ row.product }}
              </span>
              <span role="cell">{{ row.color }}</span>
              <span role="cell">{{ formatQuantity(row.planned) }}</span>
              <span role="cell">
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
              </span>
            </div>
          </template>
        </VirtualList>
        <div v-if="purchaseListRows.length === 0" class="purchase-list-empty">
          暂无已采纳的采购计划
        </div>
      </div>
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

    <SkuDetailDialog
      v-model:visible="skuDetailVisible"
      :item="skuDetailItem"
      :panel-key="panelKey"
    />
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
.import-split-button,
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

:global(.el-dialog.urgent-plan-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
  /* 窄屏 / 分屏时收窄，弹窗不超出视口 */
  width: min(820px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

:global(.el-dialog.purchase-list-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

/* 内容高于视口时只让正文滚动，标题栏与按钮始终可见 */
:global(.el-dialog.urgent-plan-dialog .el-dialog__body),
:global(.el-dialog.purchase-list-dialog .el-dialog__body),
:global(.el-dialog.restock-dialog .el-dialog__body) {
  min-height: 0;
  overflow: auto;
}

.purchase-list-hint {
  margin: 0 0 14px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.purchase-list-table {
  display: flex;
  flex-direction: column;
  /* 清单可能上万条：只渲染视口内的行，容器限高避免顶穿弹窗 */
  max-height: min(55vh, 480px);
  overflow: hidden;
  color: var(--industrial-text);
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
}

.purchase-list-header,
.purchase-list-row {
  display: grid;
  grid-template-columns:
    minmax(150px, 1.6fr)
    minmax(80px, 1fr)
    minmax(80px, 1fr)
    minmax(120px, 1fr);
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  text-align: center;
}

.purchase-list-header {
  min-height: 48px;
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-weight: 600;
}

.purchase-list-row {
  height: 100%;
  border-top: 1px solid var(--industrial-grid-light);
  font-size: 13px;
}

.purchase-list-product {
  overflow: hidden;
  text-align: left;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.purchase-list-empty {
  padding: 28px 12px;
  color: var(--industrial-muted);
  text-align: center;
}

.purchase-list-actual-input {
  width: 120px;
}

.urgent-plan-hint {
  margin: 0 0 16px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.urgent-plan-table {
  display: flex;
  flex-direction: column;
  /* 紧急 SKU 可能上万条：只渲染视口内的行 */
  max-height: min(55vh, 480px);
  overflow: hidden;
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
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-weight: 600;
}

.urgent-plan-row {
  height: 100%;
  border-top: 1px solid var(--industrial-grid-light);
  color: var(--industrial-text);
}

.urgent-plan-product {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  text-align: left;
}

.urgent-plan-product strong {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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

:global(.el-dialog.restock-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
  /* 窄屏 / 分屏时收窄，弹窗不超出视口 */
  width: min(820px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

.restock-hint {
  margin: 0 0 14px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.restock-table {
  display: flex;
  flex-direction: column;
  /* 可能一次补货上千个 SKU：只渲染视口内的行 */
  max-height: min(55vh, 480px);
  overflow: hidden;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
}

.restock-header,
.restock-row {
  display: grid;
  grid-template-columns: minmax(190px, 1.5fr) repeat(3, minmax(120px, 1fr));
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 6px 12px;
  text-align: center;
}

.restock-header {
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-weight: 600;
}

.restock-row {
  height: 100%;
  border-top: 1px solid var(--industrial-grid-light);
  color: var(--industrial-text);
}

.restock-product {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  text-align: left;
}

.restock-product strong {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.restock-product span {
  color: var(--industrial-muted);
}

.restock-input {
  width: 100%;
}

.restock-suggestion {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--industrial-primary);
}

.restock-empty {
  padding: 28px 12px;
  color: var(--industrial-muted);
  text-align: center;
}

/* 批量补货浮动操作条：选中即出现，不占表格布局 */
.batch-restock-bar {
  position: fixed;
  bottom: 20px;
  left: 50%;
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px 6px 18px;
  transform: translateX(-50%);
  color: var(--industrial-text);
  border: 1px solid var(--industrial-grid);
  border-radius: 999px;
  background: var(--industrial-surface);
  box-shadow: 0 6px 20px rgba(34, 57, 69, 0.22);
}

.batch-restock-count {
  font-size: 13px;
  white-space: nowrap;
}

.batch-restock-count strong {
  color: var(--industrial-primary);
  font-size: 15px;
}

.batch-restock-clear,
.batch-restock-confirm {
  border-radius: 999px;
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

/* 底部浮动条会压住最后几行，给滚动区补上同等高度的余量 */
.inventory-vtable--batch-bar {
  padding-bottom: 64px;
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
  cursor: pointer;
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

.inventory-vtable__cell--color {
  gap: 2px;
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

.inventory-vtable__cell--select {
  padding: 0;
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

.stocking-text--manual {
  color: var(--industrial-primary);
}

/* SPU 汇总行模式列里的等级徽标：字大一点、底色很浅、不描硬边，避免在汇总行里过于抢眼。 */
.spu-grade {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.spu-grade--violet {
  color: #6b5a86;
  background: #f4f1f8;
}

.spu-grade--red {
  color: #a64f49;
  background: #faf2f1;
}

.spu-grade--amber {
  color: #8a6a2f;
  background: #faf6ed;
}

.spu-grade--blue {
  color: var(--industrial-primary);
  background: #f1f5f8;
}

.spu-grade--green {
  color: #5b7460;
  background: #f3f7f4;
}

.spu-grade--gray {
  color: var(--industrial-muted);
  background: #f2f5f6;
}

.spu-grade--empty {
  min-width: 0;
  padding: 0;
  color: var(--industrial-muted);
  border-color: transparent;
  background: none;
  font-weight: 400;
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
.inventory-vtable :deep(.editable-select .el-select__selected-item) {
  color: var(--industrial-text);
}

.inventory-vtable :deep(.editable-number .el-input__inner) {
  text-align: center;
}

.inventory-vtable :deep(.product-name-text),
.inventory-vtable :deep(.color-name-text) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 用右侧留白抵消左侧展开图标，使父行品名与子行品名同样居中 */
.inventory-vtable :deep(.product-group-row .product-name-text) {
  margin-right: 14px;
}

.inventory-vtable :deep(.color-name-text) {
  flex: 0 1 auto;
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
