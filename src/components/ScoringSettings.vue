<script setup>
// 健康度评分：只读表格 + 一条轴两个分界值的编辑弹窗。
// 计算与校验仍走 src/stocking/scoring.js，组件只负责把结果回传给配置页。
import { computed, reactive, ref, watch } from 'vue'
import { ElDialog, ElMessage } from 'element-plus'
import {
  SCORING_DIMENSIONS,
  SCORING_TIERS,
  SCORING_TIER_LABELS,
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

const rows = computed(() =>
  SCORING_DIMENSIONS.map((definition) => {
    const entry = current.value.dimensions[definition.key]
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      weightText: `${Math.round(entry.weight * 100) / 100}%`,
      low: describeScoringBand(entry.ranges.low, definition),
      mid: describeScoringBand(entry.ranges.mid, definition),
      high: describeScoringBand(entry.ranges.high, definition),
    }
  }),
)

const scoreText = computed(
  () => `${current.value.scores.low} / ${current.value.scores.mid} / ${current.value.scores.high}`,
)

const hintText = computed(() => {
  const from = current.value.total.midFrom ?? '不限'
  const to = current.value.total.midTo ?? '不限'
  return `三档得分 ${scoreText.value} · 综合分档 ≤ ${from} 红 · ${from} ~ ${to} 黄 · ≥ ${to} 绿`
})

// —— 编辑弹窗 ——
// 一条轴上只有两个分界值：相邻两档共用同一个数，提交时再展开成每档的 from / to。
const TIER_SHORT = { low: '低', mid: '中', high: '高' }
const TIER_BAND_TONE = { low: 'low', mid: 'mid', high: 'high' }
const dialogVisible = ref(false)

const form = reactive({
  chains: [],
  scores: { low: 80, mid: 60, high: 40 },
  total: { b1: 50, b2: 70 },
})

function orderTiers(ranges) {
  return [...SCORING_TIERS].sort(
    (a, b) =>
      (ranges[a].from ?? Number.NEGATIVE_INFINITY) - (ranges[b].from ?? Number.NEGATIVE_INFINITY),
  )
}

function buildRow(definition, entry) {
  const order = orderTiers(entry.ranges)
  const first = entry.ranges[order[0]]
  const second = entry.ranges[order[1]]
  const third = entry.ranges[order[2]]
  return {
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    decimals: definition.decimals,
    weight: Math.round(entry.weight * 100) / 100,
    order,
    b1: first.to ?? second.from,
    b2: second.to ?? third.from,
    outerFrom: first.from,
    outerTo: third.to,
    segs: order.map((tier) => ({ tier, label: TIER_SHORT[tier], tone: TIER_BAND_TONE[tier] })),
  }
}

function syncForm() {
  const next = normalizeScoring(props.scoring)
  form.chains = SCORING_DIMENSIONS.map((definition) =>
    buildRow(definition, next.dimensions[definition.key]),
  )
  form.scores = { ...next.scores }
  form.total = { b1: next.total.midFrom, b2: next.total.midTo }
}

watch(dialogVisible, (visible) => {
  if (visible) syncForm()
})

const formWeightTotal = computed(
  () => Math.round(form.chains.reduce((sum, row) => sum + (Number(row.weight) || 0), 0) * 100) / 100,
)
const formWeightBalanced = computed(() => Math.abs(formWeightTotal.value - 100) <= 0.001)

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function addStep(value, step) {
  const number = toNumber(value)
  return number === null ? null : number + step
}

function restoreDefaults() {
  const defaults = createDefaultScoring()
  form.chains = SCORING_DIMENSIONS.map((definition) =>
    buildRow(definition, defaults.dimensions[definition.key]),
  )
  form.scores = { ...defaults.scores }
  form.total = { b1: defaults.total.midFrom, b2: defaults.total.midTo }
}

function confirm() {
  const dimensions = {}
  for (const row of form.chains) {
    // 区间两端都包含：整数维度相邻档留 1 的整数间隔，其余维度共用分界值。
    const step = row.decimals === 0 ? 1 : 0
    const ranges = {}
    ranges[row.order[0]] = { from: row.outerFrom ?? null, to: toNumber(row.b1) }
    ranges[row.order[1]] = { from: addStep(row.b1, step), to: toNumber(row.b2) }
    ranges[row.order[2]] = { from: addStep(row.b2, step), to: row.outerTo ?? null }
    dimensions[row.key] = { weight: Number(row.weight) || 0, ranges }
  }

  const next = normalizeScoring({
    scores: form.scores,
    total: { midFrom: toNumber(form.total.b1), midTo: toNumber(form.total.b2) },
    dimensions,
  })
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
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">健康度评分</h2>
    </div>

    <div class="panel__body">
      <div class="tbl-block">
        <table class="score-table">
          <thead>
            <tr>
              <th style="width: 132px">维度</th>
              <th class="is-num" style="width: 64px">权重</th>
              <th>低风险</th>
              <th>中风险</th>
              <th>高风险</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <td>
                {{ row.label }}
                <em class="scoring__unit">{{ row.unit }}</em>
              </td>
              <td class="is-num">{{ row.weightText }}</td>
              <td>{{ row.low }}</td>
              <td>{{ row.mid }}</td>
              <td>{{ row.high }}</td>
            </tr>
          </tbody>
        </table>
        <div class="tbl-foot">
          <span class="tbl-foot__hint">{{ hintText }}</span>
          <button type="button" class="btn btn--sm" @click="dialogVisible = true">编辑</button>
        </div>
      </div>
    </div>

    <ElDialog
      v-model="dialogVisible"
      class="ui-dialog"
      width="780px"
      append-to-body
      align-center
      title="编辑健康度评分"
    >
      <p class="form__note">
        三档按数值从小到大排成一条轴，只填两个分界值，左右两档共用；权重合计需为 100%。
      </p>

      <div class="rule-head">
        <span>维度</span>
        <span>风险分档</span>
        <span class="is-right">权重</span>
      </div>
      <div class="rule-body">
        <div v-for="row in form.chains" :key="row.key" class="rule-row">
          <span class="rule-row__name">
            {{ row.label }}
            <em>{{ row.unit }}</em>
          </span>
          <div class="bandbar">
            <span class="bandbar__seg" :class="`bandbar__seg--${row.segs[0].tone}`">
              {{ row.segs[0].label }}
            </span>
            <input
              v-model.number="row.b1"
              class="bandbar__cut"
              type="number"
              inputmode="decimal"
              step="1"
              placeholder="不限"
              aria-label="第 1 个分界值"
            />
            <span
              class="bandbar__seg"
              :class="[`bandbar__seg--${row.segs[1].tone}`, { 'is-empty': row.b1 === row.b2 }]"
              :title="row.b1 === row.b2 ? '该档区间为空，不会命中' : ''"
            >
              {{ row.segs[1].label }}
            </span>
            <input
              v-model.number="row.b2"
              class="bandbar__cut"
              type="number"
              inputmode="decimal"
              step="1"
              placeholder="不限"
              aria-label="第 2 个分界值"
            />
            <span class="bandbar__seg" :class="`bandbar__seg--${row.segs[2].tone}`">
              {{ row.segs[2].label }}
            </span>
          </div>
          <div class="num-field">
            <input
              v-model.number="row.weight"
              class="input input--num"
              type="number"
              min="0"
              max="100"
              step="5"
              :aria-label="`${row.label}权重`"
            />
            <span class="num-field__unit">%</span>
          </div>
        </div>
      </div>
      <div class="rule-foot">
        <span>分界值同时属于相邻两档，按中风险优先</span>
        <span>
          权重合计
          <b :class="{ 'is-bad': !formWeightBalanced }">{{ formWeightTotal }}</b>%
        </span>
      </div>

      <div class="rule-head rule-head--sub">
        <span>总分规则</span>
        <span></span>
        <span></span>
      </div>
      <div class="rule-body">
        <div class="rule-row">
          <span class="rule-row__name">三档得分</span>
          <div class="form__inline">
            <label v-for="tier in SCORING_TIERS" :key="tier" class="form__inline-item">
              {{ SCORING_TIER_LABELS[tier].replace('风险', '') }}
              <input
                v-model.number="form.scores[tier]"
                class="input input--num form__score"
                type="number"
                min="0"
                max="100"
                step="5"
                :aria-label="`${SCORING_TIER_LABELS[tier]}得分`"
              />
            </label>
          </div>
          <span></span>
        </div>
        <div class="rule-row">
          <span class="rule-row__name">综合分档<em>分</em></span>
          <div class="bandbar">
            <span class="bandbar__seg bandbar__seg--high">红</span>
            <input
              v-model.number="form.total.b1"
              class="bandbar__cut"
              type="number"
              inputmode="decimal"
              step="1"
              placeholder="不限"
              aria-label="综合分档第 1 个分界值"
            />
            <span class="bandbar__seg bandbar__seg--mid">黄</span>
            <input
              v-model.number="form.total.b2"
              class="bandbar__cut"
              type="number"
              inputmode="decimal"
              step="1"
              placeholder="不限"
              aria-label="综合分档第 2 个分界值"
            />
            <span class="bandbar__seg bandbar__seg--low">绿</span>
          </div>
          <span></span>
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
.scoring__unit {
  margin-left: 5px;
  color: #8b979e;
  font-size: 11px;
  font-style: normal;
}

.form__score {
  width: 64px;
  height: 28px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
