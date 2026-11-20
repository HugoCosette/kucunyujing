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

// 可选的两张（产品资料 / 出码率）有系统缓存兜底，单独成组并淡化，让必选的 4 张更醒目
const optionalRoles = computed(() => props.roles.filter((role) => role.cached))
const requiredRoles = computed(() => props.roles.filter((role) => !role.cached))
const requiredReadyCount = computed(
  () => requiredRoles.value.filter((role) => role.fileName).length,
)
const requiredMissingCount = computed(() => requiredRoles.value.length - requiredReadyCount.value)
const requiredTail = computed(() =>
  requiredMissingCount.value > 0
    ? `缺 ${requiredMissingCount.value} 张`
    : `已齐 ${requiredReadyCount.value}/${requiredRoles.value.length}`,
)
const matchedCount = computed(() => props.roles.filter((role) => role.fileName).length)
const unmatchedNames = computed(() => props.matching.unmatched.map((file) => file.name))
const canStart = computed(
  () => !props.progress.running && props.matching.missing.length === 0,
)

// 每张分表自己的清洗进度：清洗中按阶段推进，完成后固定 100%
const rowPercent = (id) => Math.round(props.progress?.rows?.[id] ?? 0)
const isRowRunning = (id) =>
  Boolean(props.progress?.running) &&
  props.progress?.activeId === id &&
  rowPercent(id) < 100
const showRowPercent = (id) => Boolean(props.progress?.running) || rowPercent(id) > 0

// 有文件名显示文件名；可选表没选就用缓存；必选表没选给一句认领关键字
const rowValue = (role) => {
  if (role.fileName) return role.fileName
  if (role.cached) return '系统缓存'
  return `待选择 · 含「${role.keywords.join(' · ')}」`
}

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
    <p class="import-split__subtitle">按文件名自动认领</p>

    <section class="import-split__group import-split__group--optional">
      <header class="import-split__group-head">
        <span class="import-split__dot" />
        <span class="import-split__group-name">可选</span>
        <span class="import-split__group-tail">{{ optionalRoles.length }} 张 · 未选则用缓存</span>
      </header>
      <ul class="import-split__list">
        <li
          v-for="role in optionalRoles"
          :key="role.id"
          class="import-split__item"
          :class="{ 'import-split__item--running': isRowRunning(role.id) }"
          :style="{ '--split-percent': `${rowPercent(role.id)}%` }"
        >
          <span class="import-split__fill" aria-hidden="true" />
          <span
            class="import-split__mark"
            :class="role.fileName ? 'import-split__mark--cache' : 'import-split__mark--faded'"
            >✓</span
          >
          <span class="import-split__role">
            {{ role.label }}
            <span v-if="role.isBase" class="import-split__badge">基准表</span>
          </span>
          <span class="import-split__file">{{ rowValue(role) }}</span>
          <span v-if="showRowPercent(role.id)" class="import-split__percent">
            {{ rowPercent(role.id) }}%
          </span>
        </li>
      </ul>
    </section>

    <section class="import-split__group import-split__group--required">
      <header class="import-split__group-head">
        <span class="import-split__dot" />
        <span class="import-split__group-name">必选</span>
        <span
          class="import-split__group-tail"
          :class="{ 'import-split__group-tail--warn': requiredMissingCount > 0 }"
          >{{ requiredTail }}</span
        >
      </header>
      <ul class="import-split__list">
        <li
          v-for="role in requiredRoles"
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
          <span
            class="import-split__mark"
            :class="role.fileName ? 'import-split__mark--ok' : 'import-split__mark--todo'"
            >{{ role.fileName ? '✓' : '' }}</span
          >
          <span class="import-split__role">
            {{ role.label }}
            <span v-if="role.isBase" class="import-split__badge">基准表</span>
          </span>
          <span class="import-split__file" :class="{ 'import-split__file--missing': !role.fileName }">
            {{ rowValue(role) }}
          </span>
          <span v-if="showRowPercent(role.id)" class="import-split__percent">
            {{ rowPercent(role.id) }}%
          </span>
        </li>
      </ul>
    </section>

    <input
      ref="inputRef"
      class="import-split__input"
      type="file"
      multiple
      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      @change="handleFilesChange"
    />

    <p v-if="unmatchedNames.length" class="import-split__warn">
      未识别的文件：{{ unmatchedNames.join('、') }}
    </p>

    <div v-if="progress.running || progress.percent > 0" class="import-split__progress">
      <ElProgress :percentage="progress.percent" :stroke-width="8" />
      <span class="import-split__progress-text">{{ progress.message }}</span>
    </div>

    <template #footer>
      <div class="import-split__footer">
        <ElButton :disabled="progress.running" @click="triggerPick">选择分表文件</ElButton>
        <ElButton v-if="matchedCount > 0" text :disabled="progress.running" @click="emit('clear')">
          清空
        </ElButton>
        <span class="import-split__spacer" />
        <ElButton :disabled="progress.running" @click="closeDialog">取消</ElButton>
        <ElButton
          type="primary"
          class="import-split__primary"
          :loading="progress.running"
          :disabled="!canStart"
          @click="emit('start')"
        >
          开始清洗并导入
        </ElButton>
      </div>
    </template>
  </ElDialog>
</template>

<style scoped>
.import-split__subtitle {
  margin: 0 0 10px;
  color: var(--industrial-muted);
  font-size: 12px;
}

/* —— 两组分框：可选整组淡化，必选做实 —— */
.import-split__group + .import-split__group {
  margin-top: 10px;
}

.import-split__group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 6px;
  padding: 0 2px;
  font-size: 12px;
}

.import-split__input {
  display: none;
}

.import-split__dot {
  flex: none;
  width: 7px;
  height: 7px;
  background: #b9c3c8;
  border-radius: 50%;
}

.import-split__group--required .import-split__dot {
  background: var(--industrial-replenish);
  box-shadow: 0 0 0 3px rgba(196, 154, 82, 0.16);
}

.import-split__group-name {
  color: #8b969d;
  font-weight: 600;
}

.import-split__group--required .import-split__group-name {
  color: var(--industrial-text);
}

.import-split__group-tail {
  margin-left: auto;
  color: #a3aeb4;
  font-size: 11px;
}

.import-split__group--required .import-split__group-tail {
  color: var(--industrial-muted);
  font-variant-numeric: tabular-nums;
}

.import-split__group-tail--warn {
  color: var(--industrial-replenish);
  font-weight: 600;
}

.import-split__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: 6px;
}

.import-split__group--optional .import-split__list {
  background: #fafbfb;
  border: 1px dashed #d9dfe3;
}

.import-split__group--required .import-split__list {
  background: #fff;
  border: 1px solid var(--line-soft, #d3dbe0);
  box-shadow: 0 1px 2px rgba(47, 59, 67, 0.05);
}

.import-split__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  overflow: hidden;
  padding: 0 12px;
  line-height: 1.6;
}

.import-split__item + .import-split__item {
  border-top: 1px solid #eef2f4;
}

.import-split__group--optional .import-split__item {
  height: 34px;
  font-size: 12.5px;
}

.import-split__group--required .import-split__item {
  height: 42px;
  font-size: 13px;
}

.import-split__group--required .import-split__item--missing {
  background: rgba(196, 154, 82, 0.06);
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

.import-split__mark,
.import-split__role,
.import-split__file,
.import-split__percent {
  position: relative;
  z-index: 1;
}

/* —— 行首状态点：绿=已选 / 蓝=缓存 / 空圈=待选 —— */
.import-split__mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.import-split__mark--ok {
  background: var(--industrial-normal);
}

.import-split__mark--cache {
  color: var(--industrial-primary);
  background: rgba(63, 113, 141, 0.16);
}

.import-split__mark--faded {
  color: #a6b1b7;
  background: #e3e8ea;
}

.import-split__mark--todo {
  background: #fff;
  box-shadow: inset 0 0 0 1.5px rgba(196, 154, 82, 0.6);
}

.import-split__role {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  width: 150px;
}

.import-split__group--optional .import-split__role {
  color: #8b969d;
  font-weight: 500;
}

.import-split__group--required .import-split__role {
  font-weight: 600;
}

.import-split__badge {
  padding: 1px 6px;
  color: #7f9cad;
  background: rgba(63, 113, 141, 0.07);
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgba(63, 113, 141, 0.18);
  font-size: 11px;
  font-weight: 500;
}

.import-split__file {
  overflow: hidden;
  color: var(--industrial-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-split__group--optional .import-split__file {
  color: #a3aeb4;
  font-size: 12px;
}

.import-split__file--missing {
  color: #8d6a2b;
  font-size: 12px;
}

.import-split__percent {
  margin-left: auto;
  color: var(--industrial-primary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
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

/* —— 底部工具条：所有按钮集中一行，背景压深突出主按钮 —— */
:deep(.el-dialog__footer) {
  padding: 0;
  background: #eef2f5;
  border-top: 1px solid var(--line-soft, #d3dbe0);
}

.import-split__footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
}

.import-split__spacer {
  flex: 1;
}

.import-split__primary {
  font-weight: 600;
  box-shadow: 0 2px 6px rgba(63, 113, 141, 0.3);
}
</style>
