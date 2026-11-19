<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
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
import { useStockingConfigStore } from '@/stores/stocking'
import { createEvaluator, evaluateItem, getAutoModes, getManualModes } from '@/stocking'
import { calculateInventoryRow, getSuggestedPlanned } from '@/utils/inventory'
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
  return `${value.toFixed(2)} 条/月`
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
      const fallback = manualModes.value.find((mode) => mode.behavior === 'custom') ?? manualModes.value[0]
      manualModeDraft.value = fallback?.id ?? ''
      writeCoefficients(fallback?.defaultCoefficients)
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
// 按量模式用专属的两项判定（本次进销比 / 累积客户数），区间取配置页「按量」模式里的设置。
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
const orderedDimensions = computed(() => {
  const dimensions = scoring.value?.dimensions ?? []
  // 按量模式只有两张判定卡，保持「本次进销比 → 累积客户数」的原始顺序。
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
// 建议值与主面板「需安排」占位同一口径：补到正常库存 80% 下限的差额（公斤，精准到个位）。
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

function handlePlannedInput(event) {
  const raw = event.target.value
  const next = raw === '' ? null : Number(raw)
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
// 累积条数：首批清洗结果（销售表「累积条数」列）随动销指标写入行数据。
const cumulativeText = computed(() => {
  const value = props.item?.cumulativeCount
  if (!Number.isFinite(value)) return '--'
  return `${Math.round(value).toLocaleString('zh-CN')} 条`
})

// —— 月度销量统计图 ——
const chartRef = ref(null)
let chart = null

const CHART_SERIES = { sales: '销量(公斤)', count: '条数' }
// 图例开关：销量柱 / 条数折线可各自隐藏，但至少要留一条。
const chartSeries = reactive({ sales: true, count: true })

function toggleChartSeries(key) {
  const other = key === 'sales' ? 'count' : 'sales'
  if (chartSeries[key] && !chartSeries[other]) return
  chartSeries[key] = !chartSeries[key]
  chart?.dispatchAction({ type: 'legendToggleSelect', name: CHART_SERIES[key] })
}

function buildChartOption() {
  return {
    animationDuration: 260,
    textStyle: { color: '#65737c', fontSize: 12 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#f5f7f8',
      borderColor: '#aab6be',
      borderWidth: 1,
      textStyle: { color: '#2f3b43', fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(63, 113, 141, 0.08)' } },
    },
    // 图例交给弹窗标题行的自定义胶囊（见模板），这里只保留开关状态供 dispatchAction 使用。
    legend: {
      show: false,
      data: [CHART_SERIES.sales, CHART_SERIES.count],
      selected: {
        [CHART_SERIES.sales]: chartSeries.sales,
        [CHART_SERIES.count]: chartSeries.count,
      },
    },
    grid: { left: 4, right: 4, top: 14, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: months.value.map((month) => `${month}月`),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#aab6be' } },
      axisLabel: { color: '#65737c', fontSize: 11 },
    },
    yAxis: [
      {
        type: 'value',
        splitLine: { lineStyle: { color: '#e1e6e9' } },
        axisLabel: { color: '#65737c', fontSize: 11 },
      },
      {
        type: 'value',
        splitLine: { show: false },
        axisLabel: { color: '#c49a52', fontSize: 11 },
      },
    ],
    series: [
      {
        name: CHART_SERIES.sales,
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#3f718d', borderRadius: [2, 2, 0, 0] },
        data: salesData.value,
      },
      {
        name: CHART_SERIES.count,
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2 },
        itemStyle: { color: '#c49a52' },
        data: countData.value,
      },
    ],
  }
}

// —— 月度订单数统计图（独立实例，与销量图共用按需加载的 echarts） ——
// 默认折叠：弹窗只显示月度销量图，点箭头才展开订单数图（折叠区用 CSS 高度过渡向下延伸）。
const orderChartExpanded = ref(false)
const orderChartRef = ref(null)
let orderChart = null

function buildOrderChartOption() {
  return {
    animationDuration: 260,
    textStyle: { color: '#65737c', fontSize: 12 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#f5f7f8',
      borderColor: '#aab6be',
      borderWidth: 1,
      textStyle: { color: '#2f3b43', fontSize: 12 },
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(63, 113, 141, 0.08)' } },
    },
    grid: { left: 4, right: 4, top: 24, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: months.value.map((month) => `${month}月`),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#aab6be' } },
      axisLabel: { color: '#65737c', fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      name: '单',
      minInterval: 1,
      nameTextStyle: { color: '#65737c', fontSize: 11 },
      splitLine: { lineStyle: { color: '#e1e6e9' } },
      axisLabel: { color: '#65737c', fontSize: 11 },
    },
    series: [
      {
        name: '订单数',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#829a85', borderRadius: [2, 2, 0, 0] },
        data: orderData.value,
      },
    ],
  }
}

function resizeChart() {
  chart?.resize()
  orderChart?.resize()
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
  if (!hasSalesData.value && !hasOrderData.value) return

  const { init } = await loadEcharts()
  // 加载期间弹窗可能已关闭，此时图表容器已卸载。
  let dirty = false
  if (hasSalesData.value && chartRef.value) {
    if (!chart) chart = init(chartRef.value)
    chart.setOption(buildChartOption(), true)
    dirty = true
  }
  if (hasOrderData.value && orderChartRef.value) {
    if (!orderChart) orderChart = init(orderChartRef.value)
    orderChart.setOption(buildOrderChartOption(), true)
    dirty = true
  }
  if (dirty) window.addEventListener('resize', resizeChart)
}

function disposeChart() {
  window.removeEventListener('resize', resizeChart)
  chart?.dispose()
  chart = null
  orderChart?.dispose()
  orderChart = null
}

async function handleOpened() {
  await nextTick()
  renderChart()
}

// 关闭弹窗时立刻回到折叠态：下次打开直接是紧凑形态，不会看到折叠动画。
// （不依赖 @closed，后台标签页里过渡结束事件可能不触发。）
watch(dialogVisible, (isVisible) => {
  if (!isVisible) orderChartExpanded.value = false
})

// 弹窗打开期间销售表才导入完成、或展开折叠区时，补渲染 / 重算尺寸。
watch(
  [dialogVisible, hasSalesData, hasOrderData, orderChartExpanded],
  ([isVisible, hasData, hasOrders]) => {
    if (!isVisible) return
    if (!hasData && !hasOrders) {
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
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">模式</span>
          <span class="sku-detail__value">{{ evaluated?.modeLabel || '未命中模式' }}</span>
        </div>
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">加权月销量</span>
          <span class="sku-detail__value">{{ monthlySalesText }}</span>
        </div>
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">系数（红 / 正 / 峰）</span>
          <span class="sku-detail__value">{{ coefficientText }}</span>
        </div>
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">累积条数</span>
          <span class="sku-detail__value">{{ cumulativeText }}</span>
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
            <div class="sku-score__card" :class="`sku-score__tone--${dimension.tone}`">
              <span class="sku-score__label">{{ dimension.label }}</span>
              <strong class="sku-score__value">{{ dimension.valueText }}</strong>
            </div>
          </ElTooltip>
        </div>
      </div>

      <!-- 需安排：紧凑一行，放健康度评分下方；采纳不跳转，原地转成「已采纳」锁定态 -->
      <div v-if="plannedEditable" class="sku-plan" :class="{ 'sku-plan--locked': plannedLocked }">
        <span class="sku-plan__label">需安排</span>
        <label class="sku-plan__field">
          <input
            class="sku-plan__input"
            type="number"
            min="0"
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
          <span class="sku-plan__unit">公斤</span>
          <svg v-if="plannedLocked" class="sku-plan__lock" viewBox="0 0 16 16" aria-hidden="true">
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
        <template v-if="plannedLocked">
          <span class="sku-plan__badge">已采纳</span>
          <button type="button" class="sku-plan__btn sku-plan__btn--ghost" @click="undoPlanned()">
            撤销
          </button>
        </template>
        <button
          v-else
          type="button"
          class="sku-plan__btn"
          :disabled="!canAdoptPlanned"
          aria-label="采纳需安排"
          @click="submitPlanned()"
        >
          采纳 <kbd>↵</kbd>
        </button>
      </div>

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
        <h4 class="sku-detail__section">月度销量</h4>
        <div v-if="hasSalesData" class="sku-detail__legend" role="group" aria-label="图表图例">
          <button
            type="button"
            class="sku-detail__legend-item sku-detail__legend-item--sales"
            :class="{ 'is-off': !chartSeries.sales }"
            :aria-pressed="chartSeries.sales"
            @click="toggleChartSeries('sales')"
          >
            <span class="sku-detail__legend-glyph sku-detail__legend-glyph--bar" aria-hidden="true"></span>
            销量(公斤)
          </button>
          <button
            type="button"
            class="sku-detail__legend-item sku-detail__legend-item--count"
            :class="{ 'is-off': !chartSeries.count }"
            :aria-pressed="chartSeries.count"
            @click="toggleChartSeries('count')"
          >
            <span class="sku-detail__legend-glyph sku-detail__legend-glyph--line" aria-hidden="true"></span>
            条数
          </button>
        </div>
      </div>
      <div v-if="hasSalesData" ref="chartRef" class="sku-detail__chart"></div>
      <div v-else class="sku-detail__empty">
        {{
          salesSheet
            ? '销售表中没有该商品的月度数据'
            : '尚未导入销售表，暂无 1-12销量数据'
        }}
      </div>

      <button
        type="button"
        class="sku-detail__collapse"
        :aria-expanded="orderChartExpanded"
        @click="orderChartExpanded = !orderChartExpanded"
      >
        <span class="sku-detail__collapse-line" aria-hidden="true"></span>
        <span class="sku-detail__collapse-label">月度订单数</span>
        <span
          class="sku-detail__collapse-arrow"
          :class="{ 'is-open': orderChartExpanded }"
          aria-hidden="true"
        ></span>
        <span class="sku-detail__collapse-line" aria-hidden="true"></span>
      </button>

      <div class="sku-detail__collapse-body" :class="{ 'is-open': orderChartExpanded }">
        <div class="sku-detail__collapse-inner">
          <div v-if="hasOrderData" ref="orderChartRef" class="sku-detail__chart sku-detail__chart--compact"></div>
          <div v-else class="sku-detail__empty">
            {{
              salesSheet
                ? '销售表未包含“N月订单数”列（用最新清洗脚本重新导出即可）'
                : '尚未导入销售表，暂无月度订单数'
            }}
          </div>
        </div>
      </div>
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
  /* 遮罩变浅后弹窗边界要靠阴影立住 */
  box-shadow:
    0 24px 64px rgba(15, 32, 46, 0.2),
    0 2px 10px rgba(15, 32, 46, 0.08);
  /* 窄屏 / 分屏时收窄宽度，弹窗始终留在视口内 */
  width: min(620px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

/* 内容高于视口时只让正文滚动，标题栏与关闭按钮始终可见；横向不出现滚动条 */
:global(.sku-detail-dialog .el-dialog__body) {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.sku-detail__header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding-right: 0;
}

.sku-detail__close {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  color: var(--industrial-muted);
  background: transparent;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.sku-detail__close:hover {
  color: var(--industrial-text);
  background: var(--industrial-header);
}

.sku-detail__title {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sku-detail__color {
  flex: 0 0 auto;
  padding: 1px 6px;
  color: var(--industrial-primary);
  background: rgba(63, 113, 141, 0.12);
  border-radius: 3px;
  font-size: 12px;
}

.sku-detail__tone {
  flex: 0 0 auto;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  font-size: 12px;
  white-space: nowrap;
}

/* 黑白 SKU：灰阶色调 */
.sku-detail__tone--mono {
  color: #4d565c;
  background: linear-gradient(120deg, #eef1f2, #dbe0e3);
  border-color: rgba(77, 86, 92, 0.24);
}

/* 彩色 SKU：粉 → 紫 → 蓝的彩虹色调 */
.sku-detail__tone--colorful {
  color: #5f3fa0;
  background: linear-gradient(
    90deg,
    rgba(240, 98, 170, 0.42),
    rgba(160, 100, 240, 0.34) 45%,
    rgba(86, 150, 248, 0.42)
  );
  border-color: rgba(150, 92, 236, 0.38);
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
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
  background: var(--industrial-page);
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}

.sku-detail__meta-item {
  padding: 7px 10px;
  background: #fff;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
}

.sku-detail__label {
  display: block;
  color: var(--industrial-muted);
  font-size: 11px;
}

.sku-detail__value {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* 需安排动作条：紧凑一行，放在健康度评分下方。左侧竖色条标出可操作区；
   已采纳后整条转淡绿 + 输入锁定 + 按钮变撤销，与主面板行内状态一致。 */
.sku-plan {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-bottom: 14px;
  padding: 6px 10px 6px 12px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
  background: linear-gradient(180deg, #fbfdfe, #f6f9fa);
}

.sku-plan::before {
  content: '';
  position: absolute;
  top: 5px;
  bottom: 5px;
  left: 0;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: linear-gradient(180deg, #4c819c, #35647d);
}

.sku-plan__label {
  flex: 0 0 auto;
  color: #414e57;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
}

.sku-plan__field {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  width: 118px;
  height: 26px;
  padding: 0 36px 0 8px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
  background: #fff;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease;
}

.sku-plan__field:focus-within {
  border-color: var(--industrial-primary);
  box-shadow: 0 0 0 3px rgba(63, 113, 141, 0.14);
}

.sku-plan__input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--industrial-text);
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
  appearance: textfield;
}

.sku-plan__input::-webkit-outer-spin-button,
.sku-plan__input::-webkit-inner-spin-button {
  margin: 0;
  appearance: none;
}

.sku-plan__input::placeholder {
  color: #a9b6be;
  font-size: 11.5px;
  font-weight: 400;
}

.sku-plan__unit {
  position: absolute;
  right: 8px;
  color: var(--industrial-muted);
  font-size: 10.5px;
  pointer-events: none;
}

.sku-plan__lock {
  position: absolute;
  right: 36px;
  width: 11px;
  height: 11px;
  color: #6f8871;
}

.sku-plan__btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px 0 11px;
  border: 1px solid #35647d;
  border-radius: 3px;
  color: #fff;
  background: linear-gradient(180deg, #4c819c, #35647d);
  box-shadow:
    0 1px 2px rgba(24, 50, 66, 0.28),
    inset 0 1px 0 rgba(255, 255, 255, 0.16);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
}

.sku-plan__btn kbd {
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.2);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
  font-family: inherit;
  font-size: 9.5px;
  line-height: 1;
}

.sku-plan__btn:disabled {
  border-color: var(--industrial-grid-light);
  color: #9aa8b1;
  background: #e8edf0;
  box-shadow: none;
  cursor: not-allowed;
}

.sku-plan__btn:disabled kbd {
  background: rgba(47, 59, 67, 0.06);
  box-shadow: inset 0 0 0 1px rgba(47, 59, 67, 0.08);
}

.sku-plan__btn--ghost {
  padding: 0 10px;
  border-color: var(--industrial-grid);
  color: var(--industrial-muted);
  background: #fff;
  box-shadow: none;
}

.sku-plan__btn--ghost:hover {
  border-color: var(--industrial-primary);
  color: var(--industrial-text);
}

.sku-plan__badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(130, 154, 133, 0.18);
  color: #4c6a50;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 18px;
}

.sku-plan--locked {
  border-color: rgba(130, 154, 133, 0.45);
  background: linear-gradient(180deg, #f8fbf8, #f2f7f3);
}

.sku-plan--locked::before {
  background: linear-gradient(180deg, #93a795, #6f8871);
}

.sku-plan--locked .sku-plan__field {
  width: 132px;
  padding-right: 54px;
  border-color: rgba(130, 154, 133, 0.4);
  background: #f4f7f4;
}

.sku-plan--locked .sku-plan__input {
  color: #4c6a50;
}

.sku-detail__section {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
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

/* 胶囊比标题矮，靠中心对齐时视觉上会偏上，往下压 3px 才和标题落在同一条水平线上 */
.sku-detail__legend {
  position: relative;
  top: 3px;
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.sku-detail__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px 2px 7px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 999px;
  background: #fbfcfd;
  color: #4c5b64;
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.2px;
  line-height: 1.65;
  cursor: pointer;
  transition:
    color 0.16s ease,
    border-color 0.16s ease,
    background-color 0.16s ease,
    opacity 0.16s ease;
}

.sku-detail__legend-item:hover {
  border-color: rgba(63, 113, 141, 0.42);
  background: #ffffff;
  color: var(--industrial-text);
}

.sku-detail__legend-item.is-off {
  border-style: dashed;
  background: transparent;
  opacity: 0.52;
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

/* 健康度评分：左侧 150px 综合评分竖卡 + 右侧维度小卡（3 列 × 每列 2 张，
   客户 / 销售 / 月份 各占一列）；小卡只留「维度名 + 实测值」，
   档位 / 命中区间 / 权重 / 计算口径全部放到 hover 浮层里。
   按量模式没有综合分，两张判定卡各占一列。 */
.sku-score {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 10px;
  margin-bottom: 18px;
  /* 维度名（键）比正文灰阶更深：它是每张卡的主语，不能靠猜 */
  --sku-score-key: #414e57;
}

.sku-score--bulk {
  grid-template-columns: minmax(0, 1fr);
}

.sku-score__tone--red {
  --sku-score-color: var(--industrial-urgent);
  --sku-score-bg: rgba(184, 79, 72, 0.085);
  --sku-score-border: rgba(184, 79, 72, 0.42);
  --sku-score-bar: rgba(184, 79, 72, 0.9);
  --sku-score-tint: rgba(184, 79, 72, 0.1);
}

.sku-score__tone--yellow {
  --sku-score-color: var(--industrial-replenish);
  --sku-score-bg: rgba(196, 154, 82, 0.05);
  --sku-score-border: rgba(196, 154, 82, 0.28);
  --sku-score-bar: rgba(196, 154, 82, 0.7);
  --sku-score-tint: rgba(196, 154, 82, 0.12);
}

.sku-score__tone--green {
  --sku-score-color: var(--industrial-normal);
  --sku-score-bg: rgba(130, 154, 133, 0.042);
  --sku-score-border: rgba(130, 154, 133, 0.24);
  --sku-score-bar: rgba(130, 154, 133, 0.45);
  --sku-score-tint: rgba(130, 154, 133, 0.12);
}

.sku-score__tone--unavailable {
  --sku-score-color: var(--industrial-muted);
  --sku-score-bg: #fafbfc;
  --sku-score-border: var(--industrial-grid-light);
  --sku-score-bar: #e3e9ed;
  --sku-score-tint: #eef2f5;
}

.sku-score__total {
  display: flex;
  flex-direction: column;
  gap: 2px;
  justify-content: center;
  padding: 12px 14px;
  background: var(--sku-score-bg);
  border: 1px solid var(--sku-score-border);
  border-radius: 6px;
}

.sku-score__total-label {
  color: var(--industrial-muted);
  font-size: 11px;
  letter-spacing: 0.5px;
}

.sku-score__total-value {
  color: var(--sku-score-color);
  font-size: 38px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -1px;
  font-variant-numeric: tabular-nums;
}

.sku-score__badge {
  align-self: flex-start;
  margin-top: 6px;
  padding: 1px 8px;
  color: #fff;
  background: var(--sku-score-color);
  border-radius: 10px;
  font-size: 11px;
}

.sku-score__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  /* 行高下限 63px；窄屏下维度名折行时整行一起长高 */
  grid-template-rows: repeat(2, minmax(63px, auto));
  grid-auto-flow: column;
  gap: 8px;
}

.sku-score--bulk .sku-score__grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(63px, auto);
  grid-auto-flow: row;
}

.sku-score__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  justify-content: space-between;
  min-width: 0;
  padding: 9px 9px 10px;
  background: var(--sku-score-bg);
  border: 1px solid var(--sku-score-border);
  border-radius: 6px;
}

/* 卡片顶边的 2px 风险条：高风险最重，中 / 低依次变淡 */
.sku-score__card::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 2px;
  border-radius: 6px 6px 0 0;
  background: var(--sku-score-bar);
}

.sku-score__label {
  color: var(--sku-score-key);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.2px;
}

.sku-score__value {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 19px;
  font-weight: 600;
  line-height: 1;
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

.sku-detail__chart-note {
  margin: 6px 0 0;
  color: var(--industrial-muted);
  font-size: 11px;
  line-height: 1.5;
  text-align: right;
}

.sku-detail__chart--compact {
  height: 180px;
  margin-top: 8px;
}

/* 月度订单数默认折叠：居中的「月度订单数 + 箭头」分隔行，点击展开 */
.sku-detail__collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  margin: 6px 0 0;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: var(--industrial-muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sku-detail__collapse:hover {
  color: var(--industrial-primary);
}

.sku-detail__collapse-line {
  flex: 1 1 auto;
  min-width: 8px;
  height: 0;
  border-top: 1px dashed var(--industrial-grid-light);
}

.sku-detail__collapse-label {
  flex: 0 0 auto;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.sku-detail__collapse-arrow {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg) translateY(-1px);
  transition: transform 0.2s ease;
}

.sku-detail__collapse-arrow.is-open {
  transform: rotate(225deg) translateY(-1px);
}

/* 展开区：grid 行高 0fr → 1fr 过渡，弹窗跟着向下延伸 */
.sku-detail__collapse-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.26s ease;
}

.sku-detail__collapse-body.is-open {
  grid-template-rows: 1fr;
}

.sku-detail__collapse-inner {
  min-height: 0;
  overflow: hidden;
}

.sku-detail__empty {
  padding: 26px 0;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
  border: 1px dashed var(--industrial-grid-light);
  border-radius: 4px;
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
