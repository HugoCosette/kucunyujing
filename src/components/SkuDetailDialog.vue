<script setup>
import { computed, h, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  ElDialog,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElTooltip,
} from 'element-plus'
import { useInventoryStore } from '@/stores/inventory'
import { usePurchaseStore } from '@/stores/purchase'
import { useStockingConfigStore } from '@/stores/stocking'
import {
  createEvaluator,
  evaluateItem,
  evaluateReplenishRisk,
  getAutoModes,
  getManualModes,
} from '@/stocking'
import { orderSummaryOf } from '@/purchase/resolve'
import { calculateInventoryRow, getSuggestedPlanned } from '@/utils/inventory'
import { QUANTITY_MAX, vQuantityDigits } from '@/utils/quantityInput'
import { evaluateRowHealth } from '@/utils/skuHealth'

const props = defineProps({
  // 传主面板行或原始 SKU 行都行：评估只读取因子字段，不依赖派生值。
  item: {
    type: Object,
    default: null,
  },
  // 受控显隐：弹窗统一挂在页面层级，由表格行的入口按钮驱动。
  visible: {
    type: Boolean,
    default: false,
  },
  // 需安排动作条：弹窗只负责输入与触发，写入由页面处理（主面板要重算表格行）。
  plannedEditable: {
    type: Boolean,
    default: false,
  },
  // 已采纳（锁定的需安排）：由页面按撤销记录给，弹窗不自留状态。
  plannedLocked: {
    type: Boolean,
    default: false,
  },
  // 需安排草稿：主面板把草稿存在 viewStore 里（表格那一格与这里共用一份），
  // 传了就受控 —— 两边输入实时同步；不传（销售表页没有需安排列）就用组件内部草稿。
  plannedDraft: {
    default: undefined,
  },
})

const emit = defineEmits([
  'update:visible',
  'update:planned-draft',
  'adopt-planned',
  'undo-planned',
])

const inventoryStore = useInventoryStore()
const purchaseStore = usePurchaseStore()
const stockingStore = useStockingConfigStore()

const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value),
})

// 模式 / 系数按当前配置现算，与主面板、配置页同一套口径。
const baselineMonth = computed(() => {
  const month = inventoryStore.salesSheet?.baselineMonth
  return Number.isFinite(month) && month > 0 ? month : null
})
const evaluated = computed(() =>
  props.item
    ? evaluateItem(
        props.item,
        createEvaluator(stockingStore.config, {
          manualOverrides: stockingStore.manualOverrides,
          baselineMonth: baselineMonth.value,
        }),
      )
    : null,
)
// evaluateItem 已按当前色彩（黑白 / 彩色）选好系数，这里直接取用。
const coefficients = computed(() => evaluated.value?.stockingCoefficients ?? null)
const coefficientText = computed(() => {
  const row = evaluated.value
  if (row?.excluded) {
    if (row.manualBehavior === 'order') return '订单货：按客户订单填量，不参与预警'
    return row.exclusive ? '专属品：不参与计算' : '不参与计算'
  }
  return coefficients.value
    ? `${coefficients.value.redLine} / ${coefficients.value.normal} / ${coefficients.value.peak}`
    : '缺省'
})
// 加权月销量 = 近1个月×w1 + 近3个月月均×w3 + 近12个月月均×w12。
const monthlySalesText = computed(() => {
  const value = evaluated.value?.monthlySales
  if (!Number.isFinite(value)) return '--'
  return `${Math.round(value).toLocaleString('zh-CN')} 公斤/月`
})
const productText = computed(() => String(props.item?.product ?? '').replace(/\s+/g, ' ').trim())
// 色彩标签分灰阶 / 彩色两种色调，与导入时的「黑白 / 彩色」口径保持一致。
const monochrome = computed(() => String(props.item?.category ?? '').includes('黑白'))

// —— 策略：自动（按模式判定）/ 手动（自定系数 / 订单货）——
// 选择即生效：单选、下拉、系数改动都会立刻写入，不需要再点保存。
const manualModes = computed(() => getManualModes(stockingStore.config))
const skuId = computed(() => String(props.item?.skuId ?? '').trim())
const savedEntry = computed(() => (skuId.value ? stockingStore.manualOverrides.get(skuId.value) ?? null : null))
const strategyDraft = ref('auto')
const manualModeDraft = ref('')
const customCoefficients = reactive({ redLine: null, normal: null, peak: null })
const savingManual = ref(false)
// 回填草稿时挂起监听，避免把「同步」当成用户切换又写一次文件。
let syncingDraft = false
let applying = false
let pendingApply = false

const selectedManualMode = computed(
  () => manualModes.value.find((mode) => mode.id === manualModeDraft.value) ?? null,
)
const isCustomMode = computed(() => selectedManualMode.value?.behavior === 'custom')
const coefficientsValid = computed(() => {
  const values = [customCoefficients.redLine, customCoefficients.normal, customCoefficients.peak]
  return (
    values.every((value) => Number.isFinite(value)) &&
    values.every((value) => value >= 0) &&
    values[0] <= values[1] &&
    values[1] <= values[2]
  )
})
const manualCoefficientWarning = computed(
  () => strategyDraft.value === 'manual' && isCustomMode.value && !coefficientsValid.value,
)

function writeCoefficients(source) {
  customCoefficients.redLine = source?.redLine ?? null
  customCoefficients.normal = source?.normal ?? null
  customCoefficients.peak = source?.peak ?? null
}

// 打开弹窗或切换 SKU 时，用已保存的手动设置回填表单。
function syncStrategyDraft() {
  syncingDraft = true
  try {
    const entry = savedEntry.value
    if (!entry) {
      strategyDraft.value = 'auto'
      // 手动策略下默认落在「订单货模式」（按客户订单填量最常见），自定系数模式作为次选。
      const fallback =
        manualModes.value.find((mode) => mode.behavior === 'order') ?? manualModes.value[0]
      manualModeDraft.value = fallback?.id ?? ''
      const customMode = manualModes.value.find((mode) => mode.behavior === 'custom')
      writeCoefficients(fallback?.defaultCoefficients ?? customMode?.defaultCoefficients)
      return
    }

    strategyDraft.value = 'manual'
    manualModeDraft.value = entry.modeId
    const mode = manualModes.value.find((item) => item.id === entry.modeId)
    writeCoefficients(entry.coefficients ?? mode?.defaultCoefficients)
  } finally {
    syncingDraft = false
  }
}

function sameEntry(previous, next) {
  if (!previous || previous.modeId !== next.modeId) return false
  if (!next.coefficients) return true
  const current = previous.coefficients ?? {}
  return (
    current.redLine === next.coefficients.redLine &&
    current.normal === next.coefficients.normal &&
    current.peak === next.coefficients.peak
  )
}

// 自动 → 删除手动记录；手动 → 按当前下拉与系数写入。
async function applyStrategy() {
  if (!skuId.value) return
  if (applying) {
    pendingApply = true
    return
  }
  applying = true
  savingManual.value = true
  try {
    const previous = savedEntry.value

    if (strategyDraft.value === 'auto') {
      if (!previous) return
      await stockingStore.setManualEntry(skuId.value, null)
      ElMessage.success('已恢复自动策略')
      return
    }

    const mode = selectedManualMode.value
    if (!mode) {
      ElMessage.error('请选择手动模式')
      syncStrategyDraft()
      return
    }

    const entry = { modeId: mode.id }
    if (mode.behavior === 'custom') {
      if (!coefficientsValid.value) return
      entry.coefficients = {
        redLine: customCoefficients.redLine,
        normal: customCoefficients.normal,
        peak: customCoefficients.peak,
      }
    }

    if (sameEntry(previous, entry)) return
    await stockingStore.setManualEntry(skuId.value, entry)
    ElMessage.success(`已设为「${mode.name}」`)
  } finally {
    applying = false
    savingManual.value = false
    if (pendingApply) {
      pendingApply = false
      applyStrategy()
    }
  }
}

watch([dialogVisible, skuId, manualModes], ([isVisible]) => {
  if (!isVisible) return
  syncStrategyDraft()
}, { immediate: true })

// 关闭时把还没 blur 的系数改动补写一次（@change 只在 blur / 回车时触发）。
watch(dialogVisible, (isVisible) => {
  if (isVisible) return
  applyStrategy()
})

// 单选 / 下拉 / 系数改动即生效，所以不再需要「保存」按钮。
watch(strategyDraft, () => {
  if (syncingDraft) return
  applyStrategy()
}, { flush: 'sync' })

watch(manualModeDraft, () => {
  if (syncingDraft || strategyDraft.value !== 'manual') return
  // 切到「自定系数模式」时默认填该模式的默认系数。
  if (isCustomMode.value && customCoefficients.redLine === null) {
    writeCoefficients(selectedManualMode.value?.defaultCoefficients)
  }
  applyStrategy()
}, { flush: 'sync' })

// 卡片右上角的「看图」箭头：内联 SVG，不额外引图标包
const ChartIcon = () =>
  h('svg', { class: 'sku-detail__chart-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [
    h('path', {
      d: 'M5.4 10.6 10.6 5.4M6.6 5.4h4v4',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-width': '1.4',
    }),
  ])

const salesSheet = computed(() => inventoryStore.salesSheet)
const months = computed(() => salesSheet.value?.months ?? [])
const salesOfSku = computed(() => {
  const skuId = props.item?.skuId
  if (!skuId) return null
  return salesSheet.value?.bySku?.get(skuId) ?? null
})

// —— 健康度评分 ——
// 主面板传的是算过库存列的行，销售表传的是原始行，这里统一按当前配置重算一遍再评分。
const calculatedRow = computed(() =>
  props.item ? calculateInventoryRow(evaluated.value) : null,
)
// 按量模式用专属的两项判定（建议值进销比 / 累积客户数），区间取配置页「按量」模式里的设置。
const bulkHealthScoring = computed(
  () =>
    getAutoModes(stockingStore.config).find((mode) => mode.key === 'bulk')?.healthScoring ?? null,
)
// 口径与主面板「评分」列共用 src/utils/skuHealth.js，两边算出的综合评分一定一致。
const scoring = computed(() => {
  if (!props.item || !calculatedRow.value) return null
  return evaluateRowHealth({
    row: calculatedRow.value,
    salesEntry: salesOfSku.value,
    config: stockingStore.config.scoring,
    bulkHealthScoring: bulkHealthScoring.value,
  })
})
// 按量模式没有「得分」，tooltip 里直接给出该项的判定规则。
// 维度在弹窗里的排法：同类的两张竖着放一列（客户 / 销售 / 月份），
// 与 SCORING_DIMENSIONS 的自然顺序不同，所以单独排一次交给 grid 按列填充。
const SCORE_COLUMN_ORDER = ['cr5', 'customers', 'growth', 'ratio', 'consumption', 'activeMonths']
// 弹窗里的维度卡沿用更直白的叫法：进销比算的是「建议补货量 ÷ 累积销量」，客户两项与上方卡片同名。
const SCORE_LABEL_OVERRIDES = {
  ratio: '建议值进销比',
  cr5: '客户CR5率',
  customers: '累计客户',
}
const orderedDimensions = computed(() => {
  const dimensions = (scoring.value?.dimensions ?? []).map((dimension) =>
    SCORE_LABEL_OVERRIDES[dimension.key]
      ? { ...dimension, label: SCORE_LABEL_OVERRIDES[dimension.key] }
      : dimension,
  )
  // 按量模式只有两张判定卡，保持「进销比 → 累积客户数」的原始顺序。
  if (scoring.value?.mode === 'bulk') return dimensions
  return [...dimensions].sort(
    (a, b) => SCORE_COLUMN_ORDER.indexOf(a.key) - SCORE_COLUMN_ORDER.indexOf(b.key),
  )
})
const salesData = computed(() =>
  months.value.map((month) => salesOfSku.value?.sales?.[month - 1] ?? null),
)
const countData = computed(() =>
  months.value.map((month) => salesOfSku.value?.counts?.[month - 1] ?? null),
)
// —— 需安排 + 采纳（弹窗里直接补货）——
// 建议值与主面板「需安排」占位同一口径：补到正常库存（绿区中位）的差额（公斤，精准到个位）。
const suggestedPlanned = computed(() =>
  calculatedRow.value ? getSuggestedPlanned(calculatedRow.value) : 0,
)
const savedPlanned = computed(() => {
  const value = Number(calculatedRow.value?.planned)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0
})
// 订单货（手动策略 behavior: order）没有建议值：这一格就是客户电话报的量。
const plannedOrderGoods = computed(() => evaluated.value?.manualBehavior === 'order')
const localPlannedDraft = ref(null)
// 受控时用页面的草稿，否则回退到组件内部：两个入口（主面板 / 销售表）都不用各写一份。
const plannedDraft = computed(() =>
  props.plannedDraft === undefined ? localPlannedDraft.value : props.plannedDraft,
)
// 采纳数量：填了用填的 → 没填用已保存的需安排 → 再没有就按建议值（与主面板行内采纳一致）。
const plannedResolved = computed(() => {
  const draft = Number(plannedDraft.value)
  if (Number.isFinite(draft) && draft > 0) return Math.round(draft)
  if (savedPlanned.value > 0) return savedPlanned.value
  return plannedOrderGoods.value ? 0 : Math.round(suggestedPlanned.value)
})
const canAdoptPlanned = computed(
  () => props.plannedEditable && !props.plannedLocked && plannedResolved.value > 0,
)
const plannedPlaceholder = computed(() => {
  if (plannedOrderGoods.value) return '按订单填写'
  if (!calculatedRow.value?.strategyAvailable) return '无法建议'
  return suggestedPlanned.value > 0 ? String(suggestedPlanned.value) : '0'
})

// —— 本次补货风险 ——
// 补货后的日库销比要和主面板同一口径：把「填报 / 已采纳 / 建议值」当成已采纳重算一行，
// 订单数据从 purchase store 现取，所以销售表页打开弹窗也与主面板一致。
const replenishPreviewRow = computed(() => {
  if (!evaluated.value) return null
  const orders = orderSummaryOf(purchaseStore.orderIndex, evaluated.value.skuId)
  return calculateInventoryRow({
    ...evaluated.value,
    ordered: orders.ordered,
    received: orders.received,
    planned: plannedResolved.value,
  })
})
// 取分口径见 src/stocking/replenishRisk.js：三个因子各落低 / 中 / 高 → 取分相加 → 对门槛出结论。
const replenishRisk = computed(() => {
  if (!props.item || !replenishPreviewRow.value) return null
  return evaluateReplenishRisk({
    planned: plannedResolved.value,
    previewRow: replenishPreviewRow.value,
    health: scoring.value,
    scoringConfig: stockingStore.config.scoring,
    bulkHealthScoring: bulkHealthScoring.value,
    cumulativeSales: salesOfSku.value?.cumulativeSales ?? props.item.cumulativeSales,
    suggested: suggestedPlanned.value,
  })
})

// 因子值拆成「数字 + 单位」两段：单位小一号，长数字也不会把卡片撑开。
// 百分号不拆（中文里「9%」本来就不空格），只拆 天 / 公斤 / 个 这类词单位。
// 卡面顺序由 replenishRisk.js 的 factors 决定（日库销比 → 补货进销比 → 综合评分）。
const VALUE_UNIT_PATTERN = /^(.+?)\s*(天|公斤|个)$/
const TIER_WORDS = { high: '高', mid: '中', low: '低' }
const riskFactors = computed(() =>
  (replenishRisk.value?.factors ?? []).map((factor) => {
    const match = String(factor.valueText ?? '').match(VALUE_UNIT_PATTERN)
    const points = factor.points ?? 0
    const tierWord = TIER_WORDS[factor.tier] ?? ''
    // 档位统一成「高 / 中 / 低」；只保留方向词（偏多 / 偏少 / 正常带 / 偏离），
    // 避免出现「高 · 高风险」这种重复
    const cleanLabel = String(factor.tierLabel ?? '').replace(/风险$/, '')
    return {
      ...factor,
      valueMain: match ? match[1] : factor.valueText,
      valueUnit: match ? match[2] : '',
      tierText:
        cleanLabel && cleanLabel !== tierWord ? `${tierWord} · ${cleanLabel}` : tierWord || cleanLabel,
      // 净偏离带符号：+1 / 0 / −1
      pointText: points > 0 ? `+${points}` : points < 0 ? `−${Math.abs(points)}` : '0',
      pointSign: points > 0 ? 'plus' : points < 0 ? 'minus' : 'zero',
    }
  }),
)

// 结论图标：低风险打勾，中 / 高风险出感叹号，不参与出一横
const RISK_ICON_PATHS = {
  green: 'm5.1 8.1 1.9 1.9 3.9-4.1',
  yellow: 'M8 4.9v3.7M8 11.4h0',
  red: 'M8 4.9v3.7M8 11.4h0',
  unavailable: 'M5.4 8h5.2',
}
const riskIconPath = computed(
  () => RISK_ICON_PATHS[replenishRisk.value?.tone] ?? RISK_ICON_PATHS.unavailable,
)

function handlePlannedInput(event) {
  const raw = event.target.value
  const next = raw === '' ? null : Math.min(QUANTITY_MAX, Math.round(Number(raw) || 0))
  if (props.plannedDraft === undefined) {
    localPlannedDraft.value = next
    return
  }
  emit('update:planned-draft', next)
}

function submitPlanned() {
  if (!canAdoptPlanned.value) return
  emit('adopt-planned', { item: props.item, planned: plannedResolved.value })
  // 采纳后由页面写需安排并清草稿；这里只清内部那份（受控时草稿归页面管）。
  localPlannedDraft.value = null
}

function undoPlanned() {
  if (!props.plannedLocked) return
  emit('undo-planned', { item: props.item })
}

// 换 SKU / 重新打开时清掉没提交的输入，避免上一个 SKU 的数字留在框里
watch(
  () => [props.visible, skuId.value],
  ([isVisible]) => {
    if (isVisible) localPlannedDraft.value = null
  },
)

const hasSalesData = computed(
  () => months.value.length > 0 && salesData.value.some((value) => value !== null),
)
const orderData = computed(() =>
  months.value.map((month) => salesOfSku.value?.orders?.[month - 1] ?? null),
)
const hasOrderData = computed(
  () => months.value.length > 0 && orderData.value.some((value) => value !== null),
)
// —— 月度客户数（当月客户数柱 / 累计客户数线 / 客户CR5率线） ——
// 客户维度按月列由清洗引擎输出（销售表「N月客户数 / N月累计客户数 / N月客户CR5率」）。
const customerData = computed(() =>
  months.value.map((month) => salesOfSku.value?.customers?.[month - 1] ?? null),
)
const cumulativeCustomerData = computed(() => {
  const explicit = months.value.map(
    (month) => salesOfSku.value?.cumulativeCustomers?.[month - 1] ?? null,
  )
  if (explicit.some((value) => value !== null)) return explicit
  // 旧销售表没有累计列时，用当月客户数做兜底累加（只覆盖当前月份范围，属近似值）
  let running = 0
  return months.value.map((month, index) => {
    const value = customerData.value[index]
    if (value === null || value === undefined) return null
    running += value
    return running
  })
})
const cr5MonthData = computed(() =>
  months.value.map((month) => salesOfSku.value?.cr5ByMonth?.[month - 1] ?? null),
)
const hasCustomerData = computed(
  () =>
    months.value.length > 0 &&
    [...customerData.value, ...cumulativeCustomerData.value, ...cr5MonthData.value].some(
      (value) => value !== null,
    ),
)
// 累积销量：销售表「累积销量」列（Σ出库数量 → 公斤）随动销指标写入行数据。
const cumulativeSalesText = computed(() => {
  const raw = salesOfSku.value?.cumulativeSales ?? props.item?.cumulativeSales
  if (raw === null || raw === undefined || raw === '') return '--'
  const value = Number(raw)
  if (!Number.isFinite(value)) return '--'
  return `${Math.round(value).toLocaleString('zh-CN')} 公斤`
})

// 累积条数：5 个动销指标之一（Σ出库数量 ÷ 单位换算系数），随销售表带出；缺值时回退行数据。
const cumulativeCountText = computed(() => {
  const raw = salesOfSku.value?.metrics?.cumulativeCount ?? props.item?.cumulativeCount
  if (raw === null || raw === undefined || raw === '') return '--'
  const value = Number(raw)
  if (!Number.isFinite(value)) return '--'
  return `${Math.round(value).toLocaleString('zh-CN')} 条`
})

// 订单总数：5 个动销指标之一，随销售表带出；缺值时回退行数据。
const orderTotalText = computed(() => {
  const raw = salesOfSku.value?.metrics?.totalOrders ?? props.item?.totalOrders
  if (raw === null || raw === undefined || raw === '') return '--'
  const value = Number(raw)
  if (!Number.isFinite(value)) return '--'
  return `${Math.round(value).toLocaleString('zh-CN')} 单`
})
// 累计销量按月：优先用清洗出的「N月累计销量」（跨年累积）；旧销售表没有该列时按当月销量兜底累加。
const cumulativeSalesMonthData = computed(() => {
  const explicit = months.value.map(
    (month) => salesOfSku.value?.cumulativeSalesByMonth?.[month - 1] ?? null,
  )
  if (explicit.some((value) => value !== null)) return explicit
  let running = 0
  return months.value.map((month, index) => {
    const value = salesData.value[index]
    if (value === null || value === undefined) return null
    running += value
    return Number(running.toFixed(2))
  })
})
// 累计订单数按月：口径同累积销量（优先「N月累计订单数」，旧销售表按当月订单数兜底累加）。
const cumulativeOrdersMonthData = computed(() => {
  const explicit = months.value.map(
    (month) => salesOfSku.value?.cumulativeOrdersByMonth?.[month - 1] ?? null,
  )
  if (explicit.some((value) => value !== null)) return explicit
  let running = 0
  return months.value.map((month, index) => {
    const value = orderData.value[index]
    if (value === null || value === undefined) return null
    running += value
    return Number(running.toFixed(2))
  })
})
// 累积条数按月：口径同累积销量（优先「N月累计条数」，旧销售表按当月条数兜底累加）。
const cumulativeCountMonthData = computed(() => {
  const explicit = months.value.map(
    (month) => salesOfSku.value?.cumulativeCountByMonth?.[month - 1] ?? null,
  )
  if (explicit.some((value) => value !== null)) return explicit
  let running = 0
  return months.value.map((month, index) => {
    const value = countData.value[index]
    if (value === null || value === undefined) return null
    running += value
    return Number(running.toFixed(2))
  })
})

// —— 月度统计图：只有一个图区，按点中的卡片切换视图 ——
// 卡片（加权月销量 / 累计销量 / 累计条数 / 累计订单 / 客户CR5率 / 累计客户）是唯一入口；
// 「加权月销量」卡对应默认的月度销量图，一打开弹窗就是选中态，再点别的卡切走、
// 点回它或再点一次当前卡都回到这个默认视图。
const CHART_VIEWS = {
  sales: '月度销量',
  cumulative: '累计销量',
  cumulativeCount: '累计条数',
  orders: '累计订单',
  customers: '累计客户',
  cr5: '客户CR5率',
}
const CHART_VIEW_HINTS = {
  sales: '查看月度销量统计图',
  cumulative: '查看累计销量统计图',
  cumulativeCount: '查看累计条数统计图',
  orders: '查看累计订单统计图',
  customers: '查看累计客户统计图',
  cr5: '查看客户CR5率统计图',
}
// 评分区里带图的两张维度卡：维度 key → 图表视图
const CHART_CARDS = { cr5: 'cr5', customers: 'customers' }
const activeChartKey = ref('sales')
const activeChartTitle = computed(() => CHART_VIEWS[activeChartKey.value] ?? CHART_VIEWS.sales)
// 默认视图（月度销量）挂在「加权月销量」卡上，所以它一打开就是选中态；
// 点自己的卡不做变化，点别人的卡切过去，再点同一张回到默认。
function toggleChartView(key) {
  if (!CHART_VIEWS[key]) return
  activeChartKey.value = activeChartKey.value === key ? 'sales' : key
}

const SERIES_NAMES = {
  sales: '销量(公斤)',
  count: '条数',
  cumulative: '累计销量(公斤)',
  cumulativeCount: '累计条数',
  customers: '当月客户数',
  cumulativeCustomers: '累计客户数',
  cr5: '客户CR5率',
  orders: '订单数',
  cumulativeOrders: '累计订单数',
}
// 每个视图的图例胶囊：点一下隐藏该序列，当前视图至少保留一条
const CHART_LEGENDS = {
  sales: [
    { key: 'sales', label: '销量(公斤)', glyph: 'bar' },
    { key: 'count', label: '条数', glyph: 'line' },
  ],
  cumulative: [
    { key: 'sales', label: '当月销量(公斤)', glyph: 'bar' },
    { key: 'cumulative', label: '累计销量(公斤)', glyph: 'line' },
  ],
  cumulativeCount: [
    { key: 'count', label: '当月条数', glyph: 'bar' },
    { key: 'cumulativeCount', label: '累计条数', glyph: 'line' },
  ],
  orders: [
    { key: 'orders', label: '当月订单数', glyph: 'bar' },
    { key: 'cumulativeOrders', label: '累计订单数', glyph: 'line' },
  ],
  customers: [
    { key: 'customers', label: '当月客户数', glyph: 'bar' },
    { key: 'cumulativeCustomers', label: '累计客户数', glyph: 'line' },
    { key: 'cr5', label: '客户CR5率', glyph: 'line-ratio' },
  ],
  // 单序列的图不需要图例
  cr5: [],
}
// 开关状态跨视图保留：某个序列关掉了，切走再切回来仍是关的
const seriesVisible = reactive({
  sales: true,
  count: true,
  cumulative: true,
  cumulativeCount: true,
  orders: true,
  cumulativeOrders: true,
  customers: true,
  cumulativeCustomers: true,
  cr5: true,
})
const chartLegends = computed(() => CHART_LEGENDS[activeChartKey.value] ?? [])
const seriesKeyByName = new Map(
  Object.entries(SERIES_NAMES).map(([key, name]) => [name, key]),
)

function toggleSeries(key) {
  const legends = chartLegends.value
  if (!legends.some((legend) => legend.key === key)) return
  const visibleCount = legends.filter((legend) => seriesVisible[legend.key]).length
  if (seriesVisible[key] && visibleCount <= 1) return
  seriesVisible[key] = !seriesVisible[key]
  chart?.dispatchAction({ type: 'legendToggleSelect', name: SERIES_NAMES[key] })
}

const chartHasData = computed(() => {
  switch (activeChartKey.value) {
    case 'cumulative':
      return cumulativeSalesMonthData.value.some((value) => value !== null)
    case 'cumulativeCount':
      return cumulativeCountMonthData.value.some((value) => value !== null)
    case 'customers':
      return hasCustomerData.value
    case 'cr5':
      return cr5MonthData.value.some((value) => value !== null)
    case 'orders':
      return cumulativeOrdersMonthData.value.some((value) => value !== null)
    default:
      return hasSalesData.value
  }
})
const chartEmptyText = computed(() => {
  const imported = Boolean(salesSheet.value)
  if (activeChartKey.value === 'orders') {
    return imported
      ? '销售表未包含“N月订单数 / N月累计订单数”列（用最新清洗脚本重新导出即可）'
      : '尚未导入销售表，暂无月度订单数'
  }
  if (activeChartKey.value === 'customers' || activeChartKey.value === 'cr5') {
    return imported
      ? '销售表未包含客户月度列（用最新清洗脚本重新导出即可）'
      : '尚未导入销售表，暂无月度客户数据'
  }
  return imported ? '销售表中没有该商品的月度数据' : '尚未导入销售表，暂无 1-12月销量数据'
})

const chartRef = ref(null)
let chart = null

// 弹窗里的数值统一取整展示；不同图的单位由序列自己的 valueFormatter 决定
function numberTip(value, unit) {
  return Number.isFinite(Number(value))
    ? `${Math.round(Number(value)).toLocaleString('zh-CN')} ${unit}`
    : '—'
}
function ratioTip(value) {
  return Number.isFinite(Number(value)) ? `${Math.round(Number(value) * 100)}%` : '—'
}

// 统计图配色只有三种：当月柱（蓝）、累计线（金）、比例线（砖红，右轴）
const CHART_COLORS = {
  bar: '#3f718d',
  cumulative: '#c49a52',
  ratio: '#a8624a',
}

function valueAxis(extra = {}) {
  return {
    type: 'value',
    splitLine: { lineStyle: { color: '#e1e6e9' } },
    axisLabel: { color: '#65737c', fontSize: 11 },
    ...extra,
  }
}

// 柱子和累计线量级差一个数量级（累计 = 12 个月之和），同轴会把柱子压成矮桩：
// 柱子轴按自己的最大值留 10% 余量并取到好看的刻度，累计线走右轴。
function niceAxisMax(data) {
  let max = 0
  for (const value of data) {
    const num = Number(value)
    if (Number.isFinite(num) && num > max) max = num
  }
  if (!(max > 0)) return undefined
  const target = max * 1.1
  const magnitude = 10 ** Math.floor(Math.log10(target))
  for (const factor of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidate = magnitude * factor
    if (candidate >= target) return candidate
  }
  return magnitude * 10
}

// 累计线的右轴：不画网格（网格由柱子那条左轴提供），刻度用金色与累计线一致
function cumulativeAxis({ integer = false } = {}) {
  return valueAxis({
    ...(integer ? { minInterval: 1 } : null),
    splitLine: { show: false },
    axisLabel: { color: CHART_COLORS.cumulative, fontSize: 11 },
  })
}

function barSeries(name, data, color, unit = '公斤') {
  return {
    name,
    type: 'bar',
    barMaxWidth: 16,
    itemStyle: { color, borderRadius: [2, 2, 0, 0] },
    tooltip: { valueFormatter: (value) => numberTip(value, unit) },
    data,
  }
}

function lineSeries(
  name,
  data,
  { axisIndex = 0, color = CHART_COLORS.cumulative, formatter, dashed = false } = {},
) {
  return {
    name,
    type: 'line',
    yAxisIndex: axisIndex,
    smooth: true,
    symbolSize: 5,
    connectNulls: false,
    lineStyle: { width: 2, ...(dashed ? { type: 'dashed' } : null) },
    itemStyle: { color },
    ...(formatter ? { tooltip: { valueFormatter: formatter } } : null),
    data,
  }
}

function buildChartOption() {
  const view = activeChartKey.value
  const ratioAxis = valueAxis({
    min: 0,
    max: 1,
    splitLine: { show: false },
    axisLabel: {
      color: CHART_COLORS.ratio,
      fontSize: 11,
      formatter: (value) => `${Math.round(value * 100)}%`,
    },
  })
  let yAxis
  let series

  if (view === 'orders') {
    yAxis = [
      valueAxis({ minInterval: 1, max: niceAxisMax(orderData.value) }),
      cumulativeAxis({ integer: true }),
    ]
    series = [
      barSeries(SERIES_NAMES.orders, orderData.value, CHART_COLORS.bar, '单'),
      lineSeries(SERIES_NAMES.cumulativeOrders, cumulativeOrdersMonthData.value, {
        axisIndex: 1,
        formatter: (value) => numberTip(value, '单'),
      }),
    ]
  } else if (view === 'cr5') {
    yAxis = [ratioAxis]
    series = [
      lineSeries(SERIES_NAMES.cr5, cr5MonthData.value, {
        color: CHART_COLORS.ratio,
        formatter: ratioTip,
      }),
    ]
  } else if (view === 'customers') {
    // 三条序列三套量纲：当月客户数（柱，左轴）/ 累计客户数（线，右轴）/ 客户CR5率（比例线，右轴再偏移一列）
    yAxis = [
      valueAxis({ minInterval: 1, max: niceAxisMax(customerData.value) }),
      cumulativeAxis({ integer: true }),
      { ...ratioAxis, offset: 46 },
    ]
    series = [
      barSeries(SERIES_NAMES.customers, customerData.value, CHART_COLORS.bar, '个'),
      lineSeries(SERIES_NAMES.cumulativeCustomers, cumulativeCustomerData.value, {
        axisIndex: 1,
        formatter: (value) => numberTip(value, '个'),
      }),
      lineSeries(SERIES_NAMES.cr5, cr5MonthData.value, {
        axisIndex: 2,
        color: CHART_COLORS.ratio,
        dashed: true,
        formatter: ratioTip,
      }),
    ]
  } else if (view === 'cumulative') {
    yAxis = [valueAxis({ max: niceAxisMax(salesData.value) }), cumulativeAxis()]
    series = [
      barSeries(SERIES_NAMES.sales, salesData.value, CHART_COLORS.bar),
      lineSeries(SERIES_NAMES.cumulative, cumulativeSalesMonthData.value, { axisIndex: 1 }),
    ]
  } else if (view === 'cumulativeCount') {
    yAxis = [
      valueAxis({ minInterval: 1, max: niceAxisMax(countData.value) }),
      cumulativeAxis({ integer: true }),
    ]
    series = [
      barSeries(SERIES_NAMES.count, countData.value, CHART_COLORS.bar, '条'),
      lineSeries(SERIES_NAMES.cumulativeCount, cumulativeCountMonthData.value, {
        axisIndex: 1,
        formatter: (value) => numberTip(value, '条'),
      }),
    ]
  } else {
    // 默认：月度销量柱 + 条数线（条数走右轴，两套量纲各自好看）
    yAxis = [valueAxis(), cumulativeAxis()]
    series = [
      barSeries(SERIES_NAMES.sales, salesData.value, CHART_COLORS.bar),
      lineSeries(SERIES_NAMES.count, countData.value, {
        axisIndex: 1,
        formatter: (value) => numberTip(value, '条'),
      }),
    ]
  }

  return {
    animationDuration: 260,
    textStyle: { color: '#65737c', fontSize: 12 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#f5f7f8',
      borderColor: '#aab6be',
      borderWidth: 1,
      textStyle: { color: '#2f3b43', fontSize: 12 },
      // 兜底取整：没有单独 formatter 的序列也按整数读写
      valueFormatter: (value) =>
        Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString('zh-CN') : value,
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(63, 113, 141, 0.08)' } },
    },
    // 图例交给标题行的自定义胶囊（见模板），这里只保留开关状态供 dispatchAction 使用。
    legend: {
      show: false,
      data: series.map((item) => item.name),
      selected: Object.fromEntries(
        series.map((item) => [
          item.name,
          seriesVisible[seriesKeyByName.get(item.name)] !== false,
        ]),
      ),
    },
    grid: { left: 4, right: 4, top: 14, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: months.value.map((month) => `${month}月`),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#aab6be' } },
      axisLabel: { color: '#65737c', fontSize: 11 },
    },
    yAxis,
    series,
  }
}

// ECharts 只在第一次打开弹窗时按需加载（只注册用到的图表与组件），不拖慢表格首屏。
let echartsLoader = null
function loadEcharts() {
  if (!echartsLoader) {
    echartsLoader = Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
    ]).then(([core, charts, components, renderers]) => {
      core.use([
        charts.BarChart,
        charts.LineChart,
        components.GridComponent,
        components.LegendComponent,
        components.TooltipComponent,
        renderers.CanvasRenderer,
      ])
      return core
    })
  }
  return echartsLoader
}

async function renderChart() {
  if (!chartHasData.value || !chartRef.value) return

  const { init } = await loadEcharts()
  // 加载期间弹窗可能已关闭 / 已切到没有数据的视图，此时图表容器已卸载
  if (!chartHasData.value || !chartRef.value) return
  if (!chart) chart = init(chartRef.value)
  chart.setOption(buildChartOption(), true)
  window.removeEventListener('resize', resizeChart)
  window.addEventListener('resize', resizeChart)
}

function resizeChart() {
  chart?.resize()
}

function disposeChart() {
  window.removeEventListener('resize', resizeChart)
  chart?.dispose()
  chart = null
}

async function handleOpened() {
  await nextTick()
  renderChart()
}

// 关闭弹窗时回到默认的月度销量图：下次打开不会停在上次点的那张图上。
watch(dialogVisible, (isVisible) => {
  if (!isVisible) activeChartKey.value = 'sales'
})

// 弹窗打开期间切卡片 / 销售表才导入完成时，重画；当前视图没有数据就把图收掉。
watch(
  [dialogVisible, activeChartKey, chartHasData, hasSalesData, hasOrderData, hasCustomerData],
  ([isVisible]) => {
    if (!isVisible) return
    if (!chartHasData.value) {
      disposeChart()
      return
    }
    nextTick(renderChart)
  },
)

function handleClosed() {
  disposeChart()
}

// 切换面板或路由导致组件直接卸载时，关闭事件不会触发，需要自行释放图表实例。
onBeforeUnmount(disposeChart)
</script>

<template>
  <ElDialog
    v-model="dialogVisible"
    class="sku-detail-dialog"
    width="620px"
    append-to-body
    align-center
    modal-class="sku-detail-overlay"
    :show-close="false"
    @opened="handleOpened"
    @closed="handleClosed"
  >
    <template #header>
      <div class="sku-detail__header">
        <span class="sku-detail__title" :title="productText">{{ productText }}</span>
        <span v-if="item?.color" class="sku-detail__color">{{ item.color }}</span>
        <span
          v-if="item?.category"
          class="sku-detail__tone"
          :class="monochrome ? 'sku-detail__tone--mono' : 'sku-detail__tone--colorful'"
        >
          {{ item.category }}
        </span>
        <span class="sku-detail__header-spacer" />
        <ElRadioGroup v-model="strategyDraft" size="small" class="sku-detail__strategy-radio">
          <ElRadioButton value="auto">自动</ElRadioButton>
          <ElRadioButton value="manual">手动</ElRadioButton>
        </ElRadioGroup>
        <button
          type="button"
          class="sku-detail__close"
          aria-label="关闭"
          @click="dialogVisible = false"
        >
          ×
        </button>
      </div>
    </template>

    <div v-if="item" class="sku-detail">
      <div class="sku-detail__meta">
        <div class="sku-detail__meta-item" :title="evaluated?.modeLabel || '未命中模式'">
          <span class="sku-detail__label">模式</span>
          <span class="sku-detail__value">{{ evaluated?.modeLabel || '未命中模式' }}</span>
        </div>
        <div class="sku-detail__meta-item" :title="`系数（红 / 正 / 峰）：${coefficientText}`">
          <span class="sku-detail__label">系数</span>
          <span class="sku-detail__value">{{ coefficientText }}</span>
        </div>
        <div
          class="sku-detail__meta-item sku-detail__meta-item--chart"
          :class="{ 'is-chart-active': activeChartKey === 'sales' }"
          role="button"
          tabindex="0"
          :aria-pressed="activeChartKey === 'sales'"
          :title="CHART_VIEW_HINTS.sales"
          @click="toggleChartView('sales')"
          @keydown.enter.prevent="toggleChartView('sales')"
          @keydown.space.prevent="toggleChartView('sales')"
        >
          <span class="sku-detail__label">加权月销量</span>
          <span class="sku-detail__value">{{ monthlySalesText }}</span>
          <ChartIcon />
        </div>
        <div
          class="sku-detail__meta-item sku-detail__meta-item--chart"
          :class="{ 'is-chart-active': activeChartKey === 'cumulative' }"
          role="button"
          tabindex="0"
          :aria-pressed="activeChartKey === 'cumulative'"
          :title="CHART_VIEW_HINTS.cumulative"
          @click="toggleChartView('cumulative')"
          @keydown.enter.prevent="toggleChartView('cumulative')"
          @keydown.space.prevent="toggleChartView('cumulative')"
        >
          <span class="sku-detail__label">累计销量</span>
          <span class="sku-detail__value">{{ cumulativeSalesText }}</span>
          <ChartIcon />
        </div>
        <div
          class="sku-detail__meta-item sku-detail__meta-item--chart"
          :class="{ 'is-chart-active': activeChartKey === 'orders' }"
          role="button"
          tabindex="0"
          :aria-pressed="activeChartKey === 'orders'"
          :title="CHART_VIEW_HINTS.orders"
          @click="toggleChartView('orders')"
          @keydown.enter.prevent="toggleChartView('orders')"
          @keydown.space.prevent="toggleChartView('orders')"
        >
          <span class="sku-detail__label">累计订单</span>
          <span class="sku-detail__value">{{ orderTotalText }}</span>
          <ChartIcon />
        </div>
        <div
          class="sku-detail__meta-item sku-detail__meta-item--chart"
          :class="{ 'is-chart-active': activeChartKey === 'cumulativeCount' }"
          role="button"
          tabindex="0"
          :aria-pressed="activeChartKey === 'cumulativeCount'"
          :title="CHART_VIEW_HINTS.cumulativeCount"
          @click="toggleChartView('cumulativeCount')"
          @keydown.enter.prevent="toggleChartView('cumulativeCount')"
          @keydown.space.prevent="toggleChartView('cumulativeCount')"
        >
          <span class="sku-detail__label">累计条数</span>
          <span class="sku-detail__value">{{ cumulativeCountText }}</span>
          <ChartIcon />
        </div>
      </div>

      <h4 class="sku-detail__section">健康度评分</h4>
      <div v-if="scoring && !scoring.participates" class="sku-detail__empty">
        该 SKU 不参与备货计算，不做健康度评分
      </div>
      <div
        v-else-if="scoring"
        class="sku-score"
        :class="{ 'sku-score--bulk': scoring.mode === 'bulk' }"
      >
        <div
          v-if="scoring.mode !== 'bulk'"
          class="sku-score__total"
          :class="`sku-score__tone--${scoring.tone}`"
        >
          <span class="sku-score__total-label">综合评分</span>
          <strong class="sku-score__total-value">{{ scoring.totalText }}</strong>
          <span class="sku-score__badge">{{ scoring.toneLabel }}</span>
        </div>
        <div class="sku-score__grid">
          <ElTooltip
            v-for="dimension in orderedDimensions"
            :key="dimension.key"
            placement="top"
            effect="light"
            :show-after="120"
            :hide-after="0"
            :enterable="false"
          >
            <template #content>
              <div class="sku-score-tip">
                <div class="sku-score-tip__head">
                  <span>{{ dimension.label }}</span>
                  <span class="sku-score-tip__flag" :class="`sku-score-tip__flag--${dimension.tone}`">
                    {{ dimension.tierLabel }}
                  </span>
                </div>
                <div v-if="scoring.mode === 'bulk' && dimension.ruleText" class="sku-score-tip__row">
                  <span>判定规则</span><span>{{ dimension.ruleText }}</span>
                </div>
                <template v-else-if="dimension.available">
                  <div class="sku-score-tip__row">
                    <span>命中区间</span><span>{{ dimension.tierRangeText || '—' }}</span>
                  </div>
                  <div class="sku-score-tip__row">
                    <span>权重</span><span>{{ dimension.weightText }}</span>
                  </div>
                </template>
                <div class="sku-score-tip__detail">{{ dimension.detail }}</div>
              </div>
            </template>
            <div
              class="sku-score__card"
              :class="[
                `sku-score__tone--${dimension.tone}`,
                {
                  'sku-score__card--chart': CHART_CARDS[dimension.key],
                  'is-chart-active': CHART_CARDS[dimension.key] === activeChartKey,
                },
              ]"
              :role="CHART_CARDS[dimension.key] ? 'button' : undefined"
              :tabindex="CHART_CARDS[dimension.key] ? 0 : undefined"
              :aria-pressed="
                CHART_CARDS[dimension.key] ? activeChartKey === CHART_CARDS[dimension.key] : undefined
              "
              :title="CHART_CARDS[dimension.key] ? CHART_VIEW_HINTS[CHART_CARDS[dimension.key]] : undefined"
              @click="CHART_CARDS[dimension.key] && toggleChartView(CHART_CARDS[dimension.key])"
              @keydown.enter.prevent="
                CHART_CARDS[dimension.key] && toggleChartView(CHART_CARDS[dimension.key])
              "
              @keydown.space.prevent="
                CHART_CARDS[dimension.key] && toggleChartView(CHART_CARDS[dimension.key])
              "
            >
              <span class="sku-score__label">{{ dimension.label }}</span>
              <strong class="sku-score__value">{{ dimension.valueText }}</strong>
              <ChartIcon v-if="CHART_CARDS[dimension.key]" />
            </div>
          </ElTooltip>
        </div>
      </div>

      <!-- 补货风险提示：需安排输入与本次补货风险回答的是同一个问题，收进同一块。
           结论（低 / 中 / 高）落在输入卡顶部，卡片底色与左侧色条跟着结论走；
           三张因子卡只报「值 + 档位」，结构固定，输数字不会跳高度。 -->
      <section
        v-if="plannedEditable || replenishRisk"
        class="sku-plan"
        :class="[
          `sku-plan--tone-${replenishRisk?.tone ?? 'unavailable'}`,
          { 'sku-plan--locked': plannedLocked },
        ]"
      >
        <div class="sku-plan__head">
          <svg class="sku-plan__icon" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 1.9 13 3.7v4c0 3.1-2 5.4-5 6.4-3-1-5-3.3-5-6.4v-4L8 1.9Z"
              fill="none"
              stroke="currentColor"
              stroke-linejoin="round"
              stroke-width="1.2"
            />
            <path
              d="m5.9 7.9 1.5 1.5 2.8-2.9"
              fill="none"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.4"
            />
          </svg>
          <span class="sku-plan__title">补货风险提示</span>
          <!-- 只读场景没有输入卡：结论放头部，依据与动作同样收进 hover -->
          <ElTooltip
            v-if="replenishRisk && !plannedEditable"
            placement="top"
            effect="light"
            :show-after="160"
          >
            <template #content>
              <div class="sku-risk-tip">
                <div class="sku-risk-tip__head">
                  <span>本次补货风险</span>
                  <span class="sku-risk-tip__flag">{{ replenishRisk.riskLabel }}</span>
                </div>
                <div v-if="replenishRisk.title" class="sku-risk-tip__row">
                  {{ replenishRisk.title }}
                </div>
                <table class="sku-risk-tip__table">
                  <thead>
                    <tr>
                      <th>因子</th>
                      <th>档位</th>
                      <th class="is-num">分</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="factor in riskFactors" :key="factor.key">
                      <td>{{ factor.label }}</td>
                      <td>{{ factor.tierText }}</td>
                      <td class="is-num" :class="`is-${factor.pointSign}`">{{ factor.pointText }}</td>
                    </tr>
                    <tr class="sku-risk-tip__sum">
                      <td>合计</td>
                      <td colspan="2" class="is-num">
                        {{ replenishRisk.scoreText }} → {{ replenishRisk.riskLabel }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div class="sku-risk-tip__rule">{{ replenishRisk.ruleText }}</div>
                <div
                  v-if="replenishRisk.suggestion"
                  class="sku-risk-tip__row sku-risk-tip__row--action"
                >
                  {{ replenishRisk.suggestion }}
                </div>
              </div>
            </template>
            <span class="sku-plan__risk">
              <svg class="sku-plan__risk-icon" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6.6" fill="currentColor" />
                <path
                  :d="riskIconPath"
                  fill="none"
                  stroke="#fff"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.7"
                />
              </svg>
              {{ replenishRisk.riskLabel }}
            </span>
          </ElTooltip>
        </div>

        <div class="sku-plan__cards" :class="{ 'sku-plan__cards--solo': !riskFactors.length }">
          <div v-if="plannedEditable" class="sku-plan__card sku-plan__card--qty">
            <div class="sku-plan__card-head">
              <!-- 本次补货风险：卡顶只出低 / 中 / 高，依据与动作收进 hover -->
              <ElTooltip v-if="replenishRisk" placement="top" effect="light" :show-after="160">
                <template #content>
                  <div class="sku-risk-tip">
                    <div class="sku-risk-tip__head">
                      <span>本次补货风险</span>
                      <span class="sku-risk-tip__flag">{{ replenishRisk.riskLabel }}</span>
                    </div>
                    <div v-if="replenishRisk.title" class="sku-risk-tip__row">
                      {{ replenishRisk.title }}
                    </div>
                    <table class="sku-risk-tip__table">
                      <thead>
                        <tr>
                          <th>因子</th>
                          <th>档位</th>
                          <th class="is-num">分</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="factor in riskFactors" :key="factor.key">
                          <td>{{ factor.label }}</td>
                          <td>{{ factor.tierText }}</td>
                          <td class="is-num" :class="`is-${factor.pointSign}`">{{ factor.pointText }}</td>
                        </tr>
                        <tr class="sku-risk-tip__sum">
                          <td>合计</td>
                          <td colspan="2" class="is-num">
                            {{ replenishRisk.scoreText }} → {{ replenishRisk.riskLabel }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <div class="sku-risk-tip__rule">{{ replenishRisk.ruleText }}</div>
                    <div
                      v-if="replenishRisk.suggestion"
                      class="sku-risk-tip__row sku-risk-tip__row--action"
                    >
                      {{ replenishRisk.suggestion }}
                    </div>
                  </div>
                </template>
                <span class="sku-plan__risk">
                  <svg class="sku-plan__risk-icon" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.6" fill="currentColor" />
                    <path
                      :d="riskIconPath"
                      fill="none"
                      stroke="#fff"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="1.7"
                    />
                  </svg>
                  {{ replenishRisk.riskLabel }}
                </span>
              </ElTooltip>
              <span v-if="plannedLocked" class="sku-plan__badge">已采纳</span>
            </div>
            <div class="sku-plan__qty">
              <span class="sku-plan__card-label" title="即主面板「需安排」列：默认带出建议值，可改">
                需安排
              </span>
              <label class="sku-plan__field">
                <input
                  v-quantity-digits
                  class="sku-plan__input"
                  type="number"
                  min="0"
                  :max="QUANTITY_MAX"
                  step="1"
                  inputmode="decimal"
                  :value="plannedLocked ? savedPlanned : plannedDraft ?? ''"
                  :placeholder="plannedPlaceholder"
                  :readonly="plannedLocked"
                  :disabled="plannedLocked"
                  aria-label="需安排（公斤）"
                  @input="handlePlannedInput"
                  @keydown.enter.prevent="submitPlanned()"
                />
                <svg
                  v-if="plannedLocked"
                  class="sku-plan__lock"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
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
              </label>
              <span class="sku-plan__unit">公斤</span>
              <button
                v-if="plannedLocked"
                type="button"
                class="sku-plan__btn sku-plan__btn--ghost"
                @click="undoPlanned()"
              >
                撤销
              </button>
              <button
                v-else
                type="button"
                class="sku-plan__btn"
                :disabled="!canAdoptPlanned"
                title="回车采纳（Enter）"
                aria-label="采纳需安排"
                @click="submitPlanned()"
              >
                <svg class="sku-plan__btn-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="m3.6 8.4 3 3 5.9-6.2"
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1.8"
                  />
                </svg>
                采纳建议
              </button>
            </div>
          </div>

          <!-- 三个因子：标签 / 数值 / 圆点档位，颜色只落在圆点与档位字上 -->
          <ElTooltip
            v-for="factor in riskFactors"
            :key="factor.key"
            placement="top"
            effect="light"
            :show-after="120"
            :hide-after="0"
            :enterable="false"
          >
            <template #content>
              <div class="sku-risk-tip">
                <div class="sku-risk-tip__head">
                  <span>{{ factor.label }}</span>
                  <span class="sku-risk-tip__flag"
                    >{{ factor.tierLabel }} · {{ factor.pointText }} 分</span
                  >
                </div>
                <div v-if="factor.detail" class="sku-risk-tip__row">{{ factor.detail }}</div>
                <div v-if="factor.ruleText" class="sku-risk-tip__row">{{ factor.ruleText }}</div>
              </div>
            </template>
            <div class="sku-plan__card sku-risk__factor" :class="`sku-risk__factor--${factor.tone}`">
              <span class="sku-risk__factor-label">{{ factor.label }}</span>
              <div class="sku-risk__factor-row">
                <strong class="sku-risk__factor-value">
                  <span class="sku-risk__factor-number">{{ factor.valueMain }}</span>
                  <span v-if="factor.valueUnit" class="sku-risk__factor-unit">{{
                    factor.valueUnit
                  }}</span>
                </strong>
                <span class="sku-risk__factor-tier">
                  <span class="sku-risk__dot" aria-hidden="true" />{{ factor.tierLabel }}
                </span>
              </div>
            </div>
          </ElTooltip>
        </div>
      </section>

      <template v-if="strategyDraft === 'manual'">
        <div class="sku-detail__manual">
          <div class="sku-detail__manual-row">
            <span class="sku-detail__manual-label">模式</span>
            <ElSelect
              v-model="manualModeDraft"
              size="small"
              class="sku-detail__manual-select"
              placeholder="选择手动模式"
            >
              <ElOption
                v-for="mode in manualModes"
                :key="mode.id"
                :label="mode.name"
                :value="mode.id"
              />
            </ElSelect>
            <span v-if="selectedManualMode?.description" class="sku-detail__manual-hint">
              {{ selectedManualMode.description }}
            </span>
          </div>

          <div v-if="isCustomMode" class="sku-detail__manual-row">
            <span class="sku-detail__manual-label">系数</span>
            <label class="sku-detail__coefficient">
              <span>红线</span>
              <ElInputNumber
                v-model="customCoefficients.redLine"
                :min="0"
                :step="0.5"
                :precision="1"
                :controls="false"
                size="small"
                class="sku-detail__coefficient-input"
                @change="applyStrategy"
              />
            </label>
            <label class="sku-detail__coefficient">
              <span>正常</span>
              <ElInputNumber
                v-model="customCoefficients.normal"
                :min="0"
                :step="0.5"
                :precision="1"
                :controls="false"
                size="small"
                class="sku-detail__coefficient-input"
                @change="applyStrategy"
              />
            </label>
            <label class="sku-detail__coefficient">
              <span>峰值</span>
              <ElInputNumber
                v-model="customCoefficients.peak"
                :min="0"
                :step="0.5"
                :precision="1"
                :controls="false"
                size="small"
                class="sku-detail__coefficient-input"
                @change="applyStrategy"
              />
            </label>
          </div>

          <div class="sku-detail__manual-actions">
            <span v-if="manualCoefficientWarning" class="sku-detail__manual-warning">
              系数需满足 0 ≤ 红线 ≤ 正常 ≤ 峰值 且不为空，当前未保存
            </span>
            <span v-else class="sku-detail__manual-hint">
              {{ savingManual ? '保存中…' : '选择后立即生效，无需保存' }}
            </span>
          </div>
        </div>
      </template>

      <div class="sku-detail__chart-head">
        <h4 class="sku-detail__section">{{ activeChartTitle }}</h4>
        <div
          v-if="chartHasData && chartLegends.length"
          class="sku-detail__legend"
          role="group"
          aria-label="图表图例"
        >
          <button
            v-for="legend in chartLegends"
            :key="legend.key"
            type="button"
            class="sku-detail__legend-item"
            :class="{ 'is-off': !seriesVisible[legend.key] }"
            :aria-pressed="seriesVisible[legend.key]"
            @click="toggleSeries(legend.key)"
          >
            <span
              class="sku-detail__legend-glyph"
              :class="`sku-detail__legend-glyph--${legend.glyph}`"
              aria-hidden="true"
            ></span>
            {{ legend.label }}
          </button>
        </div>
      </div>
      <div v-if="chartHasData" ref="chartRef" class="sku-detail__chart"></div>
      <div v-else class="sku-detail__empty">{{ chartEmptyText }}</div>

    </div>
  </ElDialog>
</template>

<style scoped>
/* 弹窗打开后主面板「压灰但看得清」：还是原来那层灰（深色半透明），只把不透明度降下来，
   表格数据在弹窗外仍然清楚可读；不要换成白色 / 浅灰遮罩。 */
:global(.el-overlay.sku-detail-overlay) {
  background-color: rgba(12, 22, 32, 0.22);
}

:global(.el-dialog.sku-detail-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
  /* 遮罩变浅后弹窗边界要靠描边 + 阴影立住 */
  width: min(748px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  padding: 0;
  overflow: hidden;
  border: 1px solid rgba(63, 113, 141, 0.16);
  border-radius: 12px;
  box-shadow:
    0 28px 72px rgba(15, 32, 46, 0.22),
    0 2px 10px rgba(15, 32, 46, 0.08);
  display: flex;
  flex-direction: column;
}

:global(.sku-detail-dialog .el-dialog__header) {
  margin-right: 0;
  padding: 16px 20px 12px;
}

/* 内容高于视口时只让正文滚动，标题栏与关闭按钮始终可见；横向不出现滚动条 */
:global(.sku-detail-dialog .el-dialog__body) {
  min-height: 0;
  padding: 0 20px 18px;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 细滚动条：不要默认的宽灰槽，和弹窗浅色底更配 */
:global(.sku-detail-dialog .el-dialog__body::-webkit-scrollbar) {
  width: 8px;
}

:global(.sku-detail-dialog .el-dialog__body::-webkit-scrollbar-track) {
  background: transparent;
}

:global(.sku-detail-dialog .el-dialog__body::-webkit-scrollbar-thumb) {
  border: 2px solid transparent;
  border-radius: 8px;
  background-color: rgba(63, 113, 141, 0.26);
  background-clip: content-box;
}

:global(.sku-detail-dialog .el-dialog__body::-webkit-scrollbar-thumb:hover) {
  background-color: rgba(63, 113, 141, 0.42);
}

.sku-detail__header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-right: 0;
}

.sku-detail__close {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  margin-left: 2px;
  border: 0;
  border-radius: 6px;
  color: var(--industrial-muted);
  background: transparent;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition:
    color 0.16s ease,
    background-color 0.16s ease;
}

.sku-detail__close:hover {
  color: var(--industrial-text);
  background: rgba(63, 113, 141, 0.1);
}

.sku-detail__title {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.2px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sku-detail__color {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid rgba(63, 113, 141, 0.18);
  color: #55636c;
  background: #fff;
  border-radius: 4px;
  font-size: 11px;
}

.sku-detail__tone {
  flex: 0 0 auto;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
}

/* 黑白 SKU：灰阶色调 */
.sku-detail__tone--mono {
  color: #4d565c;
  background: rgba(77, 86, 92, 0.08);
  border-color: rgba(77, 86, 92, 0.18);
}

/* 彩色 SKU：淡紫色，和参考稿一样只做弱提示 */
.sku-detail__tone--colorful {
  color: #5f3fa0;
  background: rgba(150, 92, 236, 0.1);
  border-color: rgba(150, 92, 236, 0.22);
}

.sku-detail__header-spacer {
  flex: 1 1 auto;
}

.sku-detail__strategy-radio {
  flex: 0 0 auto;
}

.sku-detail__manual {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  padding: 10px 12px;
  border: 1px solid rgba(63, 113, 141, 0.12);
  border-radius: 8px;
  background: #fff;
}

.sku-detail__manual-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sku-detail__manual-label {
  min-width: 32px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.sku-detail__manual-select {
  width: 160px;
}

.sku-detail__manual-hint {
  color: var(--industrial-muted);
  font-size: 12px;
}

.sku-detail__manual-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sku-detail__manual-warning {
  color: #c45656;
  font-size: 12px;
}

.sku-detail__coefficient {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.sku-detail__coefficient-input {
  width: 72px;
}

.sku-detail__meta {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 18px;
}

.sku-detail__meta-item {
  min-width: 0;
  padding: 9px 11px 10px;
  background: #fff;
  border: 1px solid rgba(63, 113, 141, 0.12);
  border-radius: 8px;
  box-shadow: 0 1px 2px rgba(15, 32, 46, 0.03);
}

.sku-detail__label {
  display: block;
  color: #7b8994;
  font-size: 11px;
  letter-spacing: 0.2px;
}

.sku-detail__value {
  display: block;
  margin-top: 4px;
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

/* 带「看图」箭头的卡片：整卡可点，箭头放右上角。
   选中态只加描边 + 箭头变蓝，不动评分卡的红黄绿底色（那是风险语义）。 */
.sku-detail__meta-item--chart,
.sku-score__card--chart {
  position: relative;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

/* 箭头只压住标签那一行，数值行照常用满整卡宽度 */
.sku-detail__meta-item--chart .sku-detail__label,
.sku-score__card--chart .sku-score__label {
  padding-right: 14px;
}

.sku-detail__meta-item--chart:hover,
.sku-score__card--chart:hover {
  border-color: rgba(63, 113, 141, 0.42);
}

.sku-detail__meta-item--chart:focus-visible,
.sku-score__card--chart:focus-visible {
  outline: 2px solid rgba(63, 113, 141, 0.5);
  outline-offset: 1px;
}

.sku-detail__meta-item--chart.is-chart-active,
.sku-score__card--chart.is-chart-active {
  border-color: rgba(63, 113, 141, 0.55);
  box-shadow: inset 0 0 0 1px rgba(63, 113, 141, 0.24);
}

.sku-detail__chart-icon {
  position: absolute;
  top: 9px;
  right: 9px;
  width: 12px;
  height: 12px;
  color: #a9b6be;
  transition: color 0.16s ease;
}

.sku-detail__meta-item--chart:hover .sku-detail__chart-icon,
.sku-score__card--chart:hover .sku-detail__chart-icon,
.sku-detail__meta-item--chart.is-chart-active .sku-detail__chart-icon,
.sku-score__card--chart.is-chart-active .sku-detail__chart-icon {
  color: #3f718d;
}

/* 6 张基本信息卡在窄屏放不下：3 列两行 */
@media (max-width: 700px) {
  .sku-detail__meta {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

/* 补货建议：需安排与本次补货风险是同一件事，收进同一块。
   头部 = 标题 + 结论（低 / 中 / 高），下面 = 建议补货量 + 三个因子，四张卡等高。
   颜色只落在风险徽标、因子圆点与档位字上：输数字时不会整片闪色。 */
/* 补货风险提示：结论按档位给整块一个色相（--plan-*），输入卡用它做底色与左侧色条；
   因子卡各带自己的圆点色。输数字只换色相与数字，结构不动。 */
.sku-plan {
  --plan-tone: #65737c;
  --plan-tint: #f8fafb;
  --plan-line: rgba(101, 115, 124, 0.22);
  --plan-bar: #b9c4ca;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
  padding: 11px 12px 12px;
  border: 1px solid rgba(63, 113, 141, 0.12);
  border-radius: 10px;
  background: #fbfcfd;
}

.sku-plan--tone-green {
  --plan-tone: #3f7049;
  --plan-tint: #f4f9f5;
  --plan-line: rgba(125, 154, 128, 0.42);
  --plan-bar: #7d9a80;
}

.sku-plan--tone-yellow {
  --plan-tone: #8a6a30;
  --plan-tint: #fdf9f1;
  --plan-line: rgba(196, 154, 82, 0.42);
  --plan-bar: #c49a52;
}

.sku-plan--tone-red {
  --plan-tone: #a8443e;
  --plan-tint: #fdf5f4;
  --plan-line: rgba(184, 79, 72, 0.4);
  --plan-bar: var(--industrial-urgent);
}

.sku-plan__head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.sku-plan__icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  color: var(--industrial-primary);
}

.sku-plan__title {
  flex: 0 0 auto;
  color: #5c6b75;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

/* 结论（低 / 中 / 高）：圆勾 + 文字，颜色跟档位走；依据与建议在 hover 里 */
.sku-plan__risk {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  color: var(--plan-tone);
  font-size: 11.5px;
  font-weight: 700;
  line-height: 16px;
  white-space: nowrap;
  cursor: default;
}

.sku-plan__head .sku-plan__risk {
  margin-left: auto;
}

.sku-plan__risk-icon {
  width: 13px;
  height: 13px;
}

/* 卡片：需安排一张 + 三个因子各一张；四张等高，卡片内部从上到下排 */
.sku-plan__cards {
  display: grid;
  grid-template-columns: minmax(272px, 1.1fr) repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.sku-plan__cards--solo {
  grid-template-columns: minmax(0, 256px);
}

.sku-plan__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid rgba(63, 113, 141, 0.12);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(15, 32, 46, 0.03);
}

/* 需安排卡：底色、左侧色条、描边都跟本次补货风险档位走（参考稿的结论块写法） */
.sku-plan__card--qty {
  position: relative;
  gap: 8px;
  padding-left: 13px;
  border-color: var(--plan-line);
  background: var(--plan-tint);
  overflow: hidden;
  transition:
    background-color 0.24s ease,
    border-color 0.24s ease;
}

.sku-plan__card--qty::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--plan-bar);
  content: '';
  transition: background-color 0.24s ease;
}

.sku-plan__card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 16px;
}

.sku-plan__card-label {
  flex: 0 0 auto;
  color: #7b8994;
  font-size: 11px;
  white-space: nowrap;
}

/* 需安排：标签 + 输入框 + 单位 + 按钮同一行；输入框可伸缩，按钮不换行 */
.sku-plan__qty {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
}

/* 输入框固定 28px：聚焦只加描边与光圈，不改尺寸；锁图标只占已采纳那格 */
.sku-plan__field {
  position: relative;
  display: flex;
  flex: 1 1 68px;
  align-items: center;
  min-width: 62px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 5px;
  background: #fff;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.sku-plan__field:has(.sku-plan__lock) {
  padding-right: 20px;
}

.sku-plan__field:focus-within {
  border-color: var(--industrial-primary);
  box-shadow: 0 0 0 3px rgba(63, 113, 141, 0.12);
}

.sku-plan__input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--industrial-text);
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: left;
  appearance: textfield;
}

.sku-plan__input::-webkit-outer-spin-button,
.sku-plan__input::-webkit-inner-spin-button {
  margin: 0;
  appearance: none;
}

.sku-plan__input::placeholder {
  color: #a9b6be;
  font-size: 12px;
  font-weight: 400;
}

.sku-plan__unit {
  flex: 0 0 auto;
  color: #7b8994;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
}

.sku-plan__lock {
  position: absolute;
  right: 6px;
  width: 11px;
  height: 11px;
  color: #6f8871;
}

.sku-plan__btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid #35647d;
  border-radius: 5px;
  color: #fff;
  background: linear-gradient(180deg, #4c819c, #3a6b86);
  box-shadow:
    0 1px 2px rgba(24, 50, 66, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
  cursor: pointer;
  transition: background 0.16s ease;
}

.sku-plan__btn:hover:not(:disabled) {
  background: linear-gradient(180deg, #568db0, #3f718d);
}

.sku-plan__btn-icon {
  width: 12px;
  height: 12px;
}

.sku-plan__btn:disabled {
  border-color: var(--industrial-grid-light);
  color: #9aa8b1;
  background: #e8edf0;
  box-shadow: none;
  cursor: not-allowed;
}

.sku-plan__btn--ghost {
  border-color: rgba(130, 154, 133, 0.4);
  color: #4c6a50;
  background: #fff;
  box-shadow: none;
}

.sku-plan__btn--ghost:hover:not(:disabled) {
  border-color: #6f8871;
  color: #35543a;
  background: #f5faf6;
}

.sku-plan__badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  margin-left: auto;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(130, 154, 133, 0.18);
  color: #4c6a50;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
}

/* 已采纳：底色仍随风险档位走，只把输入框压成只读态，徽标与「撤销」说明状态 */
.sku-plan--locked .sku-plan__field {
  border-color: rgba(125, 154, 128, 0.42);
  background: rgba(255, 255, 255, 0.72);
}

/* 因子卡：标签一行、值与档位一行；与需安排卡等高，值行贴底对齐 */
.sku-risk__factor {
  justify-content: space-between;
  gap: 6px;
}

.sku-risk__factor-label {
  overflow: hidden;
  color: #7b8994;
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sku-risk__factor-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  margin-top: auto;
}

.sku-risk__factor-value {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  color: var(--industrial-text);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.2px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.sku-risk__factor-unit {
  color: #7b8994;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
}

.sku-risk__factor-tier {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}

.sku-risk__dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--sku-risk-dot, var(--industrial-muted));
  transition: background-color 0.24s ease;
}

.sku-risk__factor--green {
  --sku-risk-dot: #7d9a80;
}

.sku-risk__factor--green .sku-risk__factor-tier {
  color: #4c6a50;
}

.sku-risk__factor--yellow {
  --sku-risk-dot: #c49a52;
}

.sku-risk__factor--yellow .sku-risk__factor-tier {
  color: #9a7636;
}

.sku-risk__factor--purple {
  --sku-risk-dot: #8e7a91;
}

.sku-risk__factor--purple .sku-risk__factor-tier {
  color: #6b5a86;
}

.sku-risk__factor--red {
  --sku-risk-dot: var(--industrial-urgent);
}

.sku-risk__factor--red .sku-risk__factor-tier {
  color: var(--industrial-urgent);
}

/* 浮层：值与口径，写法与健康度卡的浮层一致 */
.sku-risk-tip {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 268px;
  color: var(--industrial-text);
  font-size: 11px;
  line-height: 1.6;
}

.sku-risk-tip__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.sku-risk-tip__flag {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(47, 59, 67, 0.07);
  color: var(--industrial-muted);
  font-size: 10.5px;
  font-weight: 600;
}

.sku-risk-tip__row {
  color: var(--industrial-muted);
}

.sku-risk-tip__row--action {
  color: var(--industrial-text);
  font-weight: 600;
}

/* 计分表：因子 / 档位 / 分，末行合计 —— 结论能自己复核 */
.sku-risk-tip__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.sku-risk-tip__table th {
  padding: 0 0 3px;
  border-bottom: 1px solid rgba(47, 59, 67, 0.12);
  color: #8493a0;
  font-weight: 500;
  text-align: left;
}

.sku-risk-tip__table td {
  padding: 3px 0;
  color: var(--industrial-text);
  white-space: nowrap;
}

.sku-risk-tip__table th.is-num,
.sku-risk-tip__table td.is-num {
  text-align: right;
}

.sku-risk-tip__table .is-plus {
  color: #a8443e;
  font-weight: 600;
}

.sku-risk-tip__table .is-minus {
  color: #4c6a50;
  font-weight: 600;
}

.sku-risk-tip__table .is-zero {
  color: #7b8994;
}

.sku-risk-tip__sum td {
  padding-top: 4px;
  border-top: 1px solid rgba(47, 59, 67, 0.12);
  font-weight: 600;
}

.sku-risk-tip__rule {
  color: #8493a0;
  font-size: 10.5px;
  line-height: 1.5;
}

/* 窄屏：四张卡改两列，需安排卡独占一行 */
@media (max-width: 640px) {
  .sku-plan__cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .sku-plan__card--qty {
    grid-column: 1 / -1;
  }

  .sku-plan__head {
    flex-wrap: wrap;
  }
}

.sku-detail__section {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.2px;
}

/* 月度销量标题行：左标题 + 右图例胶囊。
   自定义图例替代 ECharts 默认图例，既不会和 Y 轴名称挤在一起，
   也保留了「点一下隐藏该序列」的开关能力。 */
.sku-detail__chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}

.sku-detail__chart-head .sku-detail__section {
  min-width: 0;
  margin: 0;
}

/* 图例：跟参考稿一样用「色块 + 同色文字」的轻量写法，不加边框胶囊；
   点一下仍可隐藏该序列，隐藏后整体降透明度。 */
.sku-detail__legend {
  position: relative;
  top: 3px;
  display: flex;
  flex: 0 0 auto;
  gap: 14px;
}

.sku-detail__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #4c5b64;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.2px;
  line-height: 1.65;
  cursor: pointer;
  transition:
    color 0.16s ease,
    opacity 0.16s ease;
}

/* 文字颜色跟序列一致：柱=蓝、累计线=金、比例线=砖红 */
.sku-detail__legend-item:has(.sku-detail__legend-glyph--bar) {
  color: #3f718d;
}

.sku-detail__legend-item:has(.sku-detail__legend-glyph--line) {
  color: #a97f3c;
}

.sku-detail__legend-item:has(.sku-detail__legend-glyph--line-ratio) {
  color: #a8624a;
}

.sku-detail__legend-item:hover {
  color: var(--industrial-text);
}

.sku-detail__legend-item.is-off {
  opacity: 0.42;
}

.sku-detail__legend-item.is-off .sku-detail__legend-glyph {
  filter: grayscale(1);
}

.sku-detail__legend-glyph {
  display: block;
  flex: 0 0 auto;
}

.sku-detail__legend-glyph--bar {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: linear-gradient(180deg, #4c819c, #3f718d);
}

.sku-detail__legend-glyph--line {
  position: relative;
  width: 14px;
  height: 2px;
  border-radius: 1px;
  background: #c49a52;
}

.sku-detail__legend-glyph--line::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 5px;
  height: 5px;
  margin: -2.5px 0 0 -2.5px;
  border-radius: 50%;
  background: #c49a52;
  box-shadow: 0 0 0 1.5px #fbfcfd;
}

/* 比例线（客户CR5率）：砖红色虚线，与金色累计线区分开 */
.sku-detail__legend-glyph--line-ratio {
  width: 14px;
  height: 0;
  border-top: 2px dashed #a8624a;
}

/* 健康度评分：左侧 148px 综合评分竖卡 + 右侧维度小卡（3 列 × 每列 2 张，
   客户 / 销售 / 月份 各占一列）；小卡只留「维度名 + 实测值」，
   档位 / 命中区间 / 权重 / 计算口径全部放到 hover 浮层里。
   按量模式没有综合分，两张判定卡各占一列。 */
.sku-score {
  display: grid;
  grid-template-columns: 148px minmax(0, 1fr);
  gap: 8px;
  margin-bottom: 16px;
  /* 维度名（键）比正文灰阶更深：它是每张卡的主语，不能靠猜 */
  --sku-score-key: #414e57;
}

.sku-score--bulk {
  grid-template-columns: minmax(0, 1fr);
}

.sku-score__tone--red {
  --sku-score-color: var(--industrial-urgent);
  --sku-score-bg: rgba(184, 79, 72, 0.07);
  --sku-score-bg-strong: rgba(184, 79, 72, 0.11);
  --sku-score-border: rgba(184, 79, 72, 0.3);
  --sku-score-bar: rgba(184, 79, 72, 0.85);
  --sku-score-tint: rgba(184, 79, 72, 0.1);
}

.sku-score__tone--yellow {
  --sku-score-color: var(--industrial-replenish);
  --sku-score-bg: rgba(196, 154, 82, 0.08);
  --sku-score-bg-strong: rgba(196, 154, 82, 0.15);
  --sku-score-border: rgba(196, 154, 82, 0.3);
  --sku-score-bar: rgba(196, 154, 82, 0.75);
  --sku-score-tint: rgba(196, 154, 82, 0.12);
}

.sku-score__tone--green {
  --sku-score-color: var(--industrial-normal);
  --sku-score-bg: rgba(130, 154, 133, 0.06);
  --sku-score-bg-strong: rgba(130, 154, 133, 0.12);
  --sku-score-border: rgba(130, 154, 133, 0.26);
  --sku-score-bar: rgba(130, 154, 133, 0.5);
  --sku-score-tint: rgba(130, 154, 133, 0.12);
}

.sku-score__tone--unavailable {
  --sku-score-color: var(--industrial-muted);
  --sku-score-bg: #fafbfc;
  --sku-score-bg-strong: #f7f9fa;
  --sku-score-border: var(--industrial-grid-light);
  --sku-score-bar: #e3e9ed;
  --sku-score-tint: #eef2f5;
}

.sku-score__total {
  display: flex;
  flex-direction: column;
  gap: 3px;
  justify-content: center;
  padding: 12px 13px;
  background: var(--sku-score-bg-strong);
  border: 1px solid var(--sku-score-border);
  border-radius: 8px;
}

.sku-score__total-label {
  color: #5f6b74;
  font-size: 11.5px;
  letter-spacing: 0.2px;
}

.sku-score__total-value {
  color: var(--sku-score-color);
  font-size: 34px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
}

.sku-score__badge {
  align-self: flex-start;
  margin-top: 5px;
  padding: 1px 9px;
  color: #fff;
  background: var(--sku-score-color);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 17px;
}

.sku-score__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  /* 行高下限 60px；窄屏下维度名折行时整行一起长高 */
  grid-template-rows: repeat(2, minmax(60px, auto));
  grid-auto-flow: column;
  gap: 8px;
}

.sku-score--bulk .sku-score__grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(60px, auto);
  grid-auto-flow: row;
}

.sku-score__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: space-between;
  min-width: 0;
  padding: 9px 11px 10px;
  background: var(--sku-score-bg);
  border: 1px solid var(--sku-score-border);
  border-radius: 8px;
}

/* 卡片顶边的 2px 风险条：高风险最重，中 / 低依次变淡 */
.sku-score__card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  border-radius: 8px 8px 0 0;
  background: var(--sku-score-bar);
}

.sku-score__label {
  color: var(--sku-score-key);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.2px;
}

.sku-score__value {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.3px;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.sku-score__tone--unavailable .sku-score__label {
  color: var(--industrial-muted);
}

/* 窄屏（弹窗被压到窗口宽度）时：综合评分卡收窄，6 张卡改 2 列 × 3 行（每行一类），
   更窄时再改成单列，避免维度名被挤成一字一行 */
@media (max-width: 620px) {
  .sku-score {
    grid-template-columns: 118px minmax(0, 1fr);
  }

  .sku-score__total-value {
    font-size: 30px;
  }

  .sku-score__label {
    font-size: 11.5px;
  }

  .sku-score__value {
    font-size: 16px;
    letter-spacing: -0.4px;
  }

  .sku-score__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: none;
    grid-auto-flow: row;
  }

  .sku-score--bulk .sku-score__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 470px) {
  .sku-score,
  .sku-score--bulk {
    grid-template-columns: minmax(0, 1fr);
  }

  .sku-score__grid,
  .sku-score--bulk .sku-score__grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    grid-auto-flow: row;
  }

  .sku-score__total {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
  }

  .sku-score__total-value {
    font-size: 26px;
  }

  .sku-score__badge {
    margin-top: 0;
  }
}

.sku-score__tone--unavailable .sku-score__value {
  color: var(--industrial-muted);
  font-size: 15px;
}

/* hover 浮层：档位 + 命中区间 + 权重 + 计算口径（卡面上不显示这些） */
.sku-score-tip {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-width: 240px;
  color: var(--industrial-text);
  font-size: 11px;
  line-height: 1.6;
}

.sku-score-tip__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.sku-score-tip__flag {
  padding: 0 6px;
  border-radius: 9px;
  background: var(--sku-score-tint, #eef2f5);
  color: var(--sku-score-color, var(--industrial-muted));
  font-size: 10px;
  font-weight: 400;
}

.sku-score-tip__flag--red {
  --sku-score-tint: rgba(184, 79, 72, 0.1);
  --sku-score-color: var(--industrial-urgent);
}

.sku-score-tip__flag--yellow {
  --sku-score-tint: rgba(196, 154, 82, 0.12);
  --sku-score-color: #9a7538;
}

.sku-score-tip__flag--green {
  --sku-score-tint: rgba(130, 154, 133, 0.12);
  --sku-score-color: #5f7a63;
}

.sku-score-tip__flag--unavailable {
  --sku-score-tint: #eef2f5;
  --sku-score-color: var(--industrial-muted);
}

.sku-score-tip__row {
  display: flex;
  gap: 8px;
  justify-content: space-between;
}

.sku-score-tip__row > span:first-child {
  flex: 0 0 auto;
  color: var(--industrial-muted);
}

.sku-score-tip__detail {
  margin-top: 3px;
  padding-top: 4px;
  border-top: 1px dashed var(--industrial-grid-light);
  color: var(--industrial-muted);
}

.sku-detail__chart {
  width: 100%;
  height: 220px;
}

.sku-detail__empty {
  padding: 26px 0;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
  border: 1px dashed rgba(63, 113, 141, 0.22);
  border-radius: 8px;
}

.sku-detail__strategy {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  padding: 10px 12px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
  background: var(--industrial-page);
}

.sku-detail__strategy-radio {
  align-self: flex-start;
}

.sku-detail__strategy-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sku-detail__strategy-label {
  min-width: 32px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.sku-detail__strategy-select {
  width: 160px;
}

.sku-detail__coefficient {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.sku-detail__coefficient-input {
  width: 72px;
}

.sku-detail__strategy-hint {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
}

.sku-detail__strategy-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
