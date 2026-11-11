<script setup>
// 评分设置：摘要 + 编辑弹窗都收在这个组件里，配置页只负责把结果并入草稿。
import { computed, reactive, ref, watch } from 'vue'
import { ElButton, ElDialog, ElInputNumber, ElMessage, ElTooltip } from 'element-plus'
import {
  SCORING_DIMENSIONS,
  SCORING_TIERS,
  SCORING_TIER_LABELS,
  SCORING_TIER_TONES,
  createDefaultScoring,
  describeScoringBand,
  normalizeScoring,
  validateScoring,
} from '@/stocking'

const props = defineProps({
  // 当前方案里的评分配置；只读展示，改动通过 apply 事件回传。
  scoring: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['apply'])

const current = computed(() => normalizeScoring(props.scoring))
const weightTotalText = computed(() =>
  String(
    Math.round(
      SCORING_DIMENSIONS.reduce((sum, definition) => sum + current.value.dimensions[definition.key].weight, 0) * 100,
    ) / 100,
  ),
)
// 每个维度一行、每档一列：比连成一整段的说明更容易扫读。
const rows = computed(() =>
  SCORING_DIMENSIONS.map((definition) => {
    const entry = current.value.dimensions[definition.key]
    return {
      key: definition.key,
      label: definition.label,
      weightText: `${Math.round(entry.weight * 100) / 100}%`,
      bands: SCORING_TIERS.map((tier) => ({
        key: tier,
        tone: SCORING_TIER_TONES[tier],
        text: describeScoringBand(entry.ranges[tier], definition),
      })),
    }
  }),
)
const totalText = computed(
  () =>
    `${current.value.total.midFrom ?? '不限'} ~ ${current.value.total.midTo ?? '不限'} 分`,
)
const summaryText = computed(
  () => `权重合计 ${weightTotalText.value}% · ${totalText.value}为中风险`,
)
const introText =
  'SKU 弹窗里的 5 维健康度评分：每个维度各配低 / 中 / 高三条风险区间，命中哪条就取对应得分，再按权重加权。' +
  '综合评分落在中风险区间视为正常，高于为绿、低于为红；区间两端都包含，端点留空表示不限。'
const expanded = ref(false)

// —— 编辑弹窗 ——
const dialogVisible = ref(false)
const draft = reactive(normalizeScoring(props.scoring))

watch(dialogVisible, (visible) => {
  if (!visible) return
  const next = normalizeScoring(props.scoring)
  draft.scores = { ...next.scores }
  draft.total = { ...next.total }
  draft.dimensions = next.dimensions
})

const draftRows = computed(() =>
  SCORING_DIMENSIONS.map((definition) => ({
    ...definition,
    entry: draft.dimensions[definition.key],
  })),
)

const tierRows = SCORING_TIERS.map((tier) => ({
  key: tier,
  label: SCORING_TIER_LABELS[tier],
  tone: tier,
}))

function restoreDefaults() {
  const defaults = createDefaultScoring()
  draft.scores = { ...defaults.scores }
  draft.total = { ...defaults.total }
  draft.dimensions = defaults.dimensions
}

function confirm() {
  const next = normalizeScoring(draft)
  const errors = validateScoring(next)
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
        <span class="config-card__title">评分设置</span>
        <span class="config-card__summary">{{ summaryText }}</span>
      </button>
      <ElTooltip :content="introText" placement="top">
        <span class="config-info">i</span>
      </ElTooltip>
      <span class="config-card__spacer" />
      <ElButton size="small" text class="scoring-settings__edit" @click="dialogVisible = true">
        编辑规则
      </ElButton>
    </div>

    <div v-show="expanded" class="config-card__body">
      <div class="scoring-settings__grid">
        <div class="scoring-settings__grid-head">
          <span>维度</span>
          <span>权重</span>
          <span v-for="tier in tierRows" :key="tier.key">{{ tier.label }}</span>
        </div>
        <div v-for="row in rows" :key="row.key" class="scoring-settings__grid-row">
          <span class="scoring-settings__dim">{{ row.label }}</span>
          <span class="scoring-settings__weight-cell">{{ row.weightText }}</span>
          <span
            v-for="band in row.bands"
            :key="band.key"
            class="scoring-settings__band"
            :class="`scoring-settings__band--${band.tone}`"
          >
            {{ band.text }}
          </span>
        </div>
      </div>
    </div>

    <ElDialog
      v-model="dialogVisible"
      class="scoring-settings__dialog"
      width="760px"
      append-to-body
      align-center
      title="评分设置"
    >
      <p class="scoring-settings__dialog-hint">
        每个维度配三条风险区间，区间两端都包含；端点留空表示不限，区间重叠时按「中风险 → 高风险 → 低风险」的顺序取第一条命中的区间。
        综合评分 = Σ(各维度得分 × 权重) ÷ 参与维度权重合计。
      </p>

      <div class="scoring-settings__rows">
        <div v-for="row in draftRows" :key="row.key" class="scoring-settings__row">
          <div class="scoring-settings__row-head">
            <span class="scoring-settings__name">{{ row.label }}</span>
            <label class="scoring-settings__weight">
              权重
              <ElInputNumber
                v-model="row.entry.weight"
                :min="0"
                :controls="false"
                :value-on-clear="0"
                size="small"
                class="scoring-settings__weight-input"
                aria-label="权重"
              />
              %
            </label>
          </div>
          <div class="scoring-settings__ranges">
            <label
              v-for="tier in tierRows"
              :key="tier.key"
              class="scoring-settings__range"
              :class="`scoring-settings__range--${tier.tone}`"
            >
              <span class="scoring-settings__tier">{{ tier.label }}</span>
              <ElInputNumber
                v-model="row.entry.ranges[tier.key].from"
                :controls="false"
                :value-on-clear="null"
                placeholder="不限"
                size="small"
                class="scoring-settings__input"
                :aria-label="`${row.label} ${tier.label}下界`"
              />
              <span class="scoring-settings__tilde">~</span>
              <ElInputNumber
                v-model="row.entry.ranges[tier.key].to"
                :controls="false"
                :value-on-clear="null"
                placeholder="不限"
                size="small"
                class="scoring-settings__input"
                :aria-label="`${row.label} ${tier.label}上界`"
              />
              <span class="scoring-settings__unit">{{ row.unit }}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="scoring-settings__group">
        <span class="scoring-settings__group-title">三档得分</span>
        <label v-for="tier in tierRows" :key="tier.key" class="scoring-settings__field">
          <span>{{ tier.label }}</span>
          <ElInputNumber
            v-model="draft.scores[tier.key]"
            :min="0"
            :controls="false"
            :value-on-clear="0"
            size="small"
            class="scoring-settings__input"
          />
        </label>
      </div>

      <div class="scoring-settings__group">
        <span class="scoring-settings__group-title">综合评分分档</span>
        <label class="scoring-settings__field">
          <span>中风险</span>
          <ElInputNumber
            v-model="draft.total.midFrom"
            :controls="false"
            :value-on-clear="null"
            placeholder="不限"
            size="small"
            class="scoring-settings__input"
            aria-label="综合评分中风险下界"
          />
          <span class="scoring-settings__tilde">~</span>
          <ElInputNumber
            v-model="draft.total.midTo"
            :controls="false"
            :value-on-clear="null"
            placeholder="不限"
            size="small"
            class="scoring-settings__input"
            aria-label="综合评分中风险上界"
          />
          <span class="scoring-settings__unit">分</span>
        </label>
      </div>

      <template #footer>
        <div class="scoring-settings__footer">
          <ElButton size="small" @click="restoreDefaults">恢复默认</ElButton>
          <span class="scoring-settings__spacer" />
          <ElButton size="small" @click="dialogVisible = false">取消</ElButton>
          <ElButton size="small" type="primary" @click="confirm">确定</ElButton>
        </div>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.scoring-settings__edit {
  padding: 0;
  color: var(--industrial-primary);
}

.scoring-settings__grid {
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
  overflow: hidden;
}

.scoring-settings__grid-head,
.scoring-settings__grid-row {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) 56px repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-variant-numeric: tabular-nums;
}

.scoring-settings__grid-head {
  color: var(--industrial-muted);
  background: var(--industrial-page);
  font-size: 11px;
}

.scoring-settings__grid-row {
  border-top: 1px solid var(--industrial-grid-light);
  font-size: 12px;
}

.scoring-settings__dim {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.scoring-settings__weight-cell {
  color: var(--industrial-muted);
  text-align: right;
}

.scoring-settings__band--red {
  color: var(--industrial-urgent);
}

.scoring-settings__band--yellow {
  color: var(--industrial-replenish);
}

.scoring-settings__band--green {
  color: var(--industrial-normal);
}

:global(.el-dialog.scoring-settings__dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  width: min(760px, calc(100vw - 32px));
}

.scoring-settings__dialog-hint {
  margin: 0 0 12px;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.6;
}

.scoring-settings__rows {
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
}

.scoring-settings__row {
  padding: 7px 10px;
  border-bottom: 1px solid var(--industrial-grid-light);
}

.scoring-settings__row:last-child {
  border-bottom: 0;
}

.scoring-settings__row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}

.scoring-settings__name {
  overflow: hidden;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.scoring-settings__weight {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--industrial-muted);
  font-size: 12px;
}

.scoring-settings__ranges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
}

.scoring-settings__range {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.scoring-settings__tier {
  min-width: 42px;
  font-size: 12px;
}

.scoring-settings__range--high .scoring-settings__tier {
  color: var(--industrial-urgent);
}

.scoring-settings__range--mid .scoring-settings__tier {
  color: var(--industrial-replenish);
}

.scoring-settings__range--low .scoring-settings__tier {
  color: var(--industrial-normal);
}

.scoring-settings__input {
  width: 56px;
}

.scoring-settings__weight-input {
  width: 52px;
}

.scoring-settings__tilde,
.scoring-settings__unit {
  color: var(--industrial-muted);
  font-size: 12px;
}

.scoring-settings__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.scoring-settings__group-title {
  color: var(--industrial-muted);
  font-size: 12px;
}

.scoring-settings__field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.scoring-settings__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.scoring-settings__spacer {
  flex: 1 1 auto;
}
</style>
