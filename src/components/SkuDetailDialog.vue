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
import { createEvaluator, evaluateItem, getManualModes } from '@/stocking'

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

// 模式 / 评分档 / 因子等级全部按当前配置现算，与主面板、配置页同一套口径。
const evaluated = computed(() =>
  props.item
    ? evaluateItem(props.item, createEvaluator(stockingStore.config, { manualOverrides: stockingStore.manualOverrides }))
    : null,
)
const gradeDetails = computed(() => evaluated.value?.gradeDetails ?? [])
const coefficients = computed(() => {
  const set = evaluated.value?.stockingCoefficients
  return props.item?.category ? set?.[props.item.category] ?? null : null
})
const coefficientText = computed(() => {
  if (evaluated.value?.strategySlow) return '滞销'
  return coefficients.value
    ? `${coefficients.value.redLine} / ${coefficients.value.normal} / ${coefficients.value.peak}`
    : '缺省'
})
const productText = computed(() => String(props.item?.product ?? '').replace(/\s+/g, ' ').trim())
// 色彩标签分灰阶 / 彩色两种色调，与导入时的「黑白 / 彩色」口径保持一致。
const monochrome = computed(() => String(props.item?.category ?? '').includes('黑白'))

// —— 策略：自动（按模式 + 评分档）/ 手动（自定系数 / 滞销）——
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

// 切到「自定模式」时，系数输入框默认填该模式的默认系数。
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
const countData = computed(() =>
  months.value.map((month) => salesOfSku.value?.counts?.[month - 1] ?? null),
)
const weightData = computed(() =>
  months.value.map((month) => salesOfSku.value?.weights?.[month - 1] ?? null),
)
const orderData = computed(() =>
  months.value.map((month) => salesOfSku.value?.orders?.[month - 1] ?? null),
)
const hasSalesData = computed(
  () =>
    months.value.length > 0 &&
    (countData.value.some((value) => value !== null) ||
      weightData.value.some((value) => value !== null)),
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

function formatFactorValue(detail) {
  const value = detail.value
  if (value === null || value === undefined || value === '') return '--'
  if (typeof value !== 'number') return String(value)
  if (!Number.isFinite(value)) return '--'
  return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toFixed(2)
}

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
        name: '条数',
        nameTextStyle: { color: '#65737c', fontSize: 11 },
        splitLine: { lineStyle: { color: '#e1e6e9' } },
        axisLabel: { color: '#65737c', fontSize: 11 },
      },
      {
        type: 'value',
        name: '重量',
        nameTextStyle: { color: '#c49a52', fontSize: 11 },
        splitLine: { show: false },
        axisLabel: { color: '#c49a52', fontSize: 11 },
      },
    ],
    series: [
      {
        name: '条数',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#3f718d', borderRadius: [2, 2, 0, 0] },
        data: countData.value,
      },
      {
        name: '重量',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 5,
        lineStyle: { width: 2 },
        itemStyle: { color: '#c49a52' },
        data: weightData.value,
      },
    ],
  }
}

// —— 月度订单数统计图（独立实例，与销量图共用按需加载的 echarts） ——
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

// 弹窗打开期间销售表才导入完成时，补渲染一次。
watch([dialogVisible, hasSalesData, hasOrderData], ([isVisible, hasData, hasOrders]) => {
  if (!isVisible) return
  if (!hasData && !hasOrders) {
    disposeChart()
    return
  }
  nextTick(renderChart)
})

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
          <span class="sku-detail__value">
            {{ evaluated?.strategy === 'manual' ? `手动·${evaluated?.ruleName}` : evaluated?.ruleName || '未命中模式' }}
          </span>
        </div>
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">评分档</span>
          <span class="sku-detail__value">{{ evaluated?.strategySlow ? '滞销' : evaluated?.tierName || '--' }}</span>
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
        评分因子
        <span v-if="evaluated?.gradeSummary" class="sku-detail__section-hint">
          等级明细 {{ evaluated.gradeSummary }}
        </span>
      </h4>
      <div v-if="gradeDetails.length" class="sku-factor-row">
        <div
          v-for="detail in gradeDetails"
          :key="detail.field"
          class="sku-factor"
          :class="`sku-factor--${detail.grade.toLowerCase()}`"
          :title="`${detail.label}：${formatFactorValue(detail)} → ${detail.grade}`"
        >
          <span class="sku-factor__label">{{ detail.label }}</span>
          <strong class="sku-factor__grade">{{ detail.grade }}</strong>
          <span class="sku-factor__value">{{ formatFactorValue(detail) }}</span>
        </div>
      </div>
      <div v-else class="sku-detail__empty">当前模式没有配置评分因子</div>

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

      <h4 class="sku-detail__section">
        月度订单数
        <span v-if="months.length" class="sku-detail__section-hint">
          销售表 {{ months[0] }}-{{ months[months.length - 1] }}月
        </span>
      </h4>
      <div v-if="hasOrderData" ref="orderChartRef" class="sku-detail__chart sku-detail__chart--compact"></div>
      <div v-else class="sku-detail__empty">
        {{
          salesSheet
            ? '销售表未包含“N月订单数”列（用最新清洗脚本重新导出即可）'
            : '尚未导入销售表，暂无月度订单数'
        }}
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

/* 内容高于视口时只让正文滚动，标题栏与关闭按钮始终可见 */
:global(.sku-detail-dialog .el-dialog__body) {
  min-height: 0;
  overflow: auto;
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

.sku-factor-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}

.sku-factor {
  display: flex;
  flex: 1 1 96px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 96px;
  padding: 10px 8px 8px;
  background: #fff;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 6px;
}

.sku-factor__label {
  overflow: hidden;
  max-width: 100%;
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sku-factor__grade {
  font-size: 34px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 1px;
}

.sku-factor__value {
  color: var(--industrial-muted);
  font-size: 11px;
}

.sku-factor--s {
  color: var(--industrial-urgent);
  border-color: rgba(184, 79, 72, 0.45);
  background: rgba(184, 79, 72, 0.07);
}

.sku-factor--a {
  color: var(--industrial-replenish);
  border-color: rgba(196, 154, 82, 0.5);
  background: rgba(196, 154, 82, 0.08);
}

.sku-factor--b {
  color: var(--industrial-primary);
  border-color: rgba(63, 113, 141, 0.45);
  background: rgba(63, 113, 141, 0.07);
}

.sku-factor--c {
  color: var(--industrial-normal);
  border-color: rgba(130, 154, 133, 0.5);
  background: rgba(130, 154, 133, 0.08);
}

.sku-factor--z {
  color: var(--industrial-muted);
  background: #f0f3f5;
}

.sku-detail__chart {
  width: 100%;
  height: 220px;
}

.sku-detail__chart--compact {
  height: 180px;
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
