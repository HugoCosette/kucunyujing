<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElDialog } from 'element-plus'
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { useStockingConfigStore } from '@/stores/stocking'
import { createEvaluator, evaluateItem } from '@/stocking'

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

// 模式 / 热度档 / 因子等级全部按当前配置现算，与主面板、配置页同一套口径。
const evaluated = computed(() =>
  props.item ? evaluateItem(props.item, createEvaluator(stockingStore.config)) : null,
)
const gradeDetails = computed(() => evaluated.value?.gradeDetails ?? [])
const coefficients = computed(() => {
  const set = evaluated.value?.stockingCoefficients
  return props.item?.category ? set?.[props.item.category] ?? null : null
})
const coefficientText = computed(() =>
  coefficients.value
    ? `${coefficients.value.redLine} / ${coefficients.value.normal} / ${coefficients.value.peak}`
    : '缺省',
)
const productText = computed(() => String(props.item?.product ?? '').replace(/\s+/g, ' ').trim())

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
const hasSalesData = computed(
  () =>
    months.value.length > 0 &&
    (countData.value.some((value) => value !== null) ||
      weightData.value.some((value) => value !== null)),
)

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

function resizeChart() {
  chart?.resize()
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
  if (!hasSalesData.value) return

  const { init } = await loadEcharts()
  // 加载期间弹窗可能已关闭，此时图表容器已卸载。
  if (!chartRef.value) return
  if (!chart) {
    chart = init(chartRef.value)
    window.addEventListener('resize', resizeChart)
  }
  chart.setOption(buildChartOption(), true)
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

// 弹窗打开期间销售表才导入完成时，补渲染一次。
watch([dialogVisible, hasSalesData], ([isVisible, hasData]) => {
  if (!isVisible) return
  if (!hasData) {
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
    @opened="handleOpened"
    @closed="handleClosed"
  >
    <template #header>
      <div class="sku-detail__header">
        <span class="sku-detail__title" :title="productText">{{ productText }}</span>
        <span v-if="item?.color" class="sku-detail__color">{{ item.color }}</span>
      </div>
    </template>

    <div v-if="item" class="sku-detail">
      <div class="sku-detail__meta">
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">模式</span>
          <span class="sku-detail__value">{{ evaluated?.ruleName || '未命中模式' }}</span>
        </div>
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">热度</span>
          <span class="sku-detail__value">{{ evaluated?.tierName || '--' }}</span>
        </div>
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">色彩</span>
          <span class="sku-detail__value">{{ item.category || '--' }}</span>
        </div>
        <div class="sku-detail__meta-item">
          <span class="sku-detail__label">系数（红 / 正 / 峰）</span>
          <span class="sku-detail__value">{{ coefficientText }}</span>
        </div>
      </div>

      <h4 class="sku-detail__section">
        热度因子评分
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
      <div v-else class="sku-detail__empty">当前模式没有配置热度因子</div>

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
            : '尚未导入销售表，暂无 1-12 月销量数据'
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
  padding-right: 24px;
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

.sku-detail__meta {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
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

.sku-detail__empty {
  padding: 26px 0;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
  border: 1px dashed var(--industrial-grid-light);
  border-radius: 4px;
}
</style>
