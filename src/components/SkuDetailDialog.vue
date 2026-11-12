<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  ElButton,
  ElDialog,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
} from 'element-plus'
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { useStockingConfigStore } from '@/stores/stocking'
import { createEvaluator, evaluateItem, getAutoModes, getManualModes } from '@/stocking'
import { calculateInventoryRow } from '@/utils/inventory'
import { evaluateRowHealth } from '@/utils/skuHealth'

const props = defineProps({
  // 传主面板行或原始 SKU 行都行：评估只读取因子字段，不依赖派生值。
  item: {
    type: Object,
    default: null,
  },
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
  // 受控显隐：弹窗统一挂在页面层级，由表格行的入口按钮驱动。
  visible: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:visible'])

const inventoryStore = useInventoryStore(props.panelKey)
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
    if (row.manualBehavior === 'exclude') return '已排除：不参与备货'
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

// —— 策略：自动（按模式判定）/ 手动（自定系数 / 排除）——
const manualModes = computed(() => getManualModes(stockingStore.config))
const skuId = computed(() => String(props.item?.skuId ?? '').trim())
const savedEntry = computed(() => (skuId.value ? stockingStore.manualOverrides.get(skuId.value) ?? null : null))
const strategyDraft = ref('auto')
const manualModeDraft = ref('')
const customCoefficients = reactive({ redLine: null, normal: null, peak: null })
const savingManual = ref(false)

const selectedManualMode = computed(
  () => manualModes.value.find((mode) => mode.id === manualModeDraft.value) ?? null,
)
const isCustomMode = computed(() => selectedManualMode.value?.behavior === 'custom')

const manualDirty = computed(() => {
  if (strategyDraft.value !== 'manual') return Boolean(savedEntry.value)
  if (!manualModeDraft.value) return false
  if (savedEntry.value?.modeId !== manualModeDraft.value) return true
  if (!isCustomMode.value) return false
  const current = savedEntry.value?.coefficients ?? null
  return (
    !current ||
    current.redLine !== customCoefficients.redLine ||
    current.normal !== customCoefficients.normal ||
    current.peak !== customCoefficients.peak
  )
})

// 打开弹窗或切换 SKU 时，用已保存的手动设置回填表单。
function syncStrategyDraft() {
  const entry = savedEntry.value
  if (!entry) {
    strategyDraft.value = 'auto'
    const fallback = manualModes.value.find((mode) => mode.behavior === 'custom') ?? manualModes.value[0]
    manualModeDraft.value = fallback?.id ?? ''
    const defaults = fallback?.defaultCoefficients ?? { redLine: null, normal: null, peak: null }
    customCoefficients.redLine = defaults.redLine ?? null
    customCoefficients.normal = defaults.normal ?? null
    customCoefficients.peak = defaults.peak ?? null
    return
  }

  strategyDraft.value = 'manual'
  manualModeDraft.value = entry.modeId
  const mode = manualModes.value.find((item) => item.id === entry.modeId)
  const coefficients = entry.coefficients ?? mode?.defaultCoefficients ?? {}
  customCoefficients.redLine = coefficients.redLine ?? null
  customCoefficients.normal = coefficients.normal ?? null
  customCoefficients.peak = coefficients.peak ?? null
}

watch([dialogVisible, skuId, manualModes], ([isVisible]) => {
  if (!isVisible) return
  syncStrategyDraft()
}, { immediate: true })

// 切到「自定系数模式」时默认填该模式的默认系数。
watch(manualModeDraft, () => {
  if (strategyDraft.value !== 'manual' || !isCustomMode.value) return
  if (customCoefficients.redLine !== null) return
  const defaults = selectedManualMode.value?.defaultCoefficients ?? {}
  customCoefficients.redLine = defaults.redLine ?? null
  customCoefficients.normal = defaults.normal ?? null
  customCoefficients.peak = defaults.peak ?? null
})

async function saveStrategy() {
  if (!skuId.value) return
  savingManual.value = true
  try {
    if (strategyDraft.value === 'auto') {
      await stockingStore.setManualEntry(skuId.value, null)
      ElMessage.success('已恢复自动策略')
      syncStrategyDraft()
      return
    }

    const mode = selectedManualMode.value
    if (!mode) {
      ElMessage.error('请选择手动模式')
      return
    }

    const entry = { modeId: mode.id }
    if (mode.behavior === 'custom') {
      const values = [customCoefficients.redLine, customCoefficients.normal, customCoefficients.peak]
      if (!values.every((value) => Number.isFinite(value))) {
        ElMessage.error('请填写完整的红线 / 正常 / 峰值系数')
        return
      }
      if (values.some((value) => value < 0)) {
        ElMessage.error('系数不能为负数')
        return
      }
      if (!(values[0] <= values[1] && values[1] <= values[2])) {
        ElMessage.error('系数需满足 红线 ≤ 正常 ≤ 峰值')
        return
      }
      entry.coefficients = {
        redLine: values[0],
        normal: values[1],
        peak: values[2],
      }
    }

    await stockingStore.setManualEntry(skuId.value, entry)
    ElMessage.success(`已设为「${mode.name}」`)
    syncStrategyDraft()
  } finally {
    savingManual.value = false
  }
}

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
function scoringDimensionTitle(dimension) {
  if (!dimension.available) return dimension.detail
  const rule = dimension.tierRangeText ?? dimension.ruleText
  return `${dimension.detail}；命中${dimension.tierLabel}（${rule}）`
}
const salesData = computed(() =>
  months.value.map((month) => salesOfSku.value?.sales?.[month - 1] ?? null),
)
const countData = computed(() =>
  months.value.map((month) => salesOfSku.value?.counts?.[month - 1] ?? null),
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
    legend: {
      top: 0,
      right: 0,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { color: '#65737c', fontSize: 12 },
    },
    grid: { left: 4, right: 4, top: 30, bottom: 0, containLabel: true },
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
        name: '销量(公斤)',
        nameTextStyle: { color: '#65737c', fontSize: 11 },
        splitLine: { lineStyle: { color: '#e1e6e9' } },
        axisLabel: { color: '#65737c', fontSize: 11 },
      },
      {
        type: 'value',
        name: '条数',
        nameTextStyle: { color: '#c49a52', fontSize: 11 },
        splitLine: { show: false },
        axisLabel: { color: '#c49a52', fontSize: 11 },
      },
    ],
    series: [
      {
        name: '销量(公斤)',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#3f718d', borderRadius: [2, 2, 0, 0] },
        data: salesData.value,
      },
      {
        name: '条数',
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

      <h4 class="sku-detail__section">
        健康度评分
        <span v-if="scoring?.participates" class="sku-detail__section-hint">
          {{
            scoring.mode === 'bulk'
              ? '按量模式 · 2 项判定'
              : `5 维加权 · 参与权重 ${scoring.weightTotal}%`
          }}
        </span>
      </h4>
      <div v-if="scoring && !scoring.participates" class="sku-detail__empty">
        该 SKU 不参与备货计算，不做健康度评分
      </div>
      <div v-else-if="scoring" class="sku-score">
        <div
          v-if="scoring.mode !== 'bulk'"
          class="sku-score__total"
          :class="`sku-score__tone--${scoring.tone}`"
        >
          <span class="sku-score__total-label">综合评分</span>
          <strong class="sku-score__total-value">{{ scoring.totalText }}</strong>
          <span class="sku-score__badge">{{ scoring.toneLabel }}</span>
          <span v-if="scoring.missing" class="sku-score__total-hint">
            {{ scoring.missing }} 项无数据，按其余维度权重折算
          </span>
        </div>
        <div class="sku-score__grid" :class="{ 'sku-score__grid--bulk': scoring.mode === 'bulk' }">
          <div
            v-for="dimension in scoring.dimensions"
            :key="dimension.key"
            class="sku-score__card"
            :class="`sku-score__tone--${dimension.tone}`"
            :title="scoringDimensionTitle(dimension)"
          >
            <span class="sku-score__label">{{ dimension.label }}</span>
            <div class="sku-score__main">
              <strong class="sku-score__score">
                {{ scoring.mode === 'bulk' ? dimension.valueText : dimension.scoreText }}
              </strong>
              <span class="sku-score__tier">{{ dimension.tierLabel }}</span>
            </div>
            <span v-if="scoring.mode === 'bulk'" class="sku-score__rule">{{ dimension.ruleText }}</span>
            <template v-else>
              <span class="sku-score__value">{{ dimension.valueText }}</span>
              <span class="sku-score__weight">权重 {{ dimension.weightText }}</span>
            </template>
          </div>
        </div>
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
              />
            </label>
          </div>

          <div class="sku-detail__manual-actions">
            <ElButton
              size="small"
              type="primary"
              :disabled="!manualDirty"
              :loading="savingManual"
              @click="saveStrategy"
            >
              保存策略
            </ElButton>
          </div>
        </div>
      </template>

      <h4 class="sku-detail__section">
        月度销量
        <span v-if="months.length" class="sku-detail__section-hint">
          销售表 {{ months[0] }}-{{ months[months.length - 1] }}月
        </span>
      </h4>
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
:global(.el-dialog.sku-detail-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
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
  justify-content: flex-end;
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

.sku-detail__section {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
}

.sku-detail__section-hint {
  color: var(--industrial-muted);
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 1px;
}

/* 健康度评分：5 张维度小卡 + 1 条综合评分，红 / 黄 / 绿三档背景；
   按量模式改为 2 张判定卡（本次进销比 / 累积客户数），不显示综合评分 */
.sku-score {
  margin-bottom: 18px;
}

.sku-score__tone--red {
  --sku-score-color: var(--industrial-urgent);
  --sku-score-bg: rgba(184, 79, 72, 0.08);
  --sku-score-border: rgba(184, 79, 72, 0.4);
}

.sku-score__tone--yellow {
  --sku-score-color: var(--industrial-replenish);
  --sku-score-bg: rgba(196, 154, 82, 0.1);
  --sku-score-border: rgba(196, 154, 82, 0.45);
}

.sku-score__tone--green {
  --sku-score-color: var(--industrial-normal);
  --sku-score-bg: rgba(130, 154, 133, 0.1);
  --sku-score-border: rgba(130, 154, 133, 0.45);
}

.sku-score__tone--unavailable {
  --sku-score-color: var(--industrial-muted);
  --sku-score-bg: #f0f3f5;
  --sku-score-border: var(--industrial-grid-light);
}

.sku-score__total {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
  padding: 9px 12px;
  color: var(--sku-score-color);
  background: var(--sku-score-bg);
  border: 1px solid var(--sku-score-border);
  border-radius: 6px;
}

.sku-score__total-label {
  color: var(--industrial-muted);
  font-size: 12px;
}

.sku-score__total-value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
}

.sku-score__badge {
  padding: 1px 8px;
  color: #fff;
  background: var(--sku-score-color);
  border-radius: 10px;
  font-size: 11px;
}

.sku-score__total-hint {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 11px;
}

.sku-score__grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}

.sku-score__grid--bulk {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.sku-score__card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px;
  color: var(--sku-score-color);
  background: var(--sku-score-bg);
  border: 1px solid var(--sku-score-border);
  border-radius: 6px;
}

.sku-score__label {
  overflow: hidden;
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sku-score__main {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.sku-score__score {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.1;
}

.sku-score__tier {
  font-size: 11px;
}

.sku-score__value {
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sku-score__weight {
  color: var(--industrial-muted);
  font-size: 10px;
}

/* 按量模式的判定规则文案（低于 40% 低风险 / 40% ~ 60% 正常 / 高于 60% 高风险 …） */
.sku-score__rule {
  color: var(--industrial-muted);
  font-size: 10px;
  line-height: 1.4;
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
