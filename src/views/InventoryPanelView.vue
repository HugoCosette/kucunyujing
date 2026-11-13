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
import { zipSync } from 'fflate'
// 系数由 store 维护，便于配置页修改后全局生效。
import PanelNavigation from '@/components/PanelNavigation.vue'
import AddSkuDialog from '@/components/AddSkuDialog.vue'
import ImportSourcesDialog from '@/components/ImportSourcesDialog.vue'
import ImportSplitTablesDialog from '@/components/ImportSplitTablesDialog.vue'
import PurchaseOrderRecordsDialog from '@/components/PurchaseOrderRecordsDialog.vue'
import SkuDetailDialog from '@/components/SkuDetailDialog.vue'
import SkuDetailTrigger from '@/components/SkuDetailTrigger.vue'
import SkuOrderDialog from '@/components/SkuOrderDialog.vue'
import VirtualList from '@/components/VirtualList.vue'
import { useSourceImport } from '@/composables/useSourceImport'
import { useSplitImport } from '@/composables/useSplitImport'
import { useInventoryStore } from '@/stores/inventory'
import { useInventoryViewStore } from '@/stores/inventoryView'
import { usePurchaseStore } from '@/stores/purchase'
import { persistFactLayer, schedulePlanPersist } from '@/data/persistence'
import { categoryForSku, findFactoryById, orderSummaryOf, planOrderQuantity, resolveVatRule } from '@/purchase'
import { groupRowsByProduct } from '@/utils/productGroups'
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
  normalizeSpuGrades,
  resolveSpuGrade,
} from '@/stocking'
import { evaluateRowHealth } from '@/utils/skuHealth'
import { IMPORT_TEMPLATE_COLUMNS, IMPORT_TEMPLATE_SAMPLE_ROWS } from '@/utils/inventoryImport'

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
// 「评分」列直接复用 SKU 弹窗的健康度评分口径：5 维加权综合分；按量模式只做 2 项判定，没有综合分。
const bulkHealthScoring = computed(
  () =>
    getAutoModes(stockingStore.config).find((mode) => mode.key === 'bulk')?.healthScoring ?? null,
)
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
const inventoryItems = inventoryStore.inventoryItems
const purchaseList = inventoryStore.purchaseList
const plannedUndoHistory = inventoryStore.plannedUndoHistory
// 采购下单模块：分订单以唯一标识为键，采购清单只负责"哪些 SKU 要下、下多少"。
const purchaseStore = usePurchaseStore()
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

function purchaseRowSkuId(row) {
  return String(row?.skuId ?? itemById.value.get(row?.id)?.skuId ?? '').trim()
}

function purchaseRowCategory(row) {
  const item = itemById.value.get(row?.id)
  return categoryForSku(purchaseStore.settings, purchaseRowSkuId(row), item?.treeCategory)
}

function purchaseRowOrders(row) {
  return purchaseStore.orderSummary(purchaseRowSkuId(row))
}

// 采购清单导出用：需安排（公斤）× 品名绑定的缸规则 → 缸数 / 每缸公斤 / 建议下单量。
function purchaseRowVatPlan(row) {
  const item = itemById.value.get(row?.id)
  const planned = Number(row?.planned) || 0
  const rule = resolveVatRule(purchaseStore.settings, {
    skuId: purchaseRowSkuId(row),
    product: item?.product ?? row?.product,
  })
  return planOrderQuantity(planned, rule, {
    planned,
    monthlyAvgCount: item?.monthlyAvgCount,
  })
}
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
// 查看状态挂在 store 上：路由切换会重建本组件，筛选 / 展开 / 勾选 / 滚动位置不能跟着清空。
const viewStore = useInventoryViewStore()
const {
  productFilter,
  colorFilter,
  selectedWarningTones,
  selectedModeLabels,
  expandedProductKeys,
  selectedSkuIds,
  selectedRowId,
  tableScrollTop,
} = storeToRefs(viewStore)
const expandingProductKeys = ref(new Set())
// 需安排草稿同样跟着 store 走：直接持有对象引用，手填的值切页回来还在（导入时统一清空）。
const plannedDrafts = viewStore.plannedDrafts
// SKU 详情弹窗只保留一个实例并挂在页面层级：放在虚拟滚动行里会随行卸载，
// 遮罩还会被列表的 transform 容器裁掉。
const skuDetailVisible = ref(false)
const skuDetailItem = ref(null)
// 手动添加 SKU 弹窗：字段与导入总表 / 销售表一致，写入后由 toast 给出「查看该 SKU」入口。
const addSkuDialogVisible = ref(false)

function openSkuDetail(item) {
  skuDetailItem.value = item
  skuDetailVisible.value = true
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
const purchaseListDialogVisible = ref(false)
// 单个 SKU 的分订单弹窗：清单里点「去下单」时打开。
const purchaseOrderDialogVisible = ref(false)
const purchaseOrderItem = ref(null)
// 弹窗里的长列表按虚拟滚动渲染：上万个紧急 SKU / 采购条目时
// 直接 v-for 会把主线程卡住十几秒。
const URGENT_PLAN_ROW_HEIGHT = 48
const PURCHASE_LIST_ROW_HEIGHT = 48
const flyingPurchaseIcon = ref(null)
const purchaseListPulse = ref(false)
// 批量确认补货：先落成可编辑的「需安排」清单，确认后覆盖写入并进入采购清单。
const restockDialogVisible = ref(false)
const restockRows = ref([])
const RESTOCK_ROW_HEIGHT = 48

// 主面板与销售表共用同一条导入流程：分表清洗出总表 + 销售表后在这里预览并确认写入。
const sourceImport = useSourceImport({
  onApplied: handleSourcesImported,
})
const {
  dialogVisible: importDialogVisible,
  summary: importSummary,
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
  const evaluated = evaluateItem(item, stockingEvaluator.value)
  // 采购执行层：已下单 / 已到货来自订单流水（只统计 active），直接进预计库存。
  const orders = orderSummaryOf(purchaseStore.orderIndex, evaluated.skuId)
  const row = calculateInventoryRow({
    ...evaluated,
    ordered: orders.ordered,
    received: orders.received,
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
const leafRowIndexById = new Map()

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

function rebuildLeafRows() {
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

// 需安排草稿只影响该行的预警预览色（采纳后会叠加进预计库存），单独存放，避免整表重算。
const plannedPreviewTones = reactive({})

function refreshPlannedPreviewTone(item) {
  if (!item || !Reflect.has(plannedDrafts, item.id)) {
    if (item) delete plannedPreviewTones[item.id]
    return
  }

  const evaluated = evaluateItem(
    { ...item, planned: plannedDrafts[item.id] ?? 0 },
    stockingEvaluator.value,
  )
  const orders = orderSummaryOf(purchaseStore.orderIndex, evaluated.skuId)
  plannedPreviewTones[item.id] = calculateInventoryRow({
    ...evaluated,
    ordered: orders.ordered,
    received: orders.received,
  }).urgencyTone
}

function getPlannedTone(row) {
  if (!Reflect.has(plannedDrafts, row.id)) return row.urgencyTone
  return plannedPreviewTones[row.id] ?? row.urgencyTone
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
  return `累计下单 ${formatQuantity(row.ordered)} 公斤，到货 ${formatQuantity(
    row.received,
  )} 公斤，待收 ${formatQuantity(row.pendingOrder)} 公斤`
}

// 撤销订单后把公斤数退回需安排：落在未锁的草稿层（显示但不计入预计库存），
// 于是预警退回「紧急补货」，需要重新采纳才算有效计划。
function handleOrderCancelled({ skuId, quantity }) {
  const item = inventoryItems.find((entry) => String(entry.skuId ?? '').trim() === skuId)
  if (!item) return

  const current = Reflect.has(plannedDrafts, item.id) ? Number(plannedDrafts[item.id]) || 0 : 0
  plannedDrafts[item.id] = current + (Number(quantity) || 0)
  refreshPlannedPreviewTone(item)
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
  { key: 'rule', label: '模式', width: 78, group: '信息' },
  { key: 'score', label: '评分', width: 58, group: '信息' },
  { key: 'product', label: '品名', width: 150, group: '商品' },
  { key: 'color', label: '颜色', width: 132, group: '商品' },
  { key: 'urgency', label: '预警', width: 44, group: '商品' },
  { key: 'planned', label: '需安排', width: 142, group: '入口' },
  { key: 'producing', label: '生产中', width: 76, group: '入口' },
  // 「备货」= 采购执行层：只来自订单流水，与导入数据无关。三列互为校验：累积下单 = 待收 + 到货。
  { key: 'ordered', label: '累积下单', width: 84, group: '备货' },
  { key: 'pending', label: '待收', width: 76, group: '备货' },
  { key: 'received', label: '到货', width: 76, group: '备货' },
  { key: 'orderAction', label: '订单', width: 64, group: '备货' },
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

// 筛选条件变化后回到顶部：列表缩短时停留在原位置只会看到末尾几行或一片空白。
watch(
  [appliedProductFilter, appliedColorFilter, selectedWarningTones, selectedModeLabels],
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

  // 预警预览色是按行的缓存：按草稿重算一遍。
  for (const id of Object.keys(plannedDrafts)) {
    refreshPlannedPreviewTone(itemById.value.get(id))
  }
  // 勾选可能来自屏蔽前的行，先剔掉已不可见的 SKU。
  pruneHiddenSelection()
}

onMounted(() => {
  restoreTableView()
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
  if (highlightTimer) clearTimeout(highlightTimer)
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
        skuId: item.skuId,
        product: item.product,
        color: item.color,
        planned: item.planned ?? 0,
      })
    } else {
      const purchaseItem = purchaseList[purchaseIndex]
      purchaseItem.skuId = item.skuId
      purchaseItem.product = item.product
      purchaseItem.color = item.color
      purchaseItem.planned = item.planned ?? 0
    }
    changedIds.push(item.id)
  }

  refreshLeafRows(changedIds)
  schedulePlanPersist(inventoryStore)
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
  if (hasPlannedDraft(row.id)) return plannedDrafts[row.id]
  // 0 与缺省都当作「还没填」：否则下单清零留下的一个 0 会把占位建议值挡住，看不出还差多少。
  if (hasPlannedUndo(row.id)) return row.planned
  return row.planned > 0 ? row.planned : null
}

// 需安排建议值：补到绿色带中位（正常库存）的差额，基于理论库存；批量补货的默认数量与单行占位同一口径。
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
    return '订单货：客户报多少单就在这里填多少公斤，采纳后写入本次采购清单（不参与预警与评分，不给建议值）'
  }
  if (!row.strategyAvailable) {
    return `备货模式缺省，无法计算建议需安排量：${row.strategyIssue || '系数不可用'}`
  }

  const suggestion = getSuggestedPlanned(row)
  if (suggestion > 0) {
    return `建议填写 ${formatQuantity(suggestion)}，采纳后预计库存达到正常库存（绿色带中位）；该建议不会自动采纳，下单页会再按缸规则建议整缸数量`
  }
  return `预计库存（已含累计下单 ${formatQuantity(row.ordered)} 公斤）不低于正常库存下限，无需再补；要加量可直接填写`
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
      skuId: item.skuId,
      product: item.product,
      color: item.color,
      planned: item.planned ?? 0,
    })
    return
  }

  purchaseList[purchaseIndex].skuId = item.skuId
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

// 清单里的「去下单」：把当前 SKU 交给分订单弹窗（染厂 / 分单人员 / 数量）。
function openPurchaseOrder(row) {
  const item = itemById.value.get(row.id)
  if (!item) return
  purchaseOrderItem.value = {
    id: row.id,
    skuId: purchaseRowSkuId(row),
    product: item.product,
    color: item.color,
    treeCategory: purchaseRowCategory(row),
    planned: row.planned ?? 0,
    monthlyAvgCount: item.monthlyAvgCount,
  }
  purchaseOrderDialogVisible.value = true
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
  schedulePlanPersist(inventoryStore)
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
  schedulePlanPersist(inventoryStore)
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

// 屏蔽（删除）后清掉已不在表里的勾选，避免批量条统计到看不见的 SKU。
function pruneHiddenSelection() {
  if (selectedSkuIds.value.size === 0) return
  const next = new Set()
  for (const id of selectedSkuIds.value) {
    const item = itemById.value.get(id)
    if (item && !isItemHidden(item)) next.add(id)
  }
  if (next.size !== selectedSkuIds.value.size) selectedSkuIds.value = next
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
    if (next.size !== selectedSkuIds.value.size) selectedSkuIds.value = next
  },
)

function openRestockDialog() {
  restockRows.value = inventoryLeafRows.value
    .filter((row) => selectedSkuIds.value.has(row.id))
    .map((row) => {
      // 需安排始终是精准公斤数；缸数建议只在采购下单页出现。
      const suggested = getSuggestedPlanned(row)
      return {
        id: row.id,
        product: row.product,
        color: row.color,
        strategyAvailable: row.strategyAvailable,
        manualBehavior: row.manualBehavior,
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
    !row.isProductGroup && row.id === highlightedRowId.value ? 'inventory-row-highlight' : '',
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

// 采购清单与分单明细各一张工作表：清单给采购看总量，明细给染厂/跟单看分单。
function buildPurchaseSheetXml(rows, columnWidths) {
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
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`,
    )
    .join('')
  const lastColumn = getExcelColumnName(rows[0].length - 1)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${worksheetRows}</sheetData><autoFilter ref="A1:${lastColumn}${rows.length}"/></worksheet>`
}

function exportPurchaseListToExcel() {
  const rows = [
    ['品名', '颜色', '树形分类', '需安排', '缸数', '每缸公斤', '建议下单', '累积下单', '到货', '待收', '分单数量'],
    ...purchaseListRows.value.map((item) => {
      const orders = purchaseRowOrders(item)
      const plan = purchaseRowVatPlan(item)
      return [
        item.product,
        item.color,
        purchaseRowCategory(item),
        item.planned ?? 0,
        plan.vatCount ?? '',
        plan.kgPerVat ?? '',
        plan.rounded,
        orders.total,
        orders.received,
        orders.pending,
        orders.count,
      ]
    }),
  ]

  const detailRows = [
    ['品名', '颜色', '树形分类', '染厂', '分单人员', '缸数', '每缸公斤', '数量（公斤）', '到货', '待收', '备注'],
  ]
  for (const item of purchaseListRows.value) {
    const skuId = purchaseRowSkuId(item)
    if (!skuId) continue
    const category = purchaseRowCategory(item)
    for (const entry of purchaseRowOrders(item).orders) {
      const factoryName =
        entry.factoryName ||
        findFactoryById(purchaseStore.settings, entry.factoryId)?.name ||
        ''
      detailRows.push([
        item.product,
        item.color,
        category,
        factoryName,
        entry.assignee,
        entry.vatCount ?? '',
        entry.kgPerVat ?? '',
        entry.quantity,
        entry.receivedQty ?? 0,
        Math.max(0, (Number(entry.quantity) || 0) - (Number(entry.receivedQty) || 0)),
        entry.note,
      ])
    }
  }

  const worksheetXml = buildPurchaseSheetXml(rows, [24, 14, 18, 12, 10, 12, 12, 12, 10])
  const detailSheetXml = buildPurchaseSheetXml(detailRows, [24, 14, 18, 16, 12, 10, 12, 14, 24])
  const styleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF2F3B43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  const workbookXml = detailRows.length > 1
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="本次采购清单" sheetId="1" r:id="rId1"/><sheet name="分单明细" sheetId="2" r:id="rId2"/></sheets></workbook>`
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="本次采购清单" sheetId="1" r:id="rId1"/></sheets></workbook>`
  // 采购清单工作簿：有分单时追加「分单明细」工作表。
  const hasDetailSheet = detailRows.length > 1
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${hasDetailSheet ? '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : ''}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': hasDetailSheet
      ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml,
    'xl/styles.xml': styleXml,
    ...(hasDetailSheet ? { 'xl/worksheets/sheet2.xml': detailSheetXml } : {}),
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
      <div class="page-head">
        <h1 class="page-title">主面板</h1>
        <div class="page-head__actions">
          <ElButton
            class="import-split-button"
            size="small"
            title="选择 5 张分表，先清洗出总表与销售表再导入"
            @click="triggerSplitImport"
          >
            导入分表
          </ElButton>
          <ElButton
            class="add-sku-button"
            size="small"
            title="手动添加一个 SKU，字段与导入的总表 / 销售表一致"
            @click="addSkuDialogVisible = true"
          >
            添加SKU
          </ElButton>
          <ElButton class="import-template-button" size="small" @click="downloadImportTemplate">
            导入模板
          </ElButton>
          <ElButton
            class="urgent-plan-button"
            size="small"
            :disabled="urgentRows.length === 0"
            @click="openUrgentPlanDialog"
          >
            紧急补货 <span class="urgent-count">{{ urgentRows.length }}</span>
          </ElButton>
          <ElButton
            class="purchase-list-button"
            size="small"
            :class="{ 'purchase-list-button--received': purchaseListPulse }"
            @click="purchaseListDialogVisible = true"
          >
            本次采购清单 <span class="urgent-count urgent-count--muted">{{ purchaseList.length }}</span>
          </ElButton>
        </div>
      </div>
      <div class="inventory-filters" aria-label="库存筛选">
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
        <span class="meta inventory-filters__count">{{ filteredSkuCount }} 个 SKU</span>
        <div class="toolbar__end">
          <ElButton class="toggle-groups-button" size="small" @click="toggleAllProductGroups">
            {{ inventoryRows.length > 0 && inventoryRows.every((row) => expandedProductKeys.includes(row.id)) ? '全部收起' : '全部展开' }}
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
                :class="[
                  `planned-cell planned-cell--${getPlannedTone(row)}`,
                  { 'planned-cell--order': row.manualBehavior === 'order' },
                ]"
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
              <div
                class="inventory-vtable__cell inventory-vtable__cell--ordered"
                :title="orderCellTitle(row)"
              >
                {{ row.isProductGroup && !row.ordered ? '—' : formatQuantity(row.ordered) }}
              </div>
              <div class="inventory-vtable__cell" :title="orderCellTitle(row)">
                {{
                  row.isProductGroup && !row.pendingOrder
                    ? '—'
                    : formatQuantity(row.pendingOrder)
                }}
              </div>
              <div
                class="inventory-vtable__cell inventory-vtable__cell--received"
                :title="orderCellTitle(row)"
              >
                {{ row.isProductGroup && !row.received ? '—' : formatQuantity(row.received) }}
              </div>
              <div class="inventory-vtable__cell inventory-vtable__cell--order-action" @click.stop>
                <ElButton
                  v-if="!row.isProductGroup && row.ordered > 0"
                  size="small"
                  text
                  type="primary"
                  class="order-records-trigger"
                  :aria-label="`查看 ${row.product} ${row.color} 的采购订单`"
                  @click="openOrderDialog(row)"
                >
                  订单
                </ElButton>
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
      <ElButton class="batch-restock-clear" @click="clearSkuSelection">清空</ElButton>
      <ElButton class="batch-restock-confirm" @click="openRestockDialog">
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
                <strong>
                  {{
                    row.manualBehavior === 'order'
                      ? '按订单填写'
                      : row.strategyAvailable
                        ? formatQuantity(row.suggested)
                        : '缺省'
                  }}
                </strong>
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
      width="880px"
      class="purchase-list-dialog"
      :close-on-click-modal="false"
      destroy-on-close
      align-center
    >
      <p class="purchase-list-hint">
        已采纳的需安排会加入清单；同一商品颜色只保留一条。「累积下单」是分订单数量合计，点「去下单」按染厂拆单。
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
              <span role="columnheader">树形分类</span>
              <span role="columnheader">需安排</span>
              <span role="columnheader">累积下单</span>
              <span role="columnheader">到货</span>
              <span role="columnheader">待收</span>
              <span role="columnheader">操作</span>
            </div>
          </template>
          <template #default="{ item: row }">
            <div class="purchase-list-row" role="row">
              <span class="purchase-list-product" role="cell" :title="row.product">
                {{ row.product }}
              </span>
              <span role="cell">{{ row.color }}</span>
              <span
                class="purchase-list-category"
                role="cell"
                :title="purchaseRowCategory(row)"
              >
                {{ purchaseRowCategory(row) || '—' }}
              </span>
              <span role="cell">{{ formatQuantity(row.planned) }}</span>
              <span
                role="cell"
                class="purchase-list-ordered"
                :class="{ 'purchase-list-ordered--done': purchaseRowOrders(row).total > 0 }"
              >
                {{ formatQuantity(purchaseRowOrders(row).total) }}
                <em v-if="purchaseRowOrders(row).count">
                  （{{ purchaseRowOrders(row).count }} 张）
                </em>
              </span>
              <span role="cell" class="purchase-list-received">
                {{ formatQuantity(purchaseRowOrders(row).received) }}
              </span>
              <span
                role="cell"
                class="purchase-list-pending"
                :class="{ 'purchase-list-pending--open': purchaseRowOrders(row).pending > 0 }"
              >
                {{ formatQuantity(purchaseRowOrders(row).pending) }}
              </span>
              <span role="cell">
                <ElButton size="small" text type="primary" @click="openPurchaseOrder(row)">
                  去下单
                </ElButton>
              </span>
            </div>
          </template>
        </VirtualList>
        <div v-if="purchaseListRows.length === 0" class="purchase-list-empty">
          暂无已采纳的采购计划
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer purchase-list-footer">
          <RouterLink class="purchase-list-link" to="/purchase">进入采购下单页 →</RouterLink>
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

    <SkuOrderDialog v-model:visible="purchaseOrderDialogVisible" :item="purchaseOrderItem" />

    <PurchaseOrderRecordsDialog
      v-model="orderDialogVisible"
      :item="orderDialogRow"
      @cancelled="handleOrderCancelled"
    />

    <AddSkuDialog
      v-model:visible="addSkuDialogVisible"
      @created="handleSkuAdded"
    />

    <SkuDetailDialog
      v-model:visible="skuDetailVisible"
      :item="skuDetailItem"
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
  padding: 7px 8px;
  margin-bottom: 8px;
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: var(--industrial-surface);
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

.toolbar__end {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.text-filter {
  width: 150px;
}

.warning-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* 已筛选 SKU 数紧跟在预警筛选按钮块的右侧，不再顶到工具栏最右端。 */
.inventory-filters__count {
  margin-left: 4px;
}

.warning-filter {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 0 7px;
  color: var(--industrial-muted);
  border: 1px solid var(--industrial-grid);
  border-radius: 2px;
  background: var(--industrial-surface);
  font: inherit;
  font-size: 11.5px;
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

.urgent-count--muted {
  background: #e1e6e9;
  color: #2f3b43;
}

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
  width: min(880px, calc(100vw - 32px));
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
    minmax(130px, 1.5fr)
    minmax(80px, 0.9fr)
    minmax(110px, 1.2fr)
    minmax(80px, 0.8fr)
    minmax(90px, 0.9fr)
    minmax(80px, 0.8fr)
    minmax(80px, 0.8fr)
    minmax(76px, 0.6fr);
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  text-align: center;
}

.purchase-list-vat {
  color: var(--industrial-muted);
  font-size: 12px;
  white-space: nowrap;
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

.purchase-list-category {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.purchase-list-ordered {
  color: var(--industrial-muted);
  font-variant-numeric: tabular-nums;
}

.purchase-list-ordered--done {
  color: var(--industrial-primary);
  font-weight: 600;
}

.purchase-list-ordered em {
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
}

.purchase-list-received,
.purchase-list-pending {
  color: var(--industrial-muted);
  font-variant-numeric: tabular-nums;
}

.purchase-list-pending--open {
  color: var(--industrial-urgent);
  font-weight: 600;
}

.purchase-list-empty {
  padding: 28px 12px;
  color: var(--industrial-muted);
  text-align: center;
}

.purchase-list-footer {
  justify-content: flex-end;
}

.purchase-list-link {
  margin-right: auto;
  color: var(--industrial-primary);
  font-size: 13px;
  text-decoration: none;
}

.purchase-list-link:hover {
  text-decoration: underline;
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
  gap: 6px;
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
