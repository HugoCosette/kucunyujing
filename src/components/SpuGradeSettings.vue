<script setup>
// SPU 分级设置：摘要 + 编辑弹窗都收在这个组件里，配置页只负责把结果并入草稿。
import { computed, reactive, ref, watch } from 'vue'
import { ElButton, ElDialog, ElInput, ElInputNumber, ElMessage, ElTooltip } from 'element-plus'
import {
  SPU_GRADE_TONES,
  createDefaultSpuGrades,
  describeSpuGradeThresholds,
  normalizeSpuGrades,
  resolveSpuGrade,
  validateSpuGrades,
} from '@/stocking'

const props = defineProps({
  // 当前方案里的 SPU 分级；只读展示，改动通过 apply 事件回传。
  grades: {
    type: Object,
    default: null,
  },
  // 每个 SPU 的月均条数合计：用于预览各等级命中多少个 SPU。
  totals: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['apply'])

function countByTier(totals, grades) {
  const counts = {}
  for (const total of totals) {
    const tier = resolveSpuGrade(total, grades)
    if (!tier) continue
    counts[tier.key] = (counts[tier.key] ?? 0) + 1
  }
  return counts
}

const current = computed(() => normalizeSpuGrades(props.grades))
const currentCounts = computed(() => countByTier(props.totals, current.value))
const currentTotal = computed(() =>
  current.value.tiers.reduce((sum, tier) => sum + (currentCounts.value[tier.key] ?? 0), 0),
)
const summaryRows = computed(() => {
  const thresholds = describeSpuGradeThresholds(current.value)
  return current.value.tiers.map((tier) => ({
    key: tier.key,
    label: tier.label,
    tone: SPU_GRADE_TONES[tier.key] ?? 'gray',
    threshold: thresholds[tier.key],
    count: currentCounts.value[tier.key] ?? 0,
  }))
})

const summaryText = computed(
  () => `${summaryRows.value.length} 档 · 共 ${currentTotal.value} 个 SPU`,
)
const introText =
  '按「该品名下全部 SKU 的月均条数之和」分档，等级显示在主面板品名汇总行的模式列。' +
  '从高到低判定，命中第一条「月均条数 ≥ 下限」的等级；末档兜底，收下所有低于上一档的 SPU。'
const expanded = ref(false)

// —— 编辑弹窗 ——
const dialogVisible = ref(false)
const draft = reactive(normalizeSpuGrades(props.grades))
const draftCounts = computed(() => countByTier(props.totals, normalizeSpuGrades(draft)))

watch(dialogVisible, (visible) => {
  if (!visible) return
  draft.tiers = normalizeSpuGrades(props.grades).tiers
})

function restoreDefaults() {
  draft.tiers = createDefaultSpuGrades().tiers
}

// 末档是兜底档：显示成「低于上一档下限」，不提供输入框。
function fallbackDraftText(index) {
  const previous = draft.tiers[index - 1]
  return Number.isFinite(previous?.minMonthlyAvg) ? `低于 ${previous.minMonthlyAvg} 条` : '兜底'
}

function confirm() {
  const next = normalizeSpuGrades(draft)
  const errors = validateSpuGrades(next)
  if (errors.length) {
    ElMessage.error(errors[0].message)
    return
  }
  emit('apply', next)
  dialogVisible.value = false
}
</script>

<template>
  <section class="config-card" :class="{ 'config-card--open': expanded }">
    <div class="config-card__head">
      <button
        type="button"
        class="config-card__toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span class="config-card__chevron">▾</span>
        <span class="config-card__title">SPU 分级</span>
        <span class="config-card__summary">{{ summaryText }}</span>
      </button>
      <ElTooltip :content="introText" placement="top">
        <span class="config-info">i</span>
      </ElTooltip>
      <span class="config-card__spacer" />
      <ElButton size="small" text class="spu-grade-settings__edit" @click="dialogVisible = true">
        编辑规则
      </ElButton>
    </div>

    <div v-show="expanded" class="config-card__body">
      <p class="spu-grade-settings__summary">
        <span v-for="row in summaryRows" :key="row.key" class="spu-grade-settings__item">
          <span class="spu-grade-settings__chip" :class="`spu-grade-settings__chip--${row.tone}`">
            {{ row.label }}
          </span>
          月均 {{ row.threshold }} 条 · {{ row.count }} 个
        </span>
      </p>
    </div>

    <ElDialog
      v-model="dialogVisible"
      class="spu-grade-settings__dialog"
      width="560px"
      append-to-body
      align-center
      title="SPU 分级"
    >
      <p class="spu-grade-settings__dialog-hint">
        从高到低判定，命中第一条「月均条数 ≥ 下限」的等级；末档兜底，收下所有低于上一档的 SPU。
        月均条数 = 该品名下全部 SKU 的「月均条数」之和（由销售表提供）。
      </p>

      <div class="spu-grade-settings__rows">
        <div v-for="(tier, index) in draft.tiers" :key="tier.key" class="spu-grade-settings__row">
          <ElInput
            v-model="tier.label"
            size="small"
            class="spu-grade-settings__label"
            :aria-label="`等级 ${index + 1} 名称`"
          />
          <span class="spu-grade-settings__operator">月均</span>
          <ElInputNumber
            v-if="index < draft.tiers.length - 1"
            v-model="tier.minMonthlyAvg"
            :min="0"
            :controls="false"
            :value-on-clear="0"
            size="small"
            class="spu-grade-settings__input"
            :aria-label="`${tier.label} 月均条数下限`"
          />
          <span v-else class="spu-grade-settings__fallback">{{ fallbackDraftText(index) }}</span>
          <span class="spu-grade-settings__hit">当前 {{ draftCounts[tier.key] ?? 0 }} 个 SPU</span>
        </div>
      </div>

      <template #footer>
        <div class="spu-grade-settings__footer">
          <ElButton size="small" @click="restoreDefaults">恢复默认</ElButton>
          <span class="spu-grade-settings__spacer" />
          <ElButton size="small" @click="dialogVisible = false">取消</ElButton>
          <ElButton size="small" type="primary" @click="confirm">确定</ElButton>
        </div>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.spu-grade-settings__edit {
  padding: 0;
  color: var(--industrial-primary);
}

.spu-grade-settings__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.7;
}

.spu-grade-settings__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.spu-grade-settings__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.spu-grade-settings__chip--violet {
  color: #6b5a86;
  background: #f4f1f8;
}

.spu-grade-settings__chip--red {
  color: #a64f49;
  background: #faf2f1;
}

.spu-grade-settings__chip--amber {
  color: #8a6a2f;
  background: #faf6ed;
}

.spu-grade-settings__chip--blue {
  color: var(--industrial-primary);
  background: #f1f5f8;
}

.spu-grade-settings__chip--green {
  color: #5b7460;
  background: #f3f7f4;
}

.spu-grade-settings__chip--gray {
  color: var(--industrial-muted);
  background: #f2f5f6;
}

:global(.el-dialog.spu-grade-settings__dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  width: min(560px, calc(100vw - 32px));
}

.spu-grade-settings__dialog-hint {
  margin: 0 0 12px;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.6;
}

.spu-grade-settings__rows {
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
}

.spu-grade-settings__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--industrial-grid-light);
  font-size: 12px;
}

.spu-grade-settings__row:last-child {
  border-bottom: 0;
}

.spu-grade-settings__label {
  width: 84px;
}

.spu-grade-settings__operator,
.spu-grade-settings__fallback {
  color: var(--industrial-muted);
}

.spu-grade-settings__input {
  width: 96px;
}

.spu-grade-settings__hit {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 11px;
}

.spu-grade-settings__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spu-grade-settings__spacer {
  flex: 1 1 auto;
}
</style>
