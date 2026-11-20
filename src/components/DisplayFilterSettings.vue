<script setup>
// 筛选显示规则：小额补货门槛的摘要 + 编辑弹窗。口径只在 src/stocking/displayFilters.js。
import { computed, reactive, ref, watch } from 'vue'
import { ElDialog, ElInputNumber, ElSwitch } from 'element-plus'
import {
  LOW_PLANNED_DEFAULT_KG,
  createDefaultDisplayFilters,
  normalizeDisplayFilters,
} from '@/stocking'

const props = defineProps({
  // 当前方案里的 displayFilters；只读展示，改动通过 apply 事件回传。
  filters: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['apply'])

const current = computed(() => normalizeDisplayFilters(props.filters))

const summaryRows = computed(() => {
  const { enabled, minKg } = current.value.lowPlanned
  return [
    {
      key: 'lowPlanned',
      label: '小额补货门槛',
      state: enabled ? '已启用' : '已关闭',
      tone: enabled ? 'on' : 'off',
      // 只在「紧急 / 常规」两个筛选上生效，写清楚范围，避免误以为会删数据。
      scope: enabled ? `紧急 / 常规里需安排 < ${minKg} 公斤不列出` : '紧急 / 常规显示全部补货行',
    },
  ]
})

// —— 编辑弹窗 ——
const dialogVisible = ref(false)
const draft = reactive({ enabled: true, minKg: LOW_PLANNED_DEFAULT_KG })

watch(dialogVisible, (visible) => {
  if (!visible) return
  const { enabled, minKg } = normalizeDisplayFilters(props.filters).lowPlanned
  draft.enabled = enabled
  draft.minKg = minKg
})

function restoreDefaults() {
  const { enabled, minKg } = createDefaultDisplayFilters().lowPlanned
  draft.enabled = enabled
  draft.minKg = minKg
}

function confirm() {
  emit('apply', normalizeDisplayFilters({ lowPlanned: { ...draft } }))
  dialogVisible.value = false
}
</script>

<template>
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">筛选显示规则</h2>
    </div>

    <div class="panel__body">
      <div class="tbl-block">
        <table class="score-table">
          <thead>
            <tr>
              <th style="width: 140px">规则</th>
              <th style="width: 84px">状态</th>
              <th>影响范围</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in summaryRows" :key="row.key">
              <td>{{ row.label }}</td>
              <td>
                <span class="df__state" :class="`df__state--${row.tone}`">{{ row.state }}</span>
              </td>
              <td class="score-table__muted">{{ row.scope }}</td>
            </tr>
          </tbody>
        </table>
        <div class="tbl-foot">
          <span class="tbl-foot__hint">
            只改「紧急 / 常规」筛选结果与紧急补货清单，全部列表、预警计数之外的数据一行不动
          </span>
          <button type="button" class="btn btn--sm" @click="dialogVisible = true">编辑</button>
        </div>
      </div>
    </div>

    <ElDialog
      v-model="dialogVisible"
      class="ui-dialog"
      width="520px"
      append-to-body
      align-center
      title="编辑筛选显示规则"
    >
  
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">启用门槛</span>
          <div class="form__row-ctrl">
            <ElSwitch v-model="draft.enabled" aria-label="启用小额补货门槛" />
            <p class="form__row-hint">
              关闭后「紧急 / 常规」恢复显示全部补货行，紧急补货清单也不再排除小额行。
            </p>
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">门槛</span>
          <div class="form__row-ctrl">
            <div class="num-field">
              <ElInputNumber
                v-model="draft.minKg"
                class="input--num"
                :min="1"
                :step="5"
                :controls="false"
                :disabled="!draft.enabled"
                aria-label="小额补货门槛（公斤）"
              />
              <span class="num-field__unit">公斤</span>
            </div>
            <p class="form__row-hint">
              按「建议需安排」判断：补到正常库存（绿区中位）的差额（已扣除累计下单），与「需安排」格的占位建议同一口径。
              门槛设为 {{ draft.minKg || LOW_PLANNED_DEFAULT_KG }} 时，需安排 8 / 25 公斤的紧急行不列出，300 公斤的照常出现。
            </p>
          </div>
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
.df__state {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border-radius: 2px;
  font-size: 11.5px;
  font-weight: 600;
}

.df__state--on {
  color: var(--industrial-primary);
  background: #f1f5f8;
}

.df__state--off {
  color: var(--industrial-muted);
  background: #f2f5f6;
}
</style>
