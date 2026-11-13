<script setup>
// SPU 分级：只读表格 + 编辑弹窗。判定口径仍只在 src/stocking/spuGrades.js。
import { computed, reactive, ref, watch } from 'vue'
import { ElDialog, ElMessage } from 'element-plus'
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

function thresholdUnitText(row) {
  return row.threshold
}

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
  return Number.isFinite(previous?.minMonthlyAvg) ? `低于 ${previous.minMonthlyAvg}` : '兜底'
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
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">SPU 分级</h2>
    </div>

    <div class="panel__body">
      <div class="tbl-block">
        <table class="score-table">
          <thead>
            <tr>
              <th style="width: 82px">等级</th>
              <th>月均条数</th>
              <th class="is-num" style="width: 96px">命中 SPU</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in summaryRows" :key="row.key">
              <td>
                <span class="spu__chip" :class="`spu__chip--${row.tone}`">{{ row.label }}</span>
              </td>
              <td class="score-table__mono">{{ thresholdUnitText(row) }}</td>
              <td class="is-num">{{ row.count }} 个</td>
            </tr>
          </tbody>
        </table>
        <div class="tbl-foot">
          <span class="tbl-foot__hint">从高到低判定，末档兜底 · 共 {{ currentTotal }} 个 SPU</span>
          <button type="button" class="btn btn--sm" @click="dialogVisible = true">编辑</button>
        </div>
      </div>
    </div>

    <ElDialog
      v-model="dialogVisible"
      class="ui-dialog"
      width="560px"
      append-to-body
      align-center
      title="编辑 SPU 分级"
    >
      <p class="form__note">
        从高到低判定，命中第一条「月均条数 ≥ 下限」的等级；末档兜底，收下所有低于上一档的 SPU。
        月均条数 = 该品名下全部 SKU 的「月均条数」之和（由销售表提供）。
      </p>

      <div class="form">
        <div v-for="(tier, index) in draft.tiers" :key="tier.key" class="spu__row">
          <input
            v-model="tier.label"
            class="input input--sm spu__label"
            :aria-label="`等级 ${index + 1} 名称`"
          />
          <span class="spu__operator">
            {{ index < draft.tiers.length - 1 ? '月均 ≥' : '月均' }}
          </span>
          <template v-if="index < draft.tiers.length - 1">
            <div class="num-field">
              <input
                v-model.number="tier.minMonthlyAvg"
                class="input input--num"
                type="number"
                min="0"
                step="1"
                :aria-label="`${tier.label} 月均条数下限`"
              />
              <span class="num-field__unit">条</span>
            </div>
          </template>
          <span v-else class="spu__fallback">{{ fallbackDraftText(index) }}</span>
          <span class="spu__hit">当前 {{ draftCounts[tier.key] ?? 0 }} 个 SPU</span>
        </div>
      </div>

      <template #footer>
        <div class="form__foot">
          <button type="button" class="btn btn--text btn--sm" @click="restoreDefaults">恢复默认</button>
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="dialogVisible = false">取消</button>
          <button type="button" class="btn btn--primary btn--sm" @click="confirm">确定</button>
        </div>
      </template>
    </ElDialog>
  </section>
</template>

<style scoped>
.spu__chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 19px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 2px;
  font-size: 11.5px;
  font-weight: 600;
}

.spu__chip--violet {
  color: #6b5a86;
  background: #f4f1f8;
}

.spu__chip--red {
  color: #a64f49;
  background: #faf2f1;
}

.spu__chip--amber {
  color: #8a6a2f;
  background: #faf6ed;
}

.spu__chip--blue {
  color: var(--industrial-primary);
  background: #f1f5f8;
}

.spu__chip--green {
  color: #5b7460;
  background: #f3f7f4;
}

.spu__chip--gray {
  color: var(--industrial-muted);
  background: #f2f5f6;
}

.spu__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--industrial-grid-light);
  font-size: 12px;
}

.spu__row + .spu__row {
  margin-top: -1px;
}

.spu__label {
  width: 84px;
}

.spu__operator,
.spu__fallback {
  color: var(--industrial-muted);
}

.spu__hit {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 11px;
}
</style>
