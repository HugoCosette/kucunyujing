<script setup>
import { computed } from 'vue'
import { ElButton, ElDialog } from 'element-plus'
import { HEAT_FACTOR_FIELDS } from '@/data/quantityFields'

// 主面板唯一入口：一次导入总表 + 销售表，两者缺一不可。
const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
  summary: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['update:modelValue', 'confirm', 'cancel'])

const metricLabelOf = (field) =>
  HEAT_FACTOR_FIELDS.find((entry) => entry.field === field)?.label ?? field

const salesMetricText = computed(() => {
  const fields = props.summary?.sales?.metricFields ?? []
  return fields.length ? fields.map(metricLabelOf).join(' / ') : '未包含（评分因子记 Z）'
})

const canConfirm = computed(
  () => Boolean(props.summary?.inventory) && Boolean(props.summary?.sales),
)

function closeDialog() {
  emit('update:modelValue', false)
  emit('cancel')
}
</script>

<template>
  <ElDialog
    :model-value="modelValue"
    title="导入总表与销售表"
    width="680px"
    class="import-sources-dialog"
    :close-on-click-modal="false"
    @update:model-value="(value) => emit('update:modelValue', value)"
    @closed="emit('cancel')"
  >
    <template v-if="summary">
      <p class="import-sources__tip">
        必须一次选择两个文件：总表（库存与出库数据）与销售表（动销指标 + 1-12 月条数/重量）。两个文件都按“唯一标识”关联同一个 SKU，缺一个都不能导入。
      </p>

      <section v-if="summary.inventory" class="import-sources__section">
        <h4 class="import-sources__title">
          总表<span class="import-sources__badge">库存数据</span>
        </h4>
        <ul class="import-sources__list">
          <li>文件：{{ summary.inventory.fileName }}</li>
          <li>工作表：{{ summary.inventory.sheetName }}</li>
          <li>有效数据：{{ summary.inventory.items.length }} 行</li>
          <li v-if="summary.inventory.errors.length">
            跳过：{{ summary.inventory.errors.length }} 行（数据有误）
          </li>
          <li v-if="summary.inventory.blankRows">
            忽略空行：{{ summary.inventory.blankRows }} 行
          </li>
          <li v-if="summary.inventory.ignoredPlannedRows">
            忽略“需安排”列：{{ summary.inventory.ignoredPlannedRows }} 行有值，需安排以面板内采纳结果为准
          </li>
          <li v-if="summary.inventory.ignoredHeatRows">
            忽略“评分档”列（旧模板为“热度”）：{{ summary.inventory.ignoredHeatRows }} 行有值，评分档按备货配置计算
          </li>
          <li v-if="summary.inventory.ignoredMetricRows">
            忽略“动销指标”列：{{ summary.inventory.ignoredMetricRows }} 行有值，动销指标以销售表为准
          </li>
        </ul>
        <div v-if="summary.inventory.errors.length" class="import-sources__errors">
          <p class="import-sources__errors-title">以下行不会导入，请修正后重新导入：</p>
          <ul>
            <li
              v-for="error in summary.inventory.errors"
              :key="`${error.row}-${error.message}`"
            >
              第 {{ error.row }} 行：{{ error.message }}
            </li>
          </ul>
        </div>
      </section>

      <section v-if="summary.sales" class="import-sources__section">
        <h4 class="import-sources__title">
          销售表<span class="import-sources__badge">1-12 月 + 动销指标</span>
        </h4>
        <ul class="import-sources__list">
          <li>文件：{{ summary.sales.fileName }}</li>
          <li>工作表：{{ summary.sales.sheetName }}</li>
          <li>
            识别月份列：{{ summary.sales.months.length }} 个月<template
              v-if="summary.sales.months.length"
              >（{{ summary.sales.months[0] }}-{{
                summary.sales.months[summary.sales.months.length - 1]
              }}月）</template
            >
          </li>
          <li>动销指标列：{{ salesMetricText }}</li>
          <li>匹配总表：{{ summary.sales.merge.matched }} 个SKU</li>
          <li v-if="summary.sales.merge.unmatched">
            跳过未匹配：{{ summary.sales.merge.unmatched }} 行（总表没有对应的唯一标识，如：{{
              summary.sales.merge.unmatchedSamples.join('、')
            }}）
          </li>
          <li v-if="summary.sales.errors.length">
            跳过：{{ summary.sales.errors.length }} 行（数据有误）
          </li>
          <li v-if="summary.sales.blankRows">
            忽略空行：{{ summary.sales.blankRows }} 行
          </li>
        </ul>
        <div v-if="summary.sales.errors.length" class="import-sources__errors">
          <p class="import-sources__errors-title">以下行不会导入，请修正后重新导入：</p>
          <ul>
            <li v-for="error in summary.sales.errors" :key="`${error.row}-${error.message}`">
              第 {{ error.row }} 行：{{ error.message }}
            </li>
          </ul>
        </div>
      </section>

      <section v-if="summary.problems?.length" class="import-sources__section">
        <h4 class="import-sources__title">未导入的文件</h4>
        <ul class="import-sources__problems">
          <li v-for="problem in summary.problems" :key="problem.fileName + problem.message">
            {{ problem.fileName }}：{{ problem.message }}
          </li>
        </ul>
      </section>

      <p class="import-sources__hint">
        确认后：总表整表替换主面板库存行（需安排、撤销记录与采购清单按唯一标识保留）；销售表的动销指标写入对应 SKU，1-12
        月条数与重量叠加到销售表页；随后按备货配置重算模式、评分档与系数。理论库存、预警、缺口量、缺口率、库销比仍由系统计算。
      </p>
    </template>

    <template #footer>
      <div class="import-sources__footer">
        <ElButton @click="closeDialog">取消</ElButton>
        <ElButton type="primary" :disabled="!canConfirm" @click="emit('confirm')">
          确认导入
        </ElButton>
      </div>
    </template>
  </ElDialog>
</template>

<style scoped>
.import-sources__tip {
  margin: 0 0 12px;
  padding: 8px 10px;
  color: var(--industrial-text);
  background: var(--industrial-header);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.7;
}

.import-sources__section {
  margin-bottom: 12px;
}

.import-sources__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.import-sources__badge {
  padding: 1px 8px;
  color: var(--industrial-primary);
  background: var(--industrial-header);
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

.import-sources__list {
  margin: 0;
  padding-left: 18px;
  color: var(--industrial-text);
  font-size: 13px;
  line-height: 1.8;
}

.import-sources__problems {
  margin: 0;
  padding-left: 18px;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.7;
}

.import-sources__errors {
  max-height: 140px;
  margin-top: 6px;
  padding: 8px 10px;
  overflow: auto;
  color: var(--industrial-out-of-stock, #b44242);
  background: rgba(180, 66, 66, 0.06);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.7;
}

.import-sources__errors-title {
  margin: 0 0 4px;
  font-weight: 600;
}

.import-sources__errors ul {
  margin: 0;
  padding-left: 16px;
}

.import-sources__hint {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.7;
}

.import-sources__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
