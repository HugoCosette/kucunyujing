<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import {
  ElButton,
  ElCheckbox,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
} from 'element-plus'
// 系数由 store 维护，便于配置页修改后全局生效。
import PanelNavigation from '@/components/PanelNavigation.vue'
import AddSkuDialog from '@/components/AddSkuDialog.vue'
import ImportSplitTablesDialog from '@/components/ImportSplitTablesDialog.vue'
import ImportDiffDialog from '@/components/ImportDiffDialog.vue'
import PurchaseOrderRecordsDialog from '@/components/PurchaseOrderRecordsDialog.vue'
import SkuDetailDialog from '@/components/SkuDetailDialog.vue'
import SkuDetailTrigger from '@/components/SkuDetailTrigger.vue'
import TableHeaderHint from '@/components/TableHeaderHint.vue'
import VirtualList from '@/components/VirtualList.vue'
import { useSourceImport } from '@/composables/useSourceImport'
import { useSplitImport } from '@/composables/useSplitImport'
import { useInventoryStore } from '@/stores/inventory'
import { useInventoryViewStore } from '@/stores/inventoryView'
import { usePurchaseStore } from '@/stores/purchase'
import { buildInventoryColumnHints, checkInventoryColumnHints } from '@/data/columnHints'
import { loadImportDiffs } from '@/data/importDiff'
import { MAIN_PANEL } from '@/data/panels'
import { persistFactLayer, schedulePlanPersist } from '@/data/persistence'
import { orderSummaryOf } from '@/purchase'
import { groupRowsByProduct } from '@/utils/productGroups'
import { QUANTITY_MAX, vQuantityDigits } from '@/utils/quantityInput'
import {
  calculateInventoryRow,
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
  getAutoModes,
  normalizeDisplayFilters,
  normalizeSpuGrades,
  resolveLowPlannedThreshold,
  resolveSpuGrade,
} from '@/stocking'
import { evaluateRowHealth } from '@/utils/skuHealth'

const inventoryStore = useInventoryStore()
// 屏蔽列表是独立页面（导航右侧入口），toast 里也直接跳过去。
const router = useRouter()
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
// 「评分」列直接复用 SKU 弹窗的健康度评分口径：多维加权综合分；按量模式只做 2 项判定，没有综合分。
const bulkHealthScoring = computed(
  () =>
    getAutoModes(stockingStore.config).find((mode) => mode.key === 'bulk')?.healthScoring ?? null,
)
// 表头悬停说明里的模式区间 / 评分权重等数字跟着当前方案走，改配置后自动重算。
const columnHints = computed(() => buildInventoryColumnHints(stockingStore.config))
// 行对象在导入 / 改配置时整体重建，按行缓存不会读到旧分；salesSheet / scoring 再各校验一次。
const rowHealthCache = new WeakMap()
function getRowHealth(row) {
  if (!row || row.isProductGroup) return null
  const salesSheet = inventoryStore.salesSheet
  const scoringConfig = stockingStore.config.scoring
  const cached = rowHealthCache.get(row)
  if (cached && cached.salesSheet === salesSheet && cached.scoringConfig === scoringConfig) {
    return cached.health
  }
  const health = evaluateRowHealth({
    row,
    salesEntry: row.skuId ? salesSheet?.bySku?.get(row.skuId) ?? null : null,
    config: scoringConfig,
    bulkHealthScoring: bulkHealthScoring.value,
  })
  rowHealthCache.set(row, { salesSheet, scoringConfig, health })
  return health
}

function scoreCellText(row) {
  const health = getRowHealth(row)
  if (!health) return ''
  if (!health.participates) return '不参与'
  if (health.mode === 'bulk') return '—'
  return health.totalText ?? '--'
}

function scoreCellTone(row) {
  const health = getRowHealth(row)
  if (!health || !health.participates || health.mode === 'bulk') return 'unavailable'
  return health.tone
}

function scoreCellTitle(row) {
  const health = getRowHealth(row)
  if (!health) return ''
  if (!health.participates) return health.toneLabel || '不参与备货计算，不做健康度评分'
  if (health.mode === 'bulk') return '按量模式：弹窗里只做 2 项判定，不算综合评分'
  return `综合评分 ${health.totalText ?? '--'}（${health.toneLabel}），点颜色旁的详情按钮看逐项明细`
}

// SPU 等级只按「该品名全部 SKU 的月均条数合计」判定，与备货模式 / 系数无关，改配置立刻生效。
const spuGrades = computed(() => normalizeSpuGrades(stockingStore.config.spuGrades))
const spuGradeThresholds = computed(() => describeSpuGradeThresholds(spuGrades.value))
// SPU 等级筛选的「未分级」档：整个品名都没有月均条数，父行徽标显示「—」。
const UNGRADED_SPU_GRADE_KEY = 'ungraded'
const spuGradeFilterOptions = computed(() => [
  ...spuGrades.value.tiers.map(({ key, label }) => ({ key, label })),
  { key: UNGRADED_SPU_GRADE_KEY, label: '未分级' },
])
// 小额补货门槛（设置 → 备货配置 → 筛选显示规则）：紧急 / 常规两档里「建议需安排不足门槛」的 SKU 不列出来。
// 只改筛选结果与计数，行仍在「全部」里、数据一行不动；口径与「需安排」格的占位提示一致
// （补到正常库存即绿区中位的建议值），所以采纳前后判断不会跳。
const displayFilters = computed(() =>
  normalizeDisplayFilters(stockingStore.config.displayFilters),
)
const lowPlannedThreshold = computed(() => resolveLowPlannedThreshold(displayFilters.value))
const inventoryItems = inventoryStore.inventoryItems
const plannedUndoHistory = inventoryStore.plannedUndoHistory
// 在途对账：每行的已安排 / 生产中 / 在途都从这里取，口径只在 store 里算一份。
const inTransitOf = inventoryStore.inTransitOf
// 采购下单模块：分订单以唯一标识为键；哪些 SKU 要下、下多少完全由「需安排」决定。
const purchaseStore = usePurchaseStore()
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
// 查看状态挂在 store 上：路由切换会重建本组件，筛选 / 展开 / 勾选 / 滚动位置不能跟着清空。
const viewStore = useInventoryViewStore()
const {
  productFilter,
  colorFilter,
  selectedWarningTones,
  selectedModeLabels,
  selectedSpuGradeKeys,
  onlyOrdered,
  onlyOrdering,
  onlyArrived,
  expandedProductKeys,
  selectedSkuIds,
  selectedRowId,
  tableScrollTop,
} = storeToRefs(viewStore)

// 两个模式多选不渲染一坨标签胶囊（选两个就会被压成「+1」），只在框里显示一行摘要：
// 单选显示值、多选按「、」连起来，放不下由 CSS 截断，完整列表在悬停标题里。
const spuFilterSummary = computed(() =>
  selectedSpuGradeKeys.value
    .map((key) => spuGradeFilterOptions.value.find((option) => option.key === key)?.label ?? key)
    .join('、'),
)
const spuFilterTitle = computed(() => {
  const basis =
    'SPU 模式 = 该品名下全部可见 SKU 的月均条数之和落在哪一档（S+ / S / A / B / C / Z），阈值见设置页「SPU 分级」'
  const count = selectedSpuGradeKeys.value.length
  return count
    ? `已选 ${spuFilterSummary.value}（共 ${count} 项），下面的预警计数已按此收窄；${basis}`
    : basis
})
const modeFilterSummary = computed(() => selectedModeLabels.value.join('、'))
const modeFilterTitle = computed(() => {
  const basis =
    'SKU 模式 = 热销 / 常规 / 按量 / 尾货 / 滞销（带「·专属品」标记），按备货配置的模式区间判定'
  const count = selectedModeLabels.value.length
  return count
    ? `已选 ${modeFilterSummary.value}（共 ${count} 项），下面的预警计数已按此收窄；${basis}`
    : basis
})
const expandingProductKeys = ref(new Set())
// 需安排草稿同样跟着 store 走：直接持有对象引用，手填的值切页回来还在（导入时统一清空）。
const plannedDrafts = viewStore.plannedDrafts
// 勾选预填的草稿同样放 store：切页回来再取消勾选，仍能认出「这是我自动填的」。
const autoFilledDrafts = viewStore.selectionAutoDrafts
// SKU 详情弹窗只保留一个实例并挂在页面层级：放在虚拟滚动行里会随行卸载，
// 遮罩还会被列表的 transform 容器裁掉。
const skuDetailVisible = ref(false)
const skuDetailItem = ref(null)
// 手动添加 SKU 弹窗：字段与导入总表 / 销售表一致，写入后由 toast 给出「查看该 SKU」入口。
const addSkuDialogVisible = ref(false)

function openSkuDetail(item) {
  skuDetailItem.value = item
  skuDetailVisible.value = true
  // 从详情按钮 / 右键菜单打开弹窗时也把这一行标成「当前行」：
  // 弹窗盖住了表格，用户需要知道看的是哪一行（只改高亮，不动勾选）。
  if (item && !item.isProductGroup && item.id) selectedRowId.value = item.id
}

// 弹窗里的采纳 / 撤销会重建表格行，弹窗持有的是行对象快照，这里换成新行，
// 否则「需安排」与评分会停在旧值上（虚拟列表的行对象是不可变的）。
function syncSkuDetailItem() {
  const current = skuDetailItem.value
  if (!current) return
  const index = leafRowIndexById.get(current.id)
  const next = index === undefined ? null : inventoryLeafRows.value[index]
  if (next && next !== current) skuDetailItem.value = next
}

// 弹窗「采纳」：走与行内采纳同一条写入路径（覆盖需安排 + 记撤销 + 落盘），但不跳转页面。
function handleDialogAdoptPlanned({ item, planned } = {}) {
  const target = item ? itemById.value.get(item.id) : null
  if (!target) return
  const written = writePlanned([{ id: target.id, planned }])
  if (written.length === 0) return
  syncSkuDetailItem()
  ElMessage.success(`已采纳 ${formatQuantity(planned)} 公斤，已写入需安排（去「采购下单」拆单）`)
}

function handleDialogUndoPlanned({ item } = {}) {
  if (!item || !hasPlannedUndo(item.id)) return
  undoPlannedAcceptance(item)
  syncSkuDetailItem()
  ElMessage.success('已撤销这次采纳，需安排已恢复原值')
}

// 弹窗里的「需安排」与表格那一格共用同一份草稿（viewStore.plannedDrafts）：
// 任一输入即时同步到另一边，已采纳的行两边都是锁定态。
const dialogPlannedDraft = computed(() => {
  const item = skuDetailItem.value
  return item ? getPlannedDraft(item) : null
})

function handleDialogPlannedDraft(value) {
  const item = skuDetailItem.value
  if (!item) return
  updatePlannedDraft(item.id, value)
}

// 导入 / 添加成功提示（带进度条）。action 有值时 toast 里带一个按钮，并把停留时间延长到 8 秒。
const importToast = reactive({ visible: false, message: '', progress: 100, actionLabel: '' })
let importToastTimer = null
let importToastStart = 0
let importToastAction = null

function hideImportToast() {
  if (importToastTimer) {
    clearInterval(importToastTimer)
    importToastTimer = null
  }
  importToast.visible = false
  importToast.actionLabel = ''
  importToastAction = null
}

function showImportToast(message, action = null) {
  if (importToastTimer) clearInterval(importToastTimer)
  importToastAction = action?.handler ?? null
  importToast.actionLabel = action?.label ?? ''
  importToast.message = message
  importToast.progress = 100
  importToast.visible = true
  importToastStart = Date.now()
  const duration = importToast.actionLabel ? 8000 : 5000
  importToastTimer = setInterval(() => {
    const elapsed = Date.now() - importToastStart
    const remaining = Math.max(0, 1 - elapsed / duration)
    importToast.progress = remaining * 100
    if (elapsed >= duration) hideImportToast()
  }, 50)
}

function runImportToastAction() {
  const action = importToastAction
  hideImportToast()
  action?.()
}

// 添加成功后：新 SKU 会按品名聚合排序（没有动销数据时还会沉到列表末尾），
// 必须主动滚到该行并短暂高亮，否则用户会以为没有加上。
const highlightedRowId = ref(null)
let highlightTimer = 0

// 点已采纳锁定的行（整行 / 选择格 / 需安排格）时闪一下：把视线引到这一行的
// 「需安排」与「撤销」——输入框淡一点、撤销按钮明显一点。
const lockedHintRowId = ref(null)
let lockedHintTimer = 0

function revealSkuRow(item) {
  const productKey = `product:${item.product}`
  if (!expandedProductKeys.value.includes(productKey)) {
    expandedProductKeys.value = [...expandedProductKeys.value, productKey]
  }

  const locate = () =>
    tableRows.value.findIndex((row) => !row.isProductGroup && row.id === item.id)

  // 新行被当前筛选挡住时先清空筛选；清空筛选的那个 watch 会把 scrollTop 复位到 0，
  // 所以这一轮直接返回 false，交给重试循环在下一轮（watch 跑完）再定位。
  const index = locate()
  if (index < 0 && hasActiveFilters.value) {
    resetFilters()
    applyKeywordFilters()
    return false
  }
  if (index < 0) return false

  highlightedRowId.value = item.id
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = window.setTimeout(() => {
    highlightTimer = 0
    highlightedRowId.value = null
  }, 2600)

  const target = Math.max(
    0,
    index * TABLE_ROW_HEIGHT - (tableScrollRef.value?.clientHeight ?? 0) / 2 + TABLE_ROW_HEIGHT / 2,
  )
  // 先改虚拟窗口再改真实滚动位置：行高撑开后 scrollTop 才不会被夹到旧的最大值。
  tableScrollTop.value = target
  nextTick(() => {
    const element = tableScrollRef.value
    if (element) element.scrollTop = target
  })
  return true
}

// 品名分组要等 inventoryRows 的 watch 跑完才会自动展开，筛选清空也要等下一轮刷新，
// 所以定位失败时隔几十毫秒重试几次，直到新行真的出现在可见行里。
// 这里用 setTimeout 而不是 requestAnimationFrame：窗口在后台时 rAF 会被浏览器暂停。
function scheduleRevealSkuRow(item, attempt = 0) {
  if (revealSkuRow(item)) return
  if (attempt >= 8) return
  window.setTimeout(() => scheduleRevealSkuRow(item, attempt + 1), 40)
}

function handleSkuAdded(item) {
  // 手动添加的行属于事实层：并入当前快照（不新建快照，否则 5 个名额很快被手动添加占满）。
  persistFactLayer(inventoryStore, { createSnapshot: false, source: 'manual' })
  // watch(inventoryItems.length) 会在 nextTick 前重建行，这里等重建完成后再定位新行。
  nextTick(() => {
    // 品名级屏蔽会连新加的 SKU 一起挡住，这里直接给出解除入口，不让用户以为添加失败。
    if (isItemHidden(item)) {
      showImportToast(
        `已添加 SKU：${item.product} / ${item.color}，但它在屏蔽列表中，解除屏蔽后才会显示`,
        { label: '打开屏蔽列表', handler: () => { router.push({ name: 'hidden' }) } },
      )
      return
    }
    showImportToast(`已添加 SKU：${item.product} / ${item.color}`, {
      label: '查看该 SKU',
      handler: () => openSkuDetail(item),
    })
    scheduleRevealSkuRow(item)
  })
}
const urgentPlanDialogVisible = ref(false)
const urgentPlanRows = ref([])
// 弹窗里的长列表按虚拟滚动渲染：上万个紧急 SKU 时直接 v-for 会把主线程卡住十几秒。
const URGENT_PLAN_ROW_HEIGHT = 48

// 主面板与销售表共用同一条导入流程：分表清洗出总表 + 销售表后直接写入，不再弹预览确认框。
const sourceImport = useSourceImport({
  onApplied: handleSourcesImported,
})

// 导入分表：选 5 张分表 → 清洗出总表 + 销售表 → 直接写入。
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

// 「SKU 数据变动」：每次导入后自动弹一次差异汇总；历史几份（含刷新后）从「数据变动」按钮回看。
// diff 由 data 层在导入时算好并落盘（src/data/importDiff.js），这里只负责读出来给弹窗。
const importDiffs = shallowRef([])
const importDiffDialogVisible = ref(false)

async function refreshImportDiffs() {
  importDiffs.value = await loadImportDiffs()
}

function openImportDiffDialog() {
  if (!importDiffs.value.length) return
  importDiffDialogVisible.value = true
}

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
  const evaluated = evaluateItem(item, stockingEvaluator.value)
  // 采购执行层：已下单 / 已到货来自订单流水（只统计 active）；
  // 在途由 src/purchase/inTransit.js 对账得出，传入后预计库存改用「在仓 + 在途 + 需安排」。
  const orders = orderSummaryOf(purchaseStore.orderIndex, evaluated.skuId)
  const row = calculateInventoryRow({
    ...evaluated,
    ordered: orders.ordered,
    received: orders.received,
    ...(inTransitOf(evaluated.skuId) ?? {}),
  })
  return {
    ...row,
    searchProduct: row.product.toLocaleLowerCase('zh-CN'),
    searchColor: row.color.toLocaleLowerCase('zh-CN'),
  }
}

// 屏蔽清单里的品名 / SKU 不进主面板：屏蔽只是记一笔，源表与销售数据不动。
function isItemHidden(item) {
  const product = String(item?.product ?? '')
  if (product && stockingStore.hiddenProductKeys.has(product)) return true
  const skuId = String(item?.skuId ?? '').trim()
  return Boolean(skuId) && stockingStore.hiddenSkuKeys.has(skuId)
}

const inventoryLeafRows = shallowRef([])
// 每个品名的月均条数合计（含该品名下全部可见 SKU，被屏蔽的不算）：SPU 等级按它判定，不随筛选变化。
const productMonthlyTotals = shallowRef(new Map())
// 品名 → SPU 等级 key，口径与父行徽标同一份（全部可见 SKU 的月均合计，不看筛选），
// 所以按等级筛选是整组保留 / 整组隐藏，父行合计不会被筛切断。
const productGradeKeys = computed(() => {
  const grades = spuGrades.value
  const keys = new Map()
  for (const [product, monthlyAvg] of productMonthlyTotals.value) {
    keys.set(product, resolveSpuGrade(monthlyAvg, grades)?.key ?? UNGRADED_SPU_GRADE_KEY)
  }
  return keys
})
const leafRowIndexById = new Map()

function displayColor(color) {
  return String(color ?? '').replace(/（演示\d+）$/, '')
}

// 模式列悬停说明：该模式怎么比较、为什么可能不参与计算。
function modeTitle(row) {
  if (!row) return ''
  if (row.manualBehavior === 'order') return '订单货：按客户订单填量，不参与预警与评分'
  if (row.strategy === 'manual') return `手动策略 · ${row.modeLabel}`
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
  return `SPU 等级 ${row.spuGrade.label}：品名下可见 SKU 月均合计 ${formatQuantity(row.spuMonthlyAvg)} 条（${threshold}）`
}

// 模式筛选项取当前数据里实际出现的模式标签（含「热销·专属品」这类标记），配置改动后自动跟随。
const modeOptions = computed(() =>
  [...new Set(inventoryLeafRows.value.map((row) => row.modeLabel).filter(Boolean))].sort(
    (first, second) => productCollator.compare(first, second),
  ),
)

// 订单货：不计算、不预警，但按客户订单照常进货，排序时不能跟着尾货一起沉底。
function sinksToBottom(row) {
  return Boolean(row.excluded) && row.manualBehavior !== 'order'
}

// 「已采纳」提示的对照行缓存（键见 shadowOf）：整表重算时一起清掉，
// 备货配置或订单改了不会读到旧口径。
const plannedShadows = new Map()

function rebuildLeafRows() {
  plannedShadows.clear()
  const rows = inventoryItems
    .filter((item) => !isItemHidden(item))
    .map((item) => buildLeafRow(item))
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
  // 沉底只按「品名」判定：同品名里有正常动销的 SKU，整组就留在正常排序里，
  // 否则慢动销的 SKU 会把同品名的其它行隔到列表末尾，品名被拆成多个父行。
  const productSinks = new Map()
  for (const row of rows) {
    const sinks = sinksToBottom(row)
    if (!productSinks.has(row.product)) productSinks.set(row.product, sinks)
    else if (!sinks) productSinks.set(row.product, false)
  }
  rows.sort((first, second) => {
    // 尾货 / 滞销 / 专属品不参与备货排名，整组沉到列表末尾；
    // 订单货只是不预警，仍然正常动销，按销量参与排序。
    const slowDiff =
      Number(productSinks.get(first.product)) - Number(productSinks.get(second.product))
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
    // 同一品名内，慢动销的 SKU 排到该品名子行的最后。
    const rowSlowDiff = Number(sinksToBottom(first)) - Number(sinksToBottom(second))
    if (rowSlowDiff !== 0) return rowSlowDiff
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
// 行数不变但数据集换了（每天导入同一批 SKU）时，靠事实层版本号重建。
watch(() => inventoryStore.factRevision, rebuildLeafRows)
// 备货配置（模式 / 系数）修改后，整表按新配置重算。
watch(() => stockingStore.config, rebuildLeafRows)
// 手动清单变化（策略切换、改系数、恢复自动）同样要整表重算。
watch(() => stockingStore.manual, rebuildLeafRows)
// 屏蔽清单变化（删除 / 恢复）：父行合计、预警计数、筛选与导出都按可见行重算，
// 同时清掉已不在表里的勾选，避免批量条统计到看不见的 SKU。
watch(() => stockingStore.hidden, () => {
  rebuildLeafRows()
  pruneHiddenSelection()
})

// 订单变化（确认下单 / 撤销 / 到货 / 改单）要重算整表：已下单进预计库存，预警跟着变。
// 只签「已下单 / 已到货」，编辑草稿时签名不变，避免每敲一个字就重建 3 万行。
const orderSignature = computed(() => {
  const parts = []
  for (const [skuId, entry] of purchaseStore.orderIndex) {
    parts.push(`${skuId}:${entry.ordered}:${entry.received}`)
  }
  return parts.sort().join('|')
})
watch(orderSignature, rebuildLeafRows)

// 需安排的两个提示层（右侧「预计库存 / 日库销比 / 缺口量 / 缺口率」4 列）：
// - 草稿（键入 / 勾选带入，还没采纳）：把草稿当成「已采纳」先算一遍，立刻显示结果，采纳后才落成正式数字；
// - 已采纳、还没下单（需安排 > 0）：继续标出「这一单带来的变化」，直到在「采购下单」确认下单、
//   需安排清零（数字转到累计下单）才消失 —— 只要需安排还有数字，提示就一直挂着。
//
// 两层都只重算用到的行，不整表重算。草稿层缓存 id → { source, quantity, preview }：
// 读的时候顺手比对「草稿数字 + 源行」，任一边变了就重算，所以「需安排有数字」与「有提示」
// 永远同步，不用谁记得去刷新（切页回来、导入、采纳后清草稿、撤销订单退回草稿都自动跟上）。
const plannedPreviews = new Map()

// 预览只认「填了正数」的草稿：清空输入框、填 0 都回到当前行的口径，不显示预览。
function buildRowWithPlanned(item, planned) {
  const evaluated = evaluateItem({ ...item, planned }, stockingEvaluator.value)
  const orders = orderSummaryOf(purchaseStore.orderIndex, evaluated.skuId)
  return calculateInventoryRow({
    ...evaluated,
    ordered: orders.ordered,
    received: orders.received,
    ...(inTransitOf(evaluated.skuId) ?? {}),
  })
}

// —— 在途三列（已安排 / 生产中 / 在途）——
// 都来自对账结果；没有基线（还没导入过）时退回导入值 / 旧口径，不让列变空。
function producingText(row) {
  return formatQuantity(Number.isFinite(row.producingKg) ? row.producingKg : row.inTransitStock)
}

function arrangedText(row) {
  return Number.isFinite(row.arrangedKg) ? formatQuantity(row.arrangedKg) : '—'
}

function inTransitText(row) {
  if (Number.isFinite(row.inTransitKg)) return formatQuantity(row.inTransitKg)
  return row.isProductGroup && !row.ordered ? '—' : formatQuantity(row.ordered)
}

function previewOfLeaf(row) {
  const quantity = draftQuantity(row.id)
  if (!(quantity > 0)) return null
  const cached = plannedPreviews.get(row.id)
  if (cached && cached.source === row && cached.quantity === quantity) return cached.preview
  const item = itemById.value.get(row.id)
  if (!item) return null
  const preview = buildRowWithPlanned(item, quantity)
  plannedPreviews.set(row.id, { source: row, quantity, preview })
  return preview
}

// 「已采纳」提示的对照行：把需安排清零再算一遍，差的这部分就是这单计划带来的变化。
// 键里带 需安排 / 累计下单 / 到货，任何一项变了都会重算。
function shadowOf(row) {
  if (!row || row.isProductGroup) return null
  const planned = Number(row.planned) || 0
  if (!(planned > 0)) return null
  const key = `${row.id}|${planned}|${row.ordered}|${row.received}`
  const cached = plannedShadows.get(key)
  if (cached) return cached
  const item = itemById.value.get(row.id)
  if (!item) return null
  // 只缓存滚动过的少数组合，别让长时间浏览把内存堆起来。
  if (plannedShadows.size > 400) plannedShadows.clear()
  const shadow = buildRowWithPlanned(item, 0)
  plannedShadows.set(key, shadow)
  return shadow
}

// 品名父行的预估列是子行汇总，也要跟着预览：把草稿行换成预览行再按同一口径汇总。
const productPlannedPreviews = computed(() => {
  const previews = {}
  for (const group of inventoryRows.value) {
    if (!group.isProductGroup) continue
    if (!group.children.some((child) => previewOfLeaf(child))) continue
    const aggregated = groupRowsByProduct(
      group.children.map((child) => previewOfLeaf(child) ?? child),
    ).find((entry) => entry.isProductGroup)
    if (aggregated) previews[group.id] = aggregated
  }
  return previews
})

// 品名父行的「已采纳」对照行同样按子行汇总：把子行的需安排清零版换进去再汇总。
const productPlannedShadows = computed(() => {
  const shadows = {}
  for (const group of inventoryRows.value) {
    if (!group.isProductGroup) continue
    if (!group.children.some((child) => (Number(child.planned) || 0) > 0)) continue
    const aggregated = groupRowsByProduct(
      group.children.map((child) => shadowOf(child) ?? child),
    ).find((entry) => entry.isProductGroup)
    if (aggregated) shadows[group.id] = aggregated
  }
  return shadows
})

// 提示对：display 是要显示的「有这单计划」的行，base 是「没有这单计划」的对照行。
// 草稿层先算，采纳后（需安排 > 0）退出草稿层、改用对照行继续提示。
function previewPair(row) {
  if (!row) return null
  const draft = previewOf(row)
  if (draft) return { kind: 'draft', display: draft, base: row }
  const base = row.isProductGroup
    ? productPlannedShadows.value[row.id] ?? null
    : shadowOf(row)
  if (!base) return null
  return { kind: 'adopted', display: row, base }
}

// 只看草稿层的预览行：预警灯与「需安排」格的预览样式仍只认还没采纳的草稿。
function previewOf(row) {
  if (!row) return null
  if (row.isProductGroup) return productPlannedPreviews.value[row.id] ?? null
  return previewOfLeaf(row)
}

function getPlannedTone(row) {
  return previewOf(row)?.urgencyTone || row.urgencyTone
}

// 预警的两个态，别混：
// - 数据态（dataStateOf / dataTone）：把需安排清零重算，只由导入数据 + 订单派生；
// - 预计展示态（getPlannedTone）：把需安排（草稿或已采纳）算进去，只负责显示。
// 筛选、计数、紧急补货清单只认数据态：采纳后行不会从「紧急 / 常规」里掉出去，灯变绿表示预计已补；
// 在采购下单确认下单（需安排清零、数字转到累计下单）之后才按订单数据换档。
function dataStateOf(row) {
  if (!row || row.isProductGroup) return row
  return shadowOf(row) ?? row
}

function dataTone(row) {
  return (dataStateOf(row) ?? row).urgencyTone
}

// 灯色是「预计值」而数据态是另一档时套环：草稿虚线环（还没采纳），已采纳未下单实线环。
function lampRingClass(row) {
  if (row.isProductGroup) return ''
  if (previewOf(row)) return 'urgency-indicator--preview'
  return dataTone(row) !== row.urgencyTone ? 'urgency-indicator--projected' : ''
}

// 预警灯说明：把「数据态」与「预计」分开写，别让人把预计色当成事实读。
function urgencyTitle(row) {
  if (row.isProductGroup) return row.strategyIssue || ''
  const dataText = dataStateOf(row).urgencyText
  const preview = previewOf(row)
  if (preview) {
    const shift =
      preview.urgencyTone === dataTone(row)
        ? `预警仍是「${preview.urgencyText}」`
        : `预警变为「${preview.urgencyText}」`
    return `预览（未采纳）：需安排 ${formatQuantity(draftQuantity(row.id))} 后${shift}，采纳后才生效`
  }
  if (dataTone(row) !== row.urgencyTone) {
    return `预计（已采纳、还没下单）：需安排 ${formatQuantity(row.planned)} 公斤后预警变为「${
      row.urgencyText
    }」，数据态仍是「${dataText}」；确认下单后按订单数据重算`
  }
  return row.strategyIssue || row.urgencyText
}

// —— 备货：订单弹窗 ——
// 已下单 / 已到货是订单流水的派生值，重新导入不会影响；弹窗里做撤销与到货登记。
const orderDialogVisible = ref(false)
const orderDialogRow = ref(null)

function openOrderDialog(row) {
  if (!row || row.isProductGroup) return
  orderDialogRow.value = row
  orderDialogVisible.value = true
}

function orderCellTitle(row) {
  if (!row || row.isProductGroup) return ''
  const inTransit = Number.isFinite(row.inTransitKg) ? row.inTransitKg : null
  // 在途归零 = 这批货已经进仓，行尾图标转灰：它是「下过单」的记录，不再是待收。
  const state =
    inTransit === null ? '' : inTransit > 0 ? `在途 ${formatQuantity(inTransit)} 公斤` : '已全部到仓'
  return `下过单${state ? `（${state}）` : ''}：累计下单 ${formatQuantity(row.ordered)} 公斤，点行尾图标看分订单`
}

// 撤销订单后把公斤数退回需安排：落在未锁的草稿层（显示但不计入预计库存），
// 于是预警退回「紧急补货」，需要重新采纳才算有效计划。
function handleOrderCancelled({ skuId, quantity }) {
  const item = inventoryItems.find((entry) => String(entry.skuId ?? '').trim() === skuId)
  if (!item) return

  plannedDrafts[item.id] = draftQuantity(item.id) + (Number(quantity) || 0)
}

const warningFilters = [
  { key: 'all', label: '全部' },
  { key: 'red', label: '紧急' },
  { key: 'yellow', label: '常规' },
  { key: 'green', label: '正常' },
  { key: 'purple', label: '超库存' },
]
const warningToneFilters = warningFilters.filter((filter) => filter.key !== 'all')
// 小额补货：紧急 / 常规里建议需安排不足门槛的行，筛选时不列出来（补一点点不值得单独开单）。
// 只作用于这两档，正常 / 超库存 / 不参与备货的 SKU 不受影响，订单货按客户报量也不受影响。
function isLowPlanned(row) {
  if (lowPlannedThreshold.value <= 0) return false
  const tone = dataTone(row)
  if (tone !== 'red' && tone !== 'yellow') return false
  return getSuggestedPlanned(row) < lowPlannedThreshold.value
}

const warningCounts = computed(() => {
  const counts = { all: 0, red: 0, yellow: 0, green: 0, purple: 0 }
  // 被小额门槛挡掉的数量：给筛选按钮的悬停说明用，计数对不上时能解释清。
  const lowPlanned = { red: 0, yellow: 0 }
  // 计数只跟「除预警色以外」的筛选：数字等于点下该档后能看到的行数，
  // 选中某档时也不会因为自己的选择把数字越点越小。
  for (const row of scopedInventoryLeafRows.value) {
    counts.all += 1
    const tone = dataTone(row)
    if (!(tone in counts)) continue
    if (isLowPlanned(row)) {
      lowPlanned[tone] += 1
      continue
    }
    counts[tone] += 1
  }
  return { ...counts, lowPlanned }
})

// 筛选按钮的悬停说明：计数按「除预警色以外」的筛选算，并写明小额门槛排除了多少。
function warningFilterTitle(key) {
  if (key === 'all') {
    return `清除采购状态与预警筛选（保留品名、颜色、SPU / SKU 模式条件）；计数 ${warningCounts.value.all} 行 = 当前筛选内的可见 SKU 数（含模式缺省 / 不参与备货的行）`
  }
  const label = warningFilters.find((filter) => filter.key === key)?.label ?? ''
  const scope = `计数 ${warningCounts.value[key] ?? 0} 个 = 当前筛选内本档的 SKU 数（不含预警色自身的选择）`
  // 计数按数据态（把需安排清零）：采纳后行仍留在原档，灯变绿表示预计已补，确认下单后才移出。
  const basis =
    key === 'red' || key === 'yellow'
      ? `只看${label}（按数据态判定：采纳后仍留在本档，灯变绿表示预计已补，确认下单后才移出）；${scope}`
      : `只看${label}（按数据态判定：还没下单的需安排不算进来）；${scope}`
  if (key !== 'red' && key !== 'yellow') return basis
  if (lowPlannedThreshold.value <= 0) {
    return `${basis}；小额补货门槛已在设置里关闭`
  }
  const hidden = warningCounts.value.lowPlanned[key] ?? 0
  return hidden > 0
    ? `${basis}；已排除需安排 < ${lowPlannedThreshold.value} 公斤的 ${hidden} 个 SKU（设置 → 备货配置 → 筛选显示规则）`
    : `${basis}；小额补货门槛 ${lowPlannedThreshold.value} 公斤，当前没有可排除的行`
}
const hasActiveFilters = computed(
  () =>
    productFilter.value.trim() !== '' ||
    colorFilter.value.trim() !== '' ||
    onlyOrdered.value ||
    onlyOrdering.value ||
    onlyArrived.value ||
    selectedWarningTones.value.length > 0 ||
    selectedModeLabels.value.length > 0 ||
    selectedSpuGradeKeys.value.length > 0,
)

// 「资料类」条件是否生效：关键词（取防抖后的值）+ 两个模式。
// 预警 chip 的计数按它收窄（见 scopedInventoryLeafRows），所以组名要跟着标「筛选后」。
const hasScopeFilters = computed(
  () =>
    appliedProductFilter.value !== '' ||
    appliedColorFilter.value !== '' ||
    selectedModeLabels.value.length > 0 ||
    selectedSpuGradeKeys.value.length > 0,
)
const isAllFilterSelected = computed(
  () =>
    !onlyOrdered.value &&
    !onlyOrdering.value &&
    !onlyArrived.value &&
    selectedWarningTones.value.length === 0,
)

// 采购状态三态（互斥）：下单中（已采纳、等确认下单）→ 已下单（确认了、还没到仓）→ 已到仓（下过单、货已全部进仓）。
// 判据都看在途（已安排 + 生产中），不看只增不减的「累积下单」：累积下单到仓后还是原值，
// 拿它当「已下单」会让货已经进仓的 SKU 一直挂在「已下单」里，跟预警的时间轴对不上。
function hasOrderInTransit(row) {
  return (row.inTransitKg ?? 0) > 0
}

// 已下单 = 我们下过单（有有效订单流水）且货还没到仓。只看到途不够：
// 第一次导入时排单表里可能本来就有产量（提前备货 / 外面下的单），那批货不是「我们已下单」。
function isOrderWaitingArrival(row) {
  return (row.ordered ?? 0) > 0 && hasOrderInTransit(row)
}

// 已到仓 = 下过单，且那批货已经全部进仓（在途归零），回到普通 SKU 等下一次预警。
function isOrderSettled(row) {
  return (row.ordered ?? 0) > 0 && !hasOrderInTransit(row)
}

// 三个 chip 分别计数，与预警组同口径（按资料类筛选后的范围算）。
const orderedCount = computed(
  () => scopedInventoryLeafRows.value.filter(isOrderWaitingArrival).length,
)

// 已到仓 = 下过单但已经全部到仓：留个记录，方便回看「这个品上次那单到齐没有」。
const arrivedCount = computed(
  () => scopedInventoryLeafRows.value.filter(isOrderSettled).length,
)

function toggleOrderFilter() {
  const isSelected = onlyOrdered.value
  selectedWarningTones.value = []
  onlyOrdered.value = !isSelected
  onlyOrdering.value = false
  onlyArrived.value = false
}

function toggleArrivedFilter() {
  const isSelected = onlyArrived.value
  selectedWarningTones.value = []
  onlyArrived.value = !isSelected
  onlyOrdered.value = false
  onlyOrdering.value = false
}

// 「下单中」筛的是主面板已采纳并锁定、等待确认下单的 SKU。
const orderingCount = computed(
  () => scopedInventoryLeafRows.value.filter((row) => isPlannedLocked(row)).length,
)

function toggleOrderingFilter() {
  const isSelected = onlyOrdering.value
  selectedWarningTones.value = []
  onlyOrdered.value = false
  onlyArrived.value = false
  onlyOrdering.value = !isSelected
}

// 关键词筛选输入防抖，避免大表逐键全量过滤。
// 初值直接取 store 里还原出来的输入：回到主面板时不能再等一次输入才生效。
const appliedProductFilter = ref(productFilter.value.trim().toLocaleLowerCase('zh-CN'))
const appliedColorFilter = ref(colorFilter.value.trim().toLocaleLowerCase('zh-CN'))
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

// 「资料类」筛选结果（品名 / 颜色 / SPU 模式 / SKU 模式）：两组 chip 的计数都按它算。
// 采购状态与预警色互斥、点任一个会清掉另一组，所以计数不把自己所在组的选择算进去，
// 数字正好等于「点下去能看到的行数」，也不会因为选了自己而越点越小。
const scopedInventoryLeafRows = computed(() => {
  const product = appliedProductFilter.value
  const color = appliedColorFilter.value
  const modes = selectedModeLabels.value
  const gradeKeys = selectedSpuGradeKeys.value
  if (!product && !color && modes.length === 0 && gradeKeys.length === 0) {
    return inventoryLeafRows.value
  }

  const modeSet = modes.length > 0 ? new Set(modes) : null
  const gradeSet = gradeKeys.length > 0 ? new Set(gradeKeys) : null
  const grades = productGradeKeys.value
  return inventoryLeafRows.value.filter(
    (row) =>
      (!product || row.searchProduct.includes(product)) &&
      (!color || row.searchColor.includes(color)) &&
      (!modeSet || modeSet.has(row.modeLabel)) &&
      (!gradeSet ||
        gradeSet.has(grades.get(row.product) ?? UNGRADED_SPU_GRADE_KEY)),
  )
})

const filteredInventoryLeafRows = computed(() => {
  const tones = selectedWarningTones.value
  const orderedOnly = onlyOrdered.value
  const orderingOnly = onlyOrdering.value
  const arrivedOnly = onlyArrived.value
  const scoped = scopedInventoryLeafRows.value
  if (tones.length === 0 && !orderedOnly && !orderingOnly && !arrivedOnly) return scoped
  const toneSet = tones.length > 0 ? new Set(tones) : null
  return scoped.filter(
    (row) =>
      (!toneSet || (toneSet.has(dataTone(row)) && !isLowPlanned(row))) &&
      (!orderedOnly || isOrderWaitingArrival(row)) &&
      (!orderingOnly || isPlannedLocked(row)) &&
      (!arrivedOnly || isOrderSettled(row)),
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
  onlyOrdered.value = false
  onlyOrdering.value = false
  onlyArrived.value = false
  selectedWarningTones.value = []
  selectedModeLabels.value = []
  selectedSpuGradeKeys.value = []
}

// 工具栏上的「清除筛选」：所有条件一起清，并把防抖副本同步掉（否则关键词输入框已空、表格还按旧词筛）。
function clearAllFilters() {
  resetFilters()
  applyKeywordFilters()
}

function toggleWarningFilter(key) {
  if (key === 'all') {
    onlyOrdered.value = false
    onlyOrdering.value = false
    onlyArrived.value = false
    selectedWarningTones.value = []
    return
  }

  onlyOrdered.value = false
  onlyOrdering.value = false
  onlyArrived.value = false
  const selectedTones = new Set(selectedWarningTones.value)
  if (selectedTones.has(key)) selectedTones.delete(key)
  else selectedTones.add(key)
  selectedWarningTones.value = [...selectedTones]
}

// null = 第一次进主面板，默认全部展开；恢复上次状态时原样沿用（空数组就是用户把品名都收起了）。
if (!expandedProductKeys.value) expandedProductKeys.value = inventoryRows.value.map((row) => row.id)
// 新出现的品名（导入 / 手动加行）自动展开。基准取当前数据，恢复「全部收起」时不会被强制展开。
let knownProductKeys = new Set(inventoryRows.value.map((row) => row.id))
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
  { key: 'rule', label: '模式', width: 86, group: '信息' },
  { key: 'score', label: '评分', width: 58, group: '信息' },
  { key: 'product', label: '品名', width: 150, group: '商品' },
  { key: 'color', label: '颜色', width: 132, group: '商品' },
  { key: 'urgency', label: '预警', width: 44, group: '商品' },
  { key: 'planned', label: '需安排', width: 142, group: '入口' },
  { key: 'inTransitStock', label: '生产中', width: 84, group: '入口' },
  // 已安排 = 下了单但还没上排单的部分；生产中 + 已安排 = 在途（见 src/purchase/inTransit.js）
  { key: 'arranged', label: '已安排', width: 84, group: '入口' },
  // 下过单 = 订单流水的累计下单（只增不减，留痕用）。到没到仓看在途库存列：
  // 「待收 / 到货」两列已删 —— 到仓事实以导入的出入库明细为准，手工到货只做兜底。
  { key: 'ordered', label: '下过单', width: 84, group: '入口' },
  { key: 'backorder', label: '欠货', width: 68, group: '出口' },
  { key: 'weeklySales', label: '周销量', width: 76, group: '出口' },
  { key: 'turnoverIn', label: '周转入', width: 74, group: '库存(公斤)' },
  // 在途库存与「累积下单」同源（订单流水，不来自导入）：显示该 SKU 累计下单公斤。
  { key: 'inTransitOrdered', label: '在途库存', width: 84, group: '库存(公斤)' },
  { key: 'warehouseStock', label: '在仓库存', width: 84, group: '库存(公斤)' },
  { key: 'theoreticalStock', label: '理论库存', width: 84, group: '库存(公斤)' },
  { key: 'projectedStock', label: '预计库存', width: 84, group: '库存(公斤)' },
  { key: 'daysOfStock', label: '日库销比', width: 80, group: '数据反馈' },
  { key: 'shortage', label: '缺口量', width: 72, group: '数据反馈' },
  { key: 'shortageRate', label: '缺口率', width: 76, group: '数据反馈' },
]
const visibleTableColumns = computed(() => TABLE_COLUMNS)
// 各列按自身宽度分配剩余空间，始终铺满可用宽度，避免右侧出现空列
const tableGridTemplate = computed(() =>
  visibleTableColumns.value
    .map((column) => `minmax(${column.width}px, ${column.width}fr)`)
    .join(' '),
)
const tableTotalWidth = computed(() =>
  visibleTableColumns.value.reduce((total, column) => total + column.width, 0),
)
const tableColumnGroups = computed(() => {
  const groups = []
  for (const column of visibleTableColumns.value) {
    const last = groups[groups.length - 1]
    if (last && last.label === column.group) last.span += 1
    else groups.push({ label: column.group, span: 1 })
  }
  return groups
})

// 开发态自检：增删列后忘了补 / 清表头说明时在控制台点名（生产构建不执行）。
if (import.meta.env.DEV) {
  checkInventoryColumnHints(TABLE_COLUMNS, columnHints.value)
}

const tableScrollRef = ref(null)
const tableViewportHeight = ref(600)
let tableScrollFrame = 0
let tableResizeObserver = null

// 「数据反馈」里受需安排影响的 4 列：键入草稿按预览值展示，采纳后继续标出这单计划带来的变化
// （其余列与理论库存是事实层，不动）。
const PREVIEW_COLUMNS = [
  {
    key: 'projectedStock',
    label: '预计库存',
    value: (row) => row.projectedStock,
    format: (row) => formatQuantity(row.projectedStock),
  },
  {
    key: 'daysOfStock',
    label: '日库销比',
    value: (row) => row.daysOfStock,
    // 按量模式比的是公斤库存（与「预计库存」重复），没有天数口径，统一显示 --。
    format: (row) =>
      row.excluded ? '—' : row.modeKey === 'bulk' ? '--' : formatRatio(row.daysOfStock),
  },
  {
    key: 'shortage',
    label: '缺口量',
    value: (row) => row.shortage,
    format: (row) => (row.excluded ? '—' : formatQuantity(row.shortage)),
  },
  {
    key: 'shortageRate',
    label: '缺口率',
    value: (row) => row.shortageRate,
    format: (row) => (row.excluded ? '—' : formatRate(row.shortageRate, row.strategyAvailable)),
  },
]

function previewKind(row) {
  return previewPair(row)?.kind ?? ''
}

function previewText(row, column) {
  const pair = previewPair(row)
  return pair ? column.format(pair.display) : column.format(row)
}

// 只有「显示值真的变了」的格子才进入提示态：父行的日库销比这类汇总不出的列不打底色。
function isPreviewCell(row, column) {
  const pair = previewPair(row)
  return pair !== null && column.format(pair.display) !== column.format(pair.base)
}

// 变化量：只在两边都是数字且真的变了时给出（∞、缺省这类没有可比性）。
function previewDelta(row, column) {
  const pair = previewPair(row)
  if (!pair) return null
  const before = column.value(pair.base)
  const after = column.value(pair.display)
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null
  const diff = Math.round(after - before)
  if (diff === 0) return null
  return { text: `${diff > 0 ? '+' : '−'}${Math.abs(diff)}`, direction: diff > 0 ? 'up' : 'down' }
}

function previewTone(row) {
  const pair = previewPair(row)
  if (!pair) return ''
  // 父行没有自己的预警灯，用中性的主色提示「这是预览值」。
  return row.isProductGroup ? 'neutral' : pair.display.urgencyTone || 'neutral'
}

// 已采纳未下单的提示淡一档：不再弹入动画，跟键入时的预览区分开（数字已经是落定值）。
function previewCellClass(row, column) {
  if (!isPreviewCell(row, column)) return ''
  return [
    'preview-cell',
    `preview-cell--${previewTone(row)}`,
    previewKind(row) === 'adopted' ? 'preview-cell--adopted' : '',
  ]
}

function previewTitle(row, column) {
  const pair = previewPair(row)
  if (!pair) return ''
  const before = column.format(pair.base)
  const after = column.format(pair.display)
  if (pair.kind === 'adopted') {
    const scope = row.isProductGroup ? '该品名下需安排合计' : '需安排'
    const planned = formatQuantity(row.planned)
    return `已采纳但还没下单：${scope} ${planned} 公斤，${column.label} 从 ${before} 变成 ${after}；在「采购下单」确认下单后这条提示消失`
  }
  if (row.isProductGroup) {
    return `预览（未采纳）：该品名下已填写的需安排合计进来后，${column.label} ${before} → ${after}`
  }
  const draft = Number(plannedDrafts[row.id]) || 0
  return `预览（未采纳）：需安排 ${formatQuantity(draft)} 后，${column.label} ${before} → ${after}；点「采纳」或回车才写入`
}

function handleTableScroll() {
  if (tableScrollFrame) return
  tableScrollFrame = requestAnimationFrame(() => {
    tableScrollFrame = 0
    tableScrollTop.value = tableScrollRef.value?.scrollTop ?? 0
  })
}

// 筛选条件变化后回到顶部：列表缩短时停留在原位置只会看到末尾几行或一片空白。
watch(
  [
    appliedProductFilter,
    appliedColorFilter,
    selectedWarningTones,
    selectedModeLabels,
    selectedSpuGradeKeys,
    onlyOrdered,
    onlyOrdering,
    onlyArrived,
  ],
  () => {
    tableScrollTop.value = 0
    if (tableScrollRef.value) tableScrollRef.value.scrollTop = 0
  },
)

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

  // start 用列表长度夹住：列表变短（筛选 / 屏蔽）时旧的滚动位置不会切到空窗口。
  const start = Math.min(
    Math.max(0, total - 1),
    Math.max(0, Math.floor(tableScrollTop.value / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN),
  )
  const count = Math.ceil(tableViewportHeight.value / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN * 2
  const end = Math.min(total, start + count)

  return {
    rows: rows.slice(start, end),
    offset: start * TABLE_ROW_HEIGHT,
    total,
  }
})
const tableBodyHeight = computed(() => tableVirtualRows.value.total * TABLE_ROW_HEIGHT)

// 组件是重建出来的，但筛选 / 展开 / 草稿都在 store 里，行会按同样的顺序重建，
// 挂载时把滚动位置、草稿预览色与勾选补回来，看起来就跟没离开过一样。
function restoreTableView() {
  // 模式名可能随配置改名：留下的旧名字会把整表筛空，直接剔掉。
  const modeNames = new Set(modeOptions.value)
  const keptModes = selectedModeLabels.value.filter((label) => modeNames.has(label))
  if (keptModes.length !== selectedModeLabels.value.length) selectedModeLabels.value = keptModes

  // SPU 等级存的是档位 key（改阈值只换档、不换 key），这里只清历史残留。
  const gradeKeys = new Set(spuGradeFilterOptions.value.map((option) => option.key))
  const keptGrades = selectedSpuGradeKeys.value.filter((key) => gradeKeys.has(key))
  if (keptGrades.length !== selectedSpuGradeKeys.value.length) {
    selectedSpuGradeKeys.value = keptGrades
  }

  const target = tableScrollTop.value
  if (target > 0) {
    // 排在筛选 watch 的「回到顶部」之后执行，否则会被它压回 0。
    nextTick(() => {
      const element = tableScrollRef.value
      if (!element) return
      element.scrollTop = target
      tableScrollTop.value = element.scrollTop
    })
  }

  // 草稿预览是按行的派生缓存（见 previewOfLeaf）：草稿在 store 里，渲染时自己会重算，
  // 这里不用再补一遍。
  // 勾选可能来自屏蔽前的行，先剔掉已不可见的 SKU。
  pruneHiddenSelection()
  // 勾选状态是从上一页带回来的：补一次预填（只补还没有数字的行）。
  prefillSelectionDrafts([...selectedSkuIds.value])
}

onMounted(() => {
  restoreTableView()
  // 「数据变动」按钮要知道有没有历史记录可看，启动时把最近几份读进内存。
  void refreshImportDiffs()
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
  if (filterDebounceTimer) clearTimeout(filterDebounceTimer)
  if (tableScrollFrame) cancelAnimationFrame(tableScrollFrame)
  if (importToastTimer) clearInterval(importToastTimer)
  if (highlightTimer) clearTimeout(highlightTimer)
  if (lockedHintTimer) clearTimeout(lockedHintTimer)
  tableResizeObserver?.disconnect()
})

// 紧急补货清单也按小额门槛过滤：补几公斤不值得单独开单；被排除了多少个在弹窗里说明，需要时去设置里关掉门槛。
// 成员同样按数据态判定：已采纳的紧急 SKU 仍在清单里，追加量按「补到正常库存」重算（已覆盖的推荐 0）。
const urgentRows = computed(() =>
  inventoryLeafRows.value.filter((row) => dataTone(row) === 'red' && !isLowPlanned(row)),
)
// 紧急补货清单是全量口径（不受筛选影响），被门槛排除的数量也必须按全量算，
// 不能复用 chips 的「当前筛选内」计数，否则弹窗里的排除数与清单对不上。
const excludedUrgentCount = computed(
  () =>
    inventoryLeafRows.value.filter((row) => dataTone(row) === 'red' && isLowPlanned(row)).length,
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
    // 主面板只给精准公斤数，缸数换算在采购下单页做。
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

  writePlanned(accepted)
  urgentPlanDialogVisible.value = false
  urgentPlanRows.value = []
}

function applyAllRecommendedPlans() {
  urgentPlanRows.value.forEach((row) => {
    row.additionalPlan = row.recommendedPlan
  })
}

// 需安排的唯一写入路径：同一 SKU 只保留一条绝对值（覆盖），
// 采购下单页直接按「需安排 > 0」列出待下单的 SKU，不再另存一份采购清单。
// plans 里的 planned 是「需安排」的绝对值（公斤），返回真正写进去的行。
function writePlanned(plans) {
  const changedIds = []
  const written = []
  for (const plan of plans) {
    const item = itemById.value.get(plan.id)
    const planned = Math.round(Number(plan.planned))
    if (!item || !(planned > 0)) continue

    plannedUndoHistory[item.id] = { previousPlanned: item.planned }
    item.planned = planned
    delete plannedDrafts[item.id]
    autoFilledDrafts.delete(item.id)
    changedIds.push(item.id)
    written.push(item)
  }

  if (written.length === 0) return written
  refreshLeafRows(changedIds)
  schedulePlanPersist(inventoryStore)
  return written
}

// —— 需安排 ——
// 一个 SKU 的「需安排」只有三个数，所有按钮 / 勾选 / 预览都从这里派生：
//   草稿（plannedDrafts，可编辑未采纳）→ 已采纳（item.planned，锁定，下单时清零）→ 建议值（补到正常库存）。
function draftQuantityFrom(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(QUANTITY_MAX, Math.round(numeric)) : 0
}

function draftQuantity(id) {
  return draftQuantityFrom(plannedDrafts[id])
}

function hasPlannedDraft(id) {
  return Object.prototype.hasOwnProperty.call(plannedDrafts, id)
}

function hasPlannedUndo(id) {
  return Object.prototype.hasOwnProperty.call(plannedUndoHistory, id)
}

// 「采纳」按下时真正写入的数量：正数草稿 > 建议值（清空 / 从没填过都按建议值兜底）。
function plannedToAdopt(row) {
  return draftQuantity(row.id) || getSuggestedPlanned(row)
}

function getPlannedDraft(row) {
  // 先空读一下草稿表：hasOwnProperty 不走 Vue 的 get 陷阱，不读这一次的话
  // 新增 / 删除草稿不会让读它的地方（表格那一格、SKU 弹窗的需安排）失效。
  void plannedDrafts[row.id]
  if (hasPlannedDraft(row.id)) return plannedDrafts[row.id]
  // 0 与缺省都当作「还没填」：否则下单清零留下的一个 0 会把占位建议值挡住，看不出还差多少。
  return Number(row.planned) > 0 ? row.planned : null
}

// 需安排建议值：补到绿色带中位（正常库存）的差额，基于理论库存（占位提示与勾选预填同一口径）。
// 这里只给精准到个位的公斤数，缸数换算留到采购下单页（下单时才建议缸数）。
function getPlannedPlaceholder(row) {
  // 订单货没有建议值：这一格就是客户电话报的量，提示人工填写。
  if (row.manualBehavior === 'order') return '按订单填写'
  if (!row.strategyAvailable) return ''
  // 有订单在履约也照常给建议值（建议值本身已扣掉累计下单的量），缺口没补够就还能继续下。
  return `${formatQuantity(getSuggestedPlanned(row))}`
}

function getPlannedPlaceholderTitle(row) {
  if (row.manualBehavior === 'order') {
    return '订单货：客户报多少单就在这里填多少公斤，采纳后写入需安排（不跳转，去「采购下单」拆单；不参与预警与评分，不给建议值）'
  }
  if (!row.strategyAvailable) {
    return `备货模式缺省，无法计算建议需安排量：${row.strategyIssue || '系数不可用'}`
  }

  const suggestion = getSuggestedPlanned(row)
  if (suggestion > 0) {
    return `建议填写 ${formatQuantity(suggestion)}，采纳后预计库存达到正常库存（绿色带中位）；要去拆单时点顶部「采购下单」，下单页会再按缸规则建议整缸数量`
  }
  return `预计库存（已含累计下单 ${formatQuantity(row.ordered)} 公斤）不低于正常库存下限，无需再补；要加量可直接填写`
}

function updatePlannedDraft(id, value) {
  if (hasPlannedUndo(id)) return

  const quantity = draftQuantityFrom(value)
  // 草稿统一存 Number | null（ElInputNumber 只认这两种）：空 / 0 存 null，
  // 但键还留着 —— 显示以草稿为准，底层旧 planned 不会冒回输入框。
  plannedDrafts[id] = quantity > 0 ? quantity : null
  // 联动：填了正数自动勾选，清空 / 0 自动取消勾选，多选里始终只留有数量的行。
  if (quantity > 0) addSkuToSelection(id)
  else removeSkuFromSelection(id)
}

// 「采纳」：把草稿（或建议值）落成锁定的需安排。
// 采纳后不跳转，留在主面板继续处理下一行（要去拆单时自己点顶部「采购下单」）。
function acceptPlannedDraft(row) {
  const planned = plannedToAdopt(row)
  if (!(planned > 0)) {
    ElMessage.warning(
      row.manualBehavior === 'order'
        ? '订单货请先在「需安排」填写客户报的量，再采纳'
        : '该 SKU 没有可采纳的补货量：请先在「需安排」填写数量',
    )
    return
  }

  const written = writePlanned([{ id: row.id, planned }])
  if (written.length === 0) return
  // 锁定后不能再参与多选：还勾着就顺手摘掉，避免底部「确认补货」再带它一次。
  removeSkuFromSelection(row.id)
  ElMessage.success(`已采纳 ${formatQuantity(planned)} 公斤，已写入需安排（去「采购下单」拆单）`)
}

// 有可写入的数量（草稿 / 建议值）或已采纳（按钮变「撤销」）时可点。
function canAdoptPlanned(row) {
  return hasPlannedUndo(row.id) || plannedToAdopt(row) > 0
}

function handlePlannedAction(row) {
  // 已采纳过（且没有新草稿）时，这个按钮就是撤销。
  if (!hasPlannedDraft(row.id) && hasPlannedUndo(row.id)) {
    undoPlannedAcceptance(row)
    return
  }
  acceptPlannedDraft(row)
}

// 需安排输入框里按回车 = 点「采纳」（与行内按钮同一条路径）。
// 只认输入框本身：按钮上的回车会自己合成 click，不拦就会触发两次；
// 按钮置灰的行（没填也没建议值）回车同样不动作。
function handlePlannedEnter(row, event) {
  if (event?.target?.tagName !== 'INPUT') return
  if (!canAdoptPlanned(row)) return
  handlePlannedAction(row)
}

// 批量提交后要落到「下单列表的第一条」：主面板按品名月均销量重排过，
// 下单列表却按库存行顺序排，两边顺序不同 —— 直接拿主面板的第一条会落到下单列表的末尾或中间，
// 所以按库存行顺序在这些刚写入的 SKU 里挑最靠上的一条。
function firstWrittenInListOrder(written) {
  const order = new Map()
  inventoryItems.forEach((item, index) => order.set(item.id, index))
  return written.reduce((best, item) =>
    (order.get(item.id) ?? 0) < (order.get(best.id) ?? 0) ? item : best,
  )
}

// 采购下单页按「需安排 > 0」列出 SKU；带上 sku 参数让右侧明细直接落到刚点的那一条。
function goToPurchase(skuId = '') {
  void router.push({
    name: MAIN_PANEL.purchaseRouteName,
    query: skuId ? { sku: skuId } : undefined,
  })
}

function undoPlannedAcceptance(row) {
  const undo = plannedUndoHistory[row.id]
  if (!undo) return

  const item = itemById.value.get(row.id)
  if (!item) return

  item.planned = undo.previousPlanned
  // 采纳时下单页可能已经按缸规则自动带过一张建议分单：撤销要连它一起清掉，
  // 否则这个 SKU 下次采纳时会带着上次的草稿回到下单页。
  if (purchaseStore.orderEntries(item.skuId).length > 0) {
    purchaseStore.clearOrderEntries(item.skuId)
  }
  delete plannedDrafts[row.id]
  delete plannedUndoHistory[row.id]
  refreshLeafRow(row.id)
  schedulePlanPersist(inventoryStore)
}

// —— 批量补货 ——
// 勾选只认 SKU 标识：父行（品名）按子行全选 / 半选推导，不单独存状态。
// 三条联动规则：
//   1. 勾选 → 没数字的行自动带入建议值（autoFilledDrafts 记着，取消勾选撤回未改过的）；
//   2. 需安排填 / 清数字 → 自动勾选 / 取消勾选（见 updatePlannedDraft）；
//   3. 已采纳锁定的行不可勾选，确认下单清零需安排后自动解锁。
function isSkuSelected(id) {
  return selectedSkuIds.value.has(id)
}

function isPlannedLocked(row) {
  return Boolean(row) && !row.isProductGroup && hasPlannedUndo(row.id)
}

// 只闪回执，不改状态：先摘掉再挂上，连点同一行也能重播动画。
function flashLockedHint(id) {
  lockedHintRowId.value = null
  nextTick(() => {
    lockedHintRowId.value = id
  })
  if (lockedHintTimer) clearTimeout(lockedHintTimer)
  lockedHintTimer = window.setTimeout(() => {
    lockedHintTimer = 0
    lockedHintRowId.value = null
  }, 1200)
}

// 锁定行上不给操作的地方（整行、选择格、需安排格）统一走这里：只有锁定的行才闪。
function flashHintIfLocked(row) {
  if (isPlannedLocked(row)) flashLockedHint(row.id)
}

function selectableGroupChildren(row) {
  return (row.children ?? []).filter((child) => !isPlannedLocked(child))
}

function calculatedRowById(id) {
  const index = leafRowIndexById.get(id)
  return index === undefined ? null : inventoryLeafRows.value[index]
}

// 取消勾选时撤回「勾选自动代入」的草稿，只撤没被改过的数字。
function revertAutoFilledDrafts(ids) {
  for (const id of ids) {
    const filled = autoFilledDrafts.get(id)
    if (filled === undefined) continue
    autoFilledDrafts.delete(id)
    if (!hasPlannedDraft(id) || draftQuantity(id) !== filled) continue
    delete plannedDrafts[id]
  }
}

// 新勾选的行：还没有数字、也没采纳过的，把建议值填进输入框（只是草稿，不替代「采纳」）。
function prefillSelectionDrafts(ids) {
  for (const id of ids) {
    if (draftQuantity(id) > 0) continue
    const row = calculatedRowById(id)
    // 订单货没有建议值；缺系数 / 不参与备货的行也补不出数。
    if (!row || row.manualBehavior === 'order' || !row.strategyAvailable) continue
    // 已经有需安排的行不动：预填只服务还没填的 SKU。
    if (Number(row.planned) > 0) continue
    const suggestion = getSuggestedPlanned(row)
    if (!(suggestion > 0)) continue
    plannedDrafts[id] = suggestion
    autoFilledDrafts.set(id, suggestion)
  }
}

// 所有勾选变更都走这里：锁定行不进选择，新增行补建议值，取消行撤回自动填入。
function applySkuSelection(next) {
  const previous = selectedSkuIds.value
  const accepted = new Set()
  for (const id of next) {
    if (hasPlannedUndo(id)) continue
    accepted.add(id)
  }
  const added = [...accepted].filter((id) => !previous.has(id))
  const removed = [...previous].filter((id) => !accepted.has(id))
  selectedSkuIds.value = accepted
  revertAutoFilledDrafts(removed)
  prefillSelectionDrafts(added)
}

function updateSelectionIds(mutate) {
  const next = new Set(selectedSkuIds.value)
  mutate(next)
  applySkuSelection(next)
}

function addSkuToSelection(id) {
  if (selectedSkuIds.value.has(id)) return
  updateSelectionIds((next) => next.add(id))
}

function removeSkuFromSelection(id) {
  if (!selectedSkuIds.value.has(id)) return
  updateSelectionIds((next) => next.delete(id))
}

function toggleSkuSelection(id, checked) {
  if (checked) addSkuToSelection(id)
  else removeSkuFromSelection(id)
}

function isGroupFullySelected(row) {
  // 锁定 SKU 不可选；父行全选态只按可选子行计算，避免它们让父行永远停在半选。
  const children = selectableGroupChildren(row)
  return children.length > 0 && children.every((child) => selectedSkuIds.value.has(child.id))
}

function isGroupPartiallySelected(row) {
  const children = selectableGroupChildren(row)
  let selected = 0
  for (const child of children) {
    if (selectedSkuIds.value.has(child.id)) selected += 1
  }
  return selected > 0 && selected < children.length
}

function toggleGroupSelection(row, checked) {
  const children = selectableGroupChildren(row)
  if (children.length === 0) return

  updateSelectionIds((next) => {
    for (const child of children) {
      if (checked) next.add(child.id)
      else next.delete(child.id)
    }
  })
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
  updateSelectionIds((next) => {
    for (const row of filteredInventoryLeafRows.value) {
      if (checked) next.add(row.id)
      else next.delete(row.id)
    }
  })
}

function clearSkuSelection() {
  applySkuSelection(new Set())
}

// 屏蔽（删除）后清掉已不在表里的勾选，避免批量条统计到看不见的 SKU。
function pruneHiddenSelection() {
  if (selectedSkuIds.value.size === 0) return
  const next = new Set()
  for (const id of selectedSkuIds.value) {
    const item = itemById.value.get(id)
    if (item && !isItemHidden(item)) next.add(id)
  }
  if (next.size !== selectedSkuIds.value.size) applySkuSelection(next)
}

// —— 屏蔽（看似删除）——
// 勾选后从右下角统一屏蔽：某品名当前可见的 SKU 全部被选中时记为品名级屏蔽（以后新增的 SKU 也隐藏），
// 否则逐条记 SKU 级屏蔽。源表数据不动，可在「屏蔽列表」解除。
async function hideSelectedSkus() {
  if (selectedSkuIds.value.size === 0) return

  // 「整组选中」按主面板当前可见行判断：父行全选 / 逐个勾满可见 SKU 都算整组，
  // 已单独屏蔽的 SKU 本来就不在表里，品名级屏蔽会把它们一并收编（恢复时整组回来）。
  const visibleByProduct = new Map()
  for (const row of inventoryLeafRows.value) {
    visibleByProduct.set(row.product, (visibleByProduct.get(row.product) ?? 0) + 1)
  }
  const allByProduct = new Map()
  for (const item of inventoryItems) {
    allByProduct.set(item.product, (allByProduct.get(item.product) ?? 0) + 1)
  }
  const selectedByProduct = new Map()
  const selectedItems = []
  for (const item of inventoryItems) {
    if (!selectedSkuIds.value.has(item.id)) continue
    selectedItems.push(item)
    selectedByProduct.set(item.product, (selectedByProduct.get(item.product) ?? 0) + 1)
  }

  const wholeProducts = [...selectedByProduct.keys()].filter(
    (product) => selectedByProduct.get(product) === visibleByProduct.get(product),
  )
  const wholeProductSet = new Set(wholeProducts)
  const skuEntries = selectedItems
    .filter((item) => !wholeProductSet.has(item.product))
    .map((item) => ({ skuId: item.skuId, product: item.product, color: item.color }))
  const wholeSkuCount = wholeProducts.reduce(
    (total, product) => total + (allByProduct.get(product) ?? 0),
    0,
  )

  const parts = []
  if (wholeProducts.length) {
    parts.push(`${wholeProducts.length} 个品名（共 ${wholeSkuCount} 个 SKU）整组屏蔽`)
  }
  if (skuEntries.length) parts.push(`${skuEntries.length} 个 SKU`)
  try {
    await ElMessageBox.confirm(
      `将从主面板屏蔽：${parts.join('，')}。源表数据不动，可在「屏蔽列表」解除。`,
      '屏蔽选中',
      { type: 'warning', confirmButtonText: '屏蔽', cancelButtonText: '取消' },
    )
  } catch (error) {
    return
  }

  await stockingStore.hideEntries({ products: wholeProducts, skus: skuEntries })
  ElMessage.success(
    `已屏蔽：${[
      wholeProducts.length ? `${wholeProducts.length} 个品名` : '',
      skuEntries.length ? `${skuEntries.length} 个 SKU` : '',
    ]
      .filter(Boolean)
      .join('、')}`,
  )
  clearSkuSelection()
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
    if (next.size !== selectedSkuIds.value.size) applySkuSelection(next)
  },
)

// 底部「确认补货」：只把勾选行「需安排」里填着的数字落成需安排，然后直接进采购下单面板。
// 勾选会自动带出建议值，所以这里不再回头取建议值兜底；没有数字的行跳过。
function confirmRestock() {
  const selected = inventoryLeafRows.value.filter((row) => selectedSkuIds.value.has(row.id))
  if (selected.length === 0) return

  const plans = selected
    .map((row) => ({ id: row.id, planned: draftQuantity(row.id) }))
    .filter((plan) => plan.planned > 0)

  const written = writePlanned(plans)
  if (written.length === 0) {
    ElMessage.warning('选中的 SKU 在「需安排」里都没有数字：先填数量（勾选会自动带出建议值）')
    return
  }

  const skipped = selected.length - written.length
  clearSkuSelection()
  ElMessage.success(
    `已写入需安排：${written.length} 个 SKU${skipped > 0 ? `，${skipped} 个没有数量已跳过` : ''}`,
  )
  goToPurchase(firstWrittenInListOrder(written).skuId)
}

function getRowClassName({ row }) {
  return [
    row.isProductGroup ? 'product-group-row' : 'product-color-row',
    expandingProductKeys.value.has(`product:${row.product}`)
      ? 'product-group-expanding'
      : '',
    !row.isProductGroup && row.id === selectedRowId.value ? 'inventory-row-selected' : '',
    !row.isProductGroup && row.id === highlightedRowId.value ? 'inventory-row-highlight' : '',
    // 已采纳锁定：整行不响应勾选，悬停显示锁图标。
    isPlannedLocked(row) ? 'inventory-vtable__row--locked' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

// SKU 行点击切换自身选择；SPU 汇总行点击只展开 / 收起，整组选择仅由复选框触发。
// 已采纳锁定的行整行都不响应（悬停显示锁图标），避免误加进批量补货。
function handleRowClick(row) {
  if (row.isProductGroup) {
    toggleProductGroup(row)
    return
  }

  if (isPlannedLocked(row)) {
    flashLockedHint(row.id)
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

  if (isPlannedLocked(row)) {
    flashLockedHint(row.id)
    return
  }

  toggleSkuSelection(row.id, !isSkuSelected(row.id))
  selectedRowId.value = row.id
}

// 导入成功后清空需安排草稿并重建表格；总表与销售表的写入已在 useSourceImport 内完成。
async function handleSourcesImported(summary, diff) {
  for (const key of Object.keys(plannedDrafts)) delete plannedDrafts[key]
  plannedPreviews.clear()
  autoFilledDrafts.clear()

  rebuildLeafRows()
  selectedRowId.value = null
  // 换了数据就从头看：旧的滚动位置在新表里没有意义。
  tableScrollTop.value = 0
  if (tableScrollRef.value) tableScrollRef.value.scrollTop = 0

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

  // 导入完直接把「这次变了什么」摆出来：主面板是全量数据，不看这份看不出变化。
  if (diff) {
    await refreshImportDiffs()
    importDiffDialogVisible.value = true
  }
}

</script>

<template>
  <main class="inventory-page">
    <div v-if="importToast.visible" class="import-toast">
      <span class="import-toast__icon" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path d="M6.5 11.5 3 8l1.06-1.06 2.44 2.44 5.44-5.44L13 5l-6.5 6.5Z" fill="currentColor" />
        </svg>
      </span>
      <span class="import-toast__message" role="status" aria-live="polite">
        {{ importToast.message }}
      </span>
      <button
        v-if="importToast.actionLabel"
        type="button"
        class="import-toast__action"
        @click="runImportToastAction"
      >
        {{ importToast.actionLabel }}
      </button>
      <div class="import-toast__progress">
        <div class="import-toast__progress-bar" :style="{ width: `${importToast.progress}%` }"></div>
      </div>
    </div>
    <div class="page-sticky-header">
      <PanelNavigation />
      <div class="page-head">
        <h1 class="page-title">需求表</h1>
        <ElButton
          class="import-split-button"
          size="small"
          title="选择 5 张分表，先清洗出总表与销售表再导入"
          @click="triggerSplitImport"
        >
          导入分表
        </ElButton>
        <ElButton
          class="import-diff-button"
          size="small"
          :disabled="importDiffs.length === 0"
          :title="
            importDiffs.length === 0
              ? '导入一次分表后，这里能看到每个 SKU 的库存 / 销量 / 排单 / 入库变化'
              : `看最近一次导入的 SKU 数据变动（共保留 ${importDiffs.length} 份）`
          "
          @click="openImportDiffDialog"
        >
          数据变动
        </ElButton>
        <div class="page-head__actions">
          <ElButton
            class="add-sku-button"
            size="small"
            title="手动添加一个 SKU，字段与导入的总表 / 销售表一致"
            @click="addSkuDialogVisible = true"
          >
            添加SKU
          </ElButton>
          <ElButton
            class="urgent-plan-button"
            size="small"
            :disabled="urgentRows.length === 0"
            :title="`全量 ${urgentRows.length} 个紧急 SKU（不受筛选影响，已按小额补货门槛排除；当前筛选内 ${warningCounts.red} 个）`"
            @click="openUrgentPlanDialog"
          >
            紧急补货 <span class="urgent-count">{{ urgentRows.length }}</span>
          </ElButton>
        </div>
      </div>
      <div class="inventory-filters" aria-label="库存筛选">
        <div class="filter-row">
          <div class="filter-group" role="group" aria-label="关键词筛选">
            <span class="filter-group__label">查找</span>
            <ElInput
              v-model="productFilter"
              class="text-filter"
              placeholder="品名"
              aria-label="按品名筛选"
              clearable
            />
            <ElInput
              v-model="colorFilter"
              class="text-filter"
              placeholder="颜色"
              aria-label="按颜色筛选"
              clearable
            />
          </div>
          <div class="filter-group" role="group" aria-label="模式筛选">
            <span class="filter-group__label">模式</span>
            <ElSelect
              v-model="selectedSpuGradeKeys"
              class="text-filter mode-filter"
              :class="{ 'is-filtering': selectedSpuGradeKeys.length > 0 }"
              multiple
              clearable
              placeholder="按SPU模式筛选"
              aria-label="按SPU模式筛选"
              :title="spuFilterTitle"
            >
              <ElOption
                v-for="option in spuGradeFilterOptions"
                :key="option.key"
                :label="option.label"
                :value="option.key"
              />
              <template #tag>
                <span v-if="selectedSpuGradeKeys.length" class="mode-filter__value">
                  <span class="mode-filter__summary">{{ spuFilterSummary }}</span>
                  <span class="mode-filter__count">{{ selectedSpuGradeKeys.length }}</span>
                </span>
              </template>
            </ElSelect>
            <ElSelect
              v-model="selectedModeLabels"
              class="text-filter mode-filter"
              :class="{ 'is-filtering': selectedModeLabels.length > 0 }"
              multiple
              clearable
              placeholder="按SKU模式筛选"
              aria-label="按SKU模式筛选"
              :title="modeFilterTitle"
            >
              <ElOption v-for="name in modeOptions" :key="name" :label="name" :value="name" />
              <template #tag>
                <span v-if="selectedModeLabels.length" class="mode-filter__value">
                  <span class="mode-filter__summary">{{ modeFilterSummary }}</span>
                  <span class="mode-filter__count">{{ selectedModeLabels.length }}</span>
                </span>
              </template>
            </ElSelect>
          </div>
          <div class="filter-row__end">
            <span class="meta inventory-filters__count">{{ filteredSkuCount }} 个 SKU</span>
            <button
              v-if="hasActiveFilters"
              type="button"
              class="filter-clear"
              title="清空关键词、SPU / SKU 模式与采购状态 / 预警筛选"
              @click="clearAllFilters"
            >
              清除筛选
            </button>
            <ElButton class="toggle-groups-button" size="small" @click="toggleAllProductGroups">
              {{ inventoryRows.length > 0 && inventoryRows.every((row) => expandedProductKeys.includes(row.id)) ? '全部收起' : '全部展开' }}
            </ElButton>
          </div>
        </div>
        <div class="filter-row filter-row--state">
          <div class="filter-group" role="group" aria-label="采购状态筛选">
            <span class="filter-group__label">采购</span>
            <button
              type="button"
              class="warning-filter warning-filter--all"
              :class="{ 'warning-filter--active': isAllFilterSelected }"
              :aria-pressed="isAllFilterSelected"
              :title="warningFilterTitle('all')"
              @click="toggleWarningFilter('all')"
            >
              全部
              <span class="warning-filter-count">{{ warningCounts.all }}</span>
            </button>
            <button
              type="button"
              class="warning-filter warning-filter--ordering"
              :class="{ 'warning-filter--active': onlyOrdering }"
              :aria-pressed="onlyOrdering"
              :title="`只看下单中（已锁定、等待确认下单）的 SKU，当前筛选内共 ${orderingCount} 个`"
              @click="toggleOrderingFilter"
            >
              下单中
              <span class="warning-filter-count">{{ orderingCount }}</span>
            </button>
            <button
              type="button"
              class="warning-filter warning-filter--order"
              :class="{ 'warning-filter--active': onlyOrdered }"
              :aria-pressed="onlyOrdered"
              :title="`只看已下单、还没到仓（在途 > 0）的 SKU，当前筛选内共 ${orderedCount} 个`"
              @click="toggleOrderFilter"
            >
              已下单
              <span class="warning-filter-count">{{ orderedCount }}</span>
            </button>
            <button
              type="button"
              class="warning-filter warning-filter--arrived"
              :class="{ 'warning-filter--active': onlyArrived }"
              :aria-pressed="onlyArrived"
              :title="`只看下过单、货已全部到仓（在途 = 0）的 SKU，当前筛选内共 ${arrivedCount} 个`"
              @click="toggleArrivedFilter"
            >
              已到仓
              <span class="warning-filter-count">{{ arrivedCount }}</span>
            </button>
          </div>
          <div class="filter-group" role="group" aria-label="预警状态筛选">
            <span
              class="filter-group__label"
              :class="{ 'filter-group__label--scoped': hasScopeFilters }"
              :title="
                hasScopeFilters
                  ? '下面的预警计数已按「查找」与「模式」的筛选收窄，不是全量'
                  : ''
              "
              >预警{{ hasScopeFilters ? ' · 筛选后' : '' }}</span
            >
            <button
              v-for="filter in warningToneFilters"
              :key="filter.key"
              type="button"
              class="warning-filter"
              :class="[
                `warning-filter--${filter.key}`,
                { 'warning-filter--active': selectedWarningTones.includes(filter.key) },
              ]"
              :aria-pressed="selectedWarningTones.includes(filter.key)"
              :title="warningFilterTitle(filter.key)"
              @click="toggleWarningFilter(filter.key)"
            >
              <span
                class="warning-filter-indicator"
                :class="`urgency-indicator--${filter.key}`"
                aria-hidden="true"
              />
              {{ filter.label }}
              <span class="warning-filter-count">{{ warningCounts[filter.key] }}</span>
            </button>
          </div>
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
      <div class="inventory-vtable__canvas" :style="{ width: `max(100%, ${tableTotalWidth}px)` }">
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
              v-for="column in visibleTableColumns"
              :key="column.key"
              class="inventory-vtable__head-cell"
              :class="{
                'inventory-vtable__head-cell--deep-right':
                  column.key === 'inTransitStock' || column.key === 'warehouseStock',
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
              <TableHeaderHint
                v-else
                :label="column.label"
                :hint="columnHints[column.key] ?? null"
              />
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
              <div
                class="inventory-vtable__cell inventory-vtable__cell--select"
                @click.stop="flashHintIfLocked(row)"
              >
                <span
                  v-if="!row.isProductGroup && isPlannedLocked(row)"
                  class="row-lock-hint"
                  title="已采纳锁定：订单提交前不可多选（提交订单后自动解锁）"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M4.5 6V4.75a3.5 3.5 0 0 1 7 0V6m-8 0h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm4.5 3v2"
                      fill="none"
                      stroke="currentColor"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="1.5"
                    />
                  </svg>
                </span>
                <ElCheckbox
                  v-else-if="row.isProductGroup"
                  :model-value="isGroupFullySelected(row)"
                  :indeterminate="isGroupPartiallySelected(row)"
                  :disabled="selectableGroupChildren(row).length === 0"
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
              <div class="inventory-vtable__cell inventory-vtable__cell--score">
                <span
                  v-if="!row.isProductGroup"
                  class="score-badge"
                  :class="`score-badge--${scoreCellTone(row)}`"
                  :title="scoreCellTitle(row)"
                  :aria-label="scoreCellTitle(row)"
                >
                  {{ scoreCellText(row) }}
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
              <div class="inventory-vtable__cell inventory-vtable__cell--color"              >
                <template v-if="!row.isProductGroup">
                  <span class="color-name-text" :title="displayColor(row.color)">
                    {{ displayColor(row.color) }}
                  </span>
                  <SkuDetailTrigger :item="row" @open="openSkuDetail" />
                </template>
              </div>
              <div
                class="inventory-vtable__cell"
                :class="`urgency-cell urgency-cell--${getPlannedTone(row)}`"
              >
                <span
                  v-if="!row.isProductGroup"
                  class="urgency-indicator"
                  :class="[`urgency-indicator--${getPlannedTone(row)}`, lampRingClass(row)]"
                  :title="urgencyTitle(row)"
                  :aria-label="`紧急状态：${urgencyTitle(row)}`"
                />
              </div>
              <div
                class="inventory-vtable__cell"
                :class="[
                  `planned-cell planned-cell--${getPlannedTone(row)}`,
                  { 'planned-cell--order': row.manualBehavior === 'order' },
                ]"
              >
                <template v-if="row.isProductGroup">
                  <span
                    v-if="previewOf(row)"
                    :key="formatQuantity(previewOf(row).planned)"
                    class="preview-number"
                  >
                    {{ formatQuantity(previewOf(row).planned) }}
                  </span>
                  <template v-else>{{ formatQuantity(row.planned) }}</template>
                </template>
                <div v-else class="planned-entry">
                  <div
                    class="planned-input-shell"
                    :class="{
                      'planned-input-shell--locked': hasPlannedUndo(row.id),
                      'planned-input-shell--hint': lockedHintRowId === row.id,
                    }"
                    @click.stop="flashHintIfLocked(row)"
                    @keydown.enter.prevent="handlePlannedEnter(row, $event)"
                  >
                    <ElInputNumber
                      v-quantity-digits
                      :model-value="getPlannedDraft(row)"
                      :placeholder="getPlannedPlaceholder(row)"
                      :title="
                        hasPlannedUndo(row.id)
                          ? '已采纳，点击撤销后可修改'
                          : getPlannedPlaceholderTitle(row)
                      "
                      :min="0"
                      :max="QUANTITY_MAX"
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
                    :class="{ 'planned-accept-button--hint': lockedHintRowId === row.id }"
                    size="small"
                    :disabled="!canAdoptPlanned(row)"
                    :title="
                      !hasPlannedDraft(row.id) && hasPlannedUndo(row.id)
                        ? '撤销这次采纳：需安排恢复原值'
                        : '采纳需安排（没填数量就按建议值），不跳转'
                    "
                    :aria-label="`${row.product} ${row.color} ${
                      hasPlannedDraft(row.id) || !hasPlannedUndo(row.id)
                        ? '采纳需安排'
                        : '撤销需安排'
                    }`"
                    @click.stop="handlePlannedAction(row)"
                  >
                    {{ hasPlannedDraft(row.id) || !hasPlannedUndo(row.id) ? '采纳' : '撤销' }}
                  </ElButton>
                </div>
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--deep-right">
                {{ producingText(row) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ arrangedText(row) }}
              </div>
              <div
                class="inventory-vtable__cell inventory-vtable__cell--ordered"
                :title="orderCellTitle(row)"
              >
                <span class="ordered-value">
                  {{ row.isProductGroup && !row.ordered ? '—' : formatQuantity(row.ordered) }}
                </span>
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
              <div
                class="inventory-vtable__cell inventory-vtable__cell--in-transit-ordered"
                :title="orderCellTitle(row)"
              >
                <span class="in-transit-ordered-value">
                  {{ inTransitText(row) }}
                </span>
                <button
                  v-if="!row.isProductGroup && row.ordered > 0"
                  type="button"
                  class="ordered-detail-button"
                  :class="{ 'ordered-detail-button--settled': !hasOrderInTransit(row) }"
                  :aria-label="`查看 ${row.product} ${row.color} 的采购订单（下过单）`"
                  title="查看采购订单详情"
                  @click.stop="openOrderDialog(row)"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="13"
                    height="13"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4 1.9h4.9L12.1 5.1V13a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.5A.6.6 0 0 1 4 1.9Z" />
                    <path d="M8.7 2.1v3.1h3.2M5.7 8h4.4M5.7 10.4h3.2" />
                  </svg>
                </button>
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--deep-right">
                {{ formatQuantity(row.warehouseKg) }}
              </div>
              <div class="inventory-vtable__cell">
                {{ formatQuantity(row.theoreticalStock) }}
              </div>
              <!-- 需安排的两个提示层：键入时按草稿预览，采纳后继续标出这单计划带来的变化 -->
              <div
                v-for="column in PREVIEW_COLUMNS"
                :key="column.key"
                class="inventory-vtable__cell"
                :class="previewCellClass(row, column)"
                :title="isPreviewCell(row, column) ? previewTitle(row, column) : ''"
              >
                <template v-if="isPreviewCell(row, column)">
                  <span :key="previewText(row, column)" class="preview-number">
                    {{ previewText(row, column) }}
                  </span>
                  <span
                    v-if="previewDelta(row, column)"
                    class="preview-delta"
                    :class="`preview-delta--${previewDelta(row, column).direction}`"
                  >
                    {{ previewDelta(row, column).text }}
                  </span>
                </template>
                <template v-else>{{ column.format(row) }}</template>
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
      <ElButton class="batch-restock-clear" @click="clearSkuSelection">清空</ElButton>
      <ElButton
        class="batch-restock-confirm"
        title="按需安排写入补货量（已填的数量优先，空着用建议值），然后直接进入采购下单"
        @click="confirmRestock"
      >
        确认补货
      </ElButton>
    </div>

    <!-- 屏蔽：固定视窗右下角，只在有勾选时出现，品名父行勾选会整组屏蔽品名。 -->
    <div v-if="selectedSkuIds.size > 0" class="inventory-hide-fab">
      <ElButton
        class="inventory-hide-fab__button"
        title="屏蔽选中的 SKU / 品名，可在「屏蔽列表」解除"
        aria-label="屏蔽选中的 SKU"
        @click="hideSelectedSkus"
      >
        <span class="inventory-hide-fab__label">
          <svg class="inventory-hide-fab__icon" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M4.5 6h11m-9 0V4.5h7V6m-8 0 .8 9.5h8.4L15.5 6M8.5 9v4m3-4v4"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.6"
            />
          </svg>
          <span>屏蔽选中</span>
          <span class="inventory-hide-fab__count">
            {{ selectedSkuIds.size }}
          </span>
        </span>
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
        填写新增计划数量，提交后将累加到主表“需安排”。推荐计划数按补至绿色带中位（正常库存）的数量计算。<template
          v-if="excludedUrgentCount > 0"
        >
          已按小额补货门槛排除需安排低于 {{ lowPlannedThreshold }} 公斤的 {{ excludedUrgentCount }} 个紧急 SKU（可在设置 → 备货配置 → 筛选显示规则里调整）。</template>
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
                  v-quantity-digits
                  :min="0"
                  :max="QUANTITY_MAX"
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

    <PurchaseOrderRecordsDialog
      v-model="orderDialogVisible"
      :item="orderDialogRow"
      @cancelled="handleOrderCancelled"
    />

    <ImportDiffDialog v-model="importDiffDialogVisible" :entries="importDiffs" />

    <AddSkuDialog
      v-model:visible="addSkuDialogVisible"
      @created="handleSkuAdded"
    />

    <SkuDetailDialog
      v-model:visible="skuDetailVisible"
      :item="skuDetailItem"
      planned-editable
      :planned-locked="Boolean(skuDetailItem && hasPlannedUndo(skuDetailItem.id))"
      :planned-draft="dialogPlannedDraft"
      @update:planned-draft="handleDialogPlannedDraft"
      @adopt-planned="handleDialogAdoptPlanned"
      @undo-planned="handleDialogUndoPlanned"
    />
  </main>
</template>

<style scoped>
.inventory-page {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 8px 14px 12px;
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
  max-width: 560px;
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

/* toast 里的动作按钮：与提示同色系、无填充，避免抢走「成功」本身的视觉重量。 */
.import-toast__action {
  flex: 0 0 auto;
  padding: 2px 8px;
  color: #4e9b34;
  font-size: 13px;
  line-height: 1.5;
  background: transparent;
  border: 1px solid #b7dfa4;
  border-radius: 4px;
  cursor: pointer;
  transition:
    color 120ms ease,
    background 120ms ease,
    border-color 120ms ease;
}

.import-toast__action:hover {
  color: #fff;
  background: #67c23a;
  border-color: #67c23a;
}

.import-toast__action:focus-visible {
  outline: 2px solid #67c23a;
  outline-offset: 1px;
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
  margin: 0;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.page-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 30px;
  margin-bottom: 8px;
}

.page-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
}

.page-head__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.page-head__actions :deep(.el-button) {
  margin-left: 0;
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
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  margin-bottom: 8px;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: var(--industrial-surface);
}

/* 两行布局：第一行「查找 + 模式」（右侧结果数 / 清除 / 展开），第二行「采购状态 + 预警色」。
   分行的目的是把互斥的两组 chip 拆开，别和上面的输入框挤在一行里抢宽度。 */
.filter-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  min-height: 26px;
}

.filter-row--state {
  padding-top: 6px;
  border-top: 1px dashed var(--industrial-grid-light);
}

.filter-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

/* 同一条行内相邻两组之间加一道细竖线，避免「采购全部 / 预警紧急」被连读。 */
.filter-group + .filter-group {
  padding-left: 10px;
  border-left: 1px solid var(--industrial-grid-light);
}

.filter-group__label {
  padding-right: 2px;
  color: var(--industrial-muted);
  font-size: 11px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  user-select: none;
}

/* 资料类筛选生效时，预警组名改成「预警 · 筛选后」，并提亮提示计数已被收窄。 */
.filter-group__label--scoped {
  color: var(--industrial-primary);
  font-weight: 600;
}

.filter-row__end {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.filter-clear {
  height: 24px;
  padding: 0 8px;
  color: var(--industrial-primary);
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.filter-clear:hover,
.filter-clear:focus-visible {
  border-color: var(--industrial-grid);
  background: #e5edf1;
}

.filter-clear:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: 1px;
}

.inventory-filters :deep(.el-input__wrapper),
.inventory-filters :deep(.el-select__wrapper) {
  min-height: 26px;
  padding: 0 8px;
  border-radius: 3px;
  box-shadow: 0 0 0 1px var(--industrial-grid) inset;
}

.inventory-filters :deep(.el-input__wrapper.is-focus),
.inventory-filters :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--industrial-primary) inset;
}

.inventory-filters :deep(.el-input__inner) {
  font-size: 12px;
}

.inventory-filters :deep(.el-select__selected-item) {
  font-size: 12px;
}

.text-filter {
  width: 150px;
}

.mode-filter {
  width: 176px;
}

/* 两个模式多选：不渲染标签胶囊，只显示一行可截断的摘要（避免选两个就被压成「+1」）。
   EP 给内容加了 -8px 左边距，这里抵消掉，让摘要和「品名 / 颜色」输入框的文字对齐。 */
.inventory-filters :deep(.mode-filter .el-select__selection) {
  flex-wrap: nowrap;
  margin-left: 0;
  min-width: 0;
  /* EP 的输入框与占位符都是绝对定位，容器本身没有高度；不补 24px 会被 overflow 裁掉。 */
  min-height: 24px;
  overflow: hidden;
}

.inventory-filters :deep(.mode-filter .el-select__selection.is-near) {
  margin-left: 0;
}

.mode-filter__summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 摘要 + 「已选几个」角标：角标只回答「有几个条件生效」，不是「还有几个没显示」。 */
.mode-filter__value {
  display: inline-flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.mode-filter__count {
  flex: 0 0 auto;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  color: #fff;
  border-radius: 8px;
  background: var(--industrial-primary);
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
}

/* 模式框正在生效：浅底 + 主色描边 + 左侧色条，跟 hover / focus 区分开，
   提示「下面的预警计数已按这些条件收窄」。 */
.inventory-filters :deep(.mode-filter.is-filtering .el-select__wrapper) {
  background: #eaf1f4;
  box-shadow:
    inset 0 0 0 1px var(--industrial-primary),
    inset 2px 0 0 var(--industrial-primary);
}

/* 已筛选 SKU 数放在第一行右侧，和「清除筛选」「全部展开」成组。 */
.inventory-filters__count {
  margin-left: 0;
}

.warning-filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 0 8px;
  color: var(--industrial-muted);
  border: 1px solid var(--industrial-grid);
  border-radius: 2px;
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
  width: 8px;
  height: 8px;
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
  min-width: 0;
  color: var(--industrial-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.warning-filter:hover .warning-filter-count,
.warning-filter--active .warning-filter-count {
  color: inherit;
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
  min-width: 16px;
  margin-left: 2px;
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.16);
  font-size: 11.5px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: center;
}

.import-split-button {
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

/* 「数据变动」是查看入口，不跟导入抢注意力：默认描边按钮，没记录时置灰 */
.import-diff-button {
  --el-button-text-color: var(--industrial-text);
  --el-button-bg-color: var(--industrial-surface);
  --el-button-border-color: var(--industrial-grid);
  --el-button-hover-text-color: var(--industrial-primary);
  --el-button-hover-bg-color: #eaf1f4;
  --el-button-hover-border-color: var(--industrial-primary);
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

/* 内容高于视口时只让正文滚动，标题栏与按钮始终可见 */
:global(.el-dialog.urgent-plan-dialog .el-dialog__body) {
  min-height: 0;
  overflow: auto;
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

/* 批量补货浮动操作条：选中即出现，不占表格布局 */
.batch-restock-bar {
  position: fixed;
  bottom: 18px;
  left: 50%;
  z-index: 2000;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 340px;
  padding: 10px 12px 10px 20px;
  transform: translateX(-50%);
  color: var(--industrial-text);
  border: 1px solid var(--industrial-grid);
  border-radius: 6px;
  background: var(--industrial-surface);
  box-shadow: 0 8px 24px rgba(47, 59, 67, 0.26);
}

/* 计数占满左侧余量，两个按钮靠右成组，避免中间出现一大段空白。 */
.batch-restock-count {
  flex: 1 1 auto;
  font-size: 13.5px;
  white-space: nowrap;
}

.batch-restock-count strong {
  color: var(--industrial-primary);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}

/* 清空：小号描边灰按钮，弱化在「确认补货」之后。 */
.batch-restock-clear {
  --el-button-text-color: var(--industrial-muted);
  --el-button-bg-color: #fff;
  --el-button-border-color: #b8c2c9;
  --el-button-hover-text-color: var(--industrial-text);
  --el-button-hover-bg-color: #eef2f4;
  --el-button-hover-border-color: var(--industrial-grid);
  --el-button-active-text-color: var(--industrial-text);
  --el-button-active-bg-color: #e4eaed;
  --el-button-active-border-color: var(--industrial-grid);
  height: 28px;
  padding: 0 10px;
  border-radius: 3px;
  font-size: 12.5px;
}

/* 确认补货：绿色主按钮 */
.batch-restock-confirm {
  --el-button-text-color: #fff;
  --el-button-bg-color: #4e9b34;
  --el-button-border-color: #4e9b34;
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: #43872c;
  --el-button-hover-border-color: #43872c;
  --el-button-active-text-color: #fff;
  --el-button-active-bg-color: #3a7626;
  --el-button-active-border-color: #3a7626;
  height: 36px;
  padding: 0 22px;
  border-radius: 4px;
  font-size: 13.5px;
  font-weight: 600;
}

/* 屏蔽浮动按钮：固定在视窗右下角，有勾选时才出现，比批量补货条更低调。 */
.inventory-hide-fab {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2000;
}

.inventory-hide-fab__button {
  --el-button-text-color: #fff;
  --el-button-bg-color: var(--industrial-danger);
  --el-button-border-color: var(--industrial-danger);
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: var(--industrial-danger-hover);
  --el-button-hover-border-color: var(--industrial-danger-hover);
  --el-button-active-text-color: #fff;
  --el-button-active-bg-color: var(--industrial-danger-active);
  --el-button-active-border-color: var(--industrial-danger-active);
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  box-shadow: 0 3px 10px rgba(34, 57, 69, 0.16);
}

.inventory-hide-fab__label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.inventory-hide-fab__icon {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.inventory-hide-fab__count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
  font-size: 11px;
  font-weight: 700;
  line-height: 16px;
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
  /* 右下角「屏蔽选中」按钮会压住最后几行，先补 56px 余量。 */
  padding-bottom: 56px;
}

/* 底部批量补货条更高，两者同时存在时以这里的 84px 为准。 */
.inventory-vtable--batch-bar {
  padding-bottom: 84px;
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

/* 在途库存：数量保持居中，订单详情入口贴右侧，常态低调 */
.inventory-vtable__cell--in-transit-ordered {
  justify-content: space-between;
  gap: 2px;
  padding: 0 3px;
}

.in-transit-ordered-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: clip;
}

.ordered-detail-button {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  border-radius: 2px;
  background: none;
  color: var(--industrial-primary);
  opacity: 0.5;
  cursor: pointer;
  transition: opacity 120ms ease, background-color 120ms ease;
}

.ordered-detail-button:hover,
.ordered-detail-button:focus-visible {
  background: #e5edf1;
  opacity: 1;
}

/* 整行悬停时把入口提亮一档：图标本身低调，但鼠标在这行上就能看见它 */
.inventory-vtable__row--body:hover .ordered-detail-button {
  opacity: 0.9;
}

/* 在途已归零（货已全部到仓）：图标转灰，只作为「这个品下过单」的痕迹留着 */
.ordered-detail-button--settled {
  color: #7b8d97;
  opacity: 0.4;
}

.ordered-detail-button--settled:hover,
.ordered-detail-button--settled:focus-visible {
  background: #eef2f5;
  color: #3f5661;
  opacity: 1;
}

.ordered-detail-button:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: 1px;
}

.inventory-vtable__head-cell--deep-right {
  border-right: 2px solid var(--industrial-grid);
}

.inventory-vtable__cell--color {
  gap: 4px;
  padding-right: 4px;
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
  position: relative;
  padding: 0;
}

/* 已采纳锁定的行：整行不可点（锁形光标），选择列常驻显示锁图标，直到订单提交解锁。 */
.row-lock-hint {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #496777;
  pointer-events: none;
}

.row-lock-hint svg {
  width: 14px;
  height: 14px;
}

.inventory-vtable__row--body.inventory-vtable__row--locked,
.inventory-vtable__row--body.inventory-vtable__row--locked .inventory-vtable__cell {
  cursor: not-allowed;
}

/* 例外：行内可点的入口（采纳 / 撤销、SKU 弹窗、订单弹窗）保持正常的可点击光标。 */
.inventory-vtable__row--locked :deep(.planned-accept-button),
.inventory-vtable__row--locked :deep(.sku-detail-trigger),
.inventory-vtable__row--locked :deep(.ordered-detail-button) {
  cursor: pointer;
}

/* 点锁定行的回执：需安排输入框淡闪一圈，撤销按钮亮得更明显（连点会重播）。 */
.planned-input-shell--hint::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 4px;
  pointer-events: none;
  animation: locked-hint-soft 1s ease-out;
}

@keyframes locked-hint-soft {
  0% {
    box-shadow: 0 0 0 0 rgba(64, 158, 255, 0);
  }
  30% {
    box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.28);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(64, 158, 255, 0);
  }
}

.inventory-vtable :deep(.planned-accept-button--hint) {
  animation: locked-hint-strong 1.1s ease-out;
}

@keyframes locked-hint-strong {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(230, 145, 56, 0);
  }
  30% {
    box-shadow: 0 0 0 3px rgba(230, 145, 56, 0.55), 0 0 12px rgba(230, 145, 56, 0.65);
  }
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

/* 评分列：与 SKU 弹窗的综合评分同口径（红 / 黄 / 绿三档底色），不参与与按量模式显示灰底。 */
.inventory-vtable__cell--score {
  padding: 0 2px;
}

.score-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 20px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.score-badge--red {
  color: #a64f49;
  background: #faf2f1;
}

.score-badge--yellow {
  color: #8a6a2f;
  background: #faf6ed;
}

.score-badge--green {
  color: #5b7460;
  background: #f3f7f4;
}

.score-badge--unavailable {
  color: var(--industrial-muted);
  background: #f2f5f6;
  font-weight: 400;
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

/* 需安排的两种提示（这 4 列）：
   键入未采纳 = 实心变化量 + 弹入动画；已采纳未下单 = 同一块淡底与变化量，但不再弹入
   （数字已经落定，只是这单还没下，等「采购下单」确认后需安排清零才消失）。 */
.inventory-vtable__cell.preview-cell {
  gap: 3px;
  background-color: rgba(63, 113, 141, 0.12);
  transition: background-color 160ms ease;
}

.preview-number {
  display: inline-block;
  font-weight: 700;
  color: var(--industrial-primary);
  border-bottom: 1px dashed currentColor;
  animation: preview-number-pop 200ms ease-out;
}

.preview-delta {
  padding: 1px 3px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.15;
  color: #fff;
  background-color: var(--industrial-primary);
  animation: preview-number-pop 200ms ease-out;
}

.preview-cell--red {
  background-color: rgba(184, 79, 72, 0.13);
}

.preview-cell--red .preview-number {
  color: #a4443d;
}

.preview-cell--red .preview-delta {
  color: #fff;
  background-color: #b05a53;
}

.preview-cell--yellow {
  background-color: rgba(196, 154, 82, 0.18);
}

.preview-cell--yellow .preview-number {
  color: #8a6a2f;
}

.preview-cell--yellow .preview-delta {
  color: #fff;
  background-color: #b28a45;
}

.preview-cell--green {
  background-color: rgba(130, 154, 133, 0.18);
}

.preview-cell--green .preview-number {
  color: #5b7460;
}

.preview-cell--green .preview-delta {
  color: #fff;
  background-color: #7c9480;
}

.preview-cell--purple {
  background-color: rgba(142, 122, 145, 0.16);
}

.preview-cell--purple .preview-number {
  color: #6b5a86;
}

.preview-cell--purple .preview-delta {
  color: #fff;
  background-color: #8b7790;
}

.preview-cell--neutral .preview-number {
  color: var(--industrial-primary);
}

.preview-cell--neutral {
  background-color: rgba(63, 113, 141, 0.12);
}

.preview-cell--unavailable {
  background-color: rgba(101, 115, 124, 0.08);
}

.preview-cell--unavailable .preview-number {
  color: var(--industrial-muted);
}

.preview-cell--unavailable .preview-delta {
  color: #fff;
  background-color: #8b98a0;
}

/* 已采纳但还没下单：底色与变化量照旧，只去掉弹入动画，避免滚动时反复闪动。 */
.preview-cell--adopted .preview-number,
.preview-cell--adopted .preview-delta {
  animation: none;
}

@keyframes preview-number-pop {
  from {
    opacity: 0.35;
    transform: translateY(2px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
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

/* 新添加的 SKU：滚动定位后短暂高亮，帮用户在长表里找到这一行。 */
.inventory-vtable__row--body.inventory-row-highlight .inventory-vtable__cell {
  animation: inventory-row-highlight 2600ms ease-out both;
}

@keyframes inventory-row-highlight {
  0%,
  55% {
    background-color: rgba(196, 154, 82, 0.3);
  }

  100% {
    background-color: transparent;
  }
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

/* 颜色文本占满剩余宽度，详情按钮（24px）自然贴到单元格右边缘 */
.inventory-vtable :deep(.color-name-text) {
  flex: 1 1 auto;
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

/* 锁定后输入框已不可操作：让点击穿透到外层壳，点这一格也能触发上面那下回执。 */
.planned-input-shell--locked :deep(.el-input__wrapper) {
  pointer-events: none;
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

/* 订单货：这一格就是客户电话报的量，用实线绿框 + 斜体占位提示「由人工填写」。 */
.inventory-vtable :deep(.planned-cell--order .editable-number .el-input__wrapper) {
  background-color: #edf3ee !important;
  box-shadow: 0 0 0 1px #8fa795 inset !important;
}

.inventory-vtable :deep(.planned-cell--order .editable-number .el-input__inner::placeholder) {
  color: #6b8172;
  font-style: italic;
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

/* 预警灯的草稿预览：灯色已经是「补完之后的颜色」，虚线环提醒还没采纳。 */
.inventory-vtable :deep(.urgency-indicator--preview) {
  outline: 1px dashed rgba(47, 59, 67, 0.45);
  outline-offset: 2px;
}

/* 已采纳但还没下单：灯色同样是「补完之后的颜色」，改用实线环与草稿的虚线环区分。 */
.inventory-vtable :deep(.urgency-indicator--projected) {
  outline: 1px solid rgba(47, 59, 67, 0.4);
  outline-offset: 2px;
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
