<script setup>
import { computed, ref } from 'vue'
import { ElButton, ElDialog, ElProgress } from 'element-plus'

// 导入分表：一次选择 5 张分表，按文件名自动认领，清洗后进入「导入总表与销售表」确认弹窗。
const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
  roles: {
    type: Array,
    default: () => [],
  },
  matching: {
    type: Object,
    default: () => ({ assigned: {}, unmatched: [], missing: [] }),
  },
  progress: {
    type: Object,
    default: () => ({ running: false, percent: 0, message: '' }),
  },
})

const emit = defineEmits(['update:modelValue', 'select', 'clear', 'start', 'cancel'])

const inputRef = ref(null)

const matchedCount = computed(() => props.roles.filter((role) => role.fileName).length)
const unmatchedNames = computed(() => props.matching.unmatched.map((file) => file.name))

// 每张分表自己的清洗进度：清洗中按阶段推进，完成后固定 100%
const rowPercent = (id) => Math.round(props.progress?.rows?.[id] ?? 0)
const isRowRunning = (id) =>
  Boolean(props.progress?.running) &&
  props.progress?.activeId === id &&
  rowPercent(id) < 100
const showRowPercent = (id) => Boolean(props.progress?.running) || rowPercent(id) > 0

function triggerPick() {
  const input = inputRef.value
  if (!input) return
  input.value = ''
  input.click()
}

function handleFilesChange(event) {
  const input = event.target
  emit('select', Array.from(input.files ?? []))
  input.value = ''
}

function closeDialog() {
  emit('update:modelValue', false)
  emit('cancel')
}
</script>

<template>
  <ElDialog
    :model-value="modelValue"
    title="导入分表"
    width="680px"
    class="import-split-dialog"
    :close-on-click-modal="false"
    :show-close="!progress.running"
    :close-on-press-escape="!progress.running"
    @update:model-value="(value) => emit('update:modelValue', value)"
  >
    <p class="import-split__tip">
      一次选择 5 张分表（产品资料、出入库明细、库存结存表、欠货订单、生产排单），系统按文件名自动认领。
      文件名只要包含 `产品资料` / `出入库明细` / `库存结存表` / `欠货` / `Scheduling` 即会被自动匹配
    </p>

    <div class="import-split__actions">
      <ElButton :disabled="progress.running" @click="triggerPick">选择分表文件</ElButton>
      <ElButton v-if="matchedCount > 0" text :disabled="progress.running" @click="emit('clear')">
        清空
      </ElButton>
      <span class="import-split__count">已匹配 {{ matchedCount }} / {{ roles.length }}</span>
    </div>

    <input
      ref="inputRef"
      class="import-split__input"
      type="file"
      multiple
      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      @change="handleFilesChange"
    />

    <ul class="import-split__list">
      <li
        v-for="role in roles"
        :key="role.id"
        class="import-split__item"
        :class="{
          'import-split__item--missing': !role.fileName,
          'import-split__item--running': isRowRunning(role.id),
          'import-split__item--done': rowPercent(role.id) >= 100,
        }"
        :style="{ '--split-percent': `${rowPercent(role.id)}%` }"
      >
        <span class="import-split__fill" aria-hidden="true" />
        <span class="import-split__role">
          {{ role.label }}
          <span v-if="role.isBase" class="import-split__badge">基准表</span>
        </span>
        <span v-if="role.fileName" class="import-split__file">{{ role.fileName }}</span>
        <span v-else class="import-split__file import-split__file--missing">
          待选择（文件名需包含 {{ role.keywords.join(' + ') }}）
        </span>
        <span v-if="showRowPercent(role.id)" class="import-split__percent">
          {{ rowPercent(role.id) }}%
        </span>
      </li>
    </ul>

    <p v-if="unmatchedNames.length" class="import-split__warn">
      以下文件没有对应的分表，未参与清洗：{{ unmatchedNames.join('、') }}
    </p>

    <div v-if="progress.running || progress.percent > 0" class="import-split__progress">
      <ElProgress :percentage="progress.percent" :stroke-width="8" />
      <span class="import-split__progress-text">{{ progress.message }}</span>
    </div>

    <p class="import-split__hint">
      清洗口径与「数据清洗」脚本一致：以产品资料为 SKU 全集，按唯一标识关联出入库明细（只算出库数量大于 0
      的行）、库存结存、欠货与生产排单；月均条数按单位换算（码 ÷100、公斤 ÷20）。
    </p>

    <template #footer>
      <div class="import-split__footer">
        <ElButton :disabled="progress.running" @click="closeDialog">取消</ElButton>
        <ElButton
          type="primary"
          :loading="progress.running"
          :disabled="progress.running || matchedCount < roles.length"
          @click="emit('start')"
        >
          开始清洗并导入
        </ElButton>
      </div>
    </template>
  </ElDialog>
</template>

<style scoped>
.import-split__tip {
  margin: 0 0 12px;
  padding: 8px 10px;
  color: var(--industrial-text);
  background: var(--industrial-header);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.7;
}

.import-split__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.import-split__count {
  margin-left: auto;
  color: var(--industrial-muted);
  font-size: 12px;
}

.import-split__input {
  display: none;
}

.import-split__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--industrial-border, #d8e0e5);
  border-radius: 4px;
}

.import-split__item {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 10px;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.7;
}

.import-split__item + .import-split__item {
  border-top: 1px solid var(--industrial-border, #d8e0e5);
}

/* 逐行进度：背景从左侧铺开，清洗中的行还带滚动斜纹 */
.import-split__fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: var(--split-percent, 0%);
  background: linear-gradient(90deg, rgba(63, 113, 141, 0.16), rgba(63, 113, 141, 0.05));
  transition: width 240ms ease-out;
  pointer-events: none;
}

.import-split__item--running .import-split__fill {
  background-image: linear-gradient(
    45deg,
    rgba(63, 113, 141, 0.2) 25%,
    transparent 25%,
    transparent 50%,
    rgba(63, 113, 141, 0.2) 50%,
    rgba(63, 113, 141, 0.2) 75%,
    transparent 75%,
    transparent
  );
  background-size: 16px 16px;
  animation: import-split-stripes 0.8s linear infinite;
}

.import-split__item--done .import-split__fill {
  background: rgba(63, 113, 141, 0.08);
}

.import-split__item--running .import-split__role {
  color: var(--industrial-primary);
}

@keyframes import-split-stripes {
  from {
    background-position: 0 0;
  }

  to {
    background-position: 16px 0;
  }
}

.import-split__role,
.import-split__file,
.import-split__percent {
  position: relative;
  z-index: 1;
}

.import-split__percent {
  margin-left: auto;
  color: var(--industrial-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.import-split__role {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  width: 132px;
  font-weight: 600;
}

.import-split__badge {
  padding: 1px 6px;
  color: var(--industrial-primary);
  background: var(--industrial-header);
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

.import-split__file {
  color: var(--industrial-text);
  word-break: break-all;
}

.import-split__file--missing,
.import-split__item--missing .import-split__role {
  color: var(--industrial-muted);
}

.import-split__warn {
  margin: 10px 0 0;
  color: var(--industrial-out-of-stock, #b44242);
  font-size: 12px;
  line-height: 1.7;
}

.import-split__progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 12px;
}

.import-split__progress-text {
  color: var(--industrial-muted);
  font-size: 12px;
}

.import-split__hint {
  margin: 12px 0 0;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.7;
}

.import-split__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
