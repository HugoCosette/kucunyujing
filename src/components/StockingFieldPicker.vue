<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElButton } from 'element-plus'
import { FIELD_GROUPS, getFieldsByGroup } from '@/stocking'

// 因子字段选择器：销售数据置顶展开，其余字段默认折叠，点击后再展开。
const props = defineProps({
  label: {
    type: String,
    default: '＋ 添加因子',
  },
  usedFields: {
    type: Array,
    default: () => [],
  },
  numericOnly: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['select'])

const open = ref(false)
const showMore = ref(false)
const rootRef = ref(null)

const groups = computed(() =>
  FIELD_GROUPS.map((group) => ({
    ...group,
    fields: getFieldsByGroup(group.key).filter(
      (entry) =>
        !props.usedFields.includes(entry.field) &&
        (!props.numericOnly || entry.kind === 'number'),
    ),
  })).filter((group) => group.fields.length > 0),
)

const availableCount = computed(() =>
  groups.value.reduce((total, group) => total + group.fields.length, 0),
)

function toggle() {
  open.value = !open.value
  if (!open.value) showMore.value = false
}

function choose(field) {
  emit('select', field)
  open.value = false
  showMore.value = false
}

function handlePointerDown(event) {
  if (!open.value) return
  if (rootRef.value?.contains(event.target)) return
  open.value = false
  showMore.value = false
}

onMounted(() => document.addEventListener('pointerdown', handlePointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', handlePointerDown))
</script>

<template>
  <div ref="rootRef" class="field-picker">
    <ElButton
      size="small"
      text
      class="field-picker__trigger"
      :disabled="availableCount === 0"
      @click="toggle"
    >
      {{ label }}
    </ElButton>

    <div v-if="open" class="field-picker__panel">
      <div v-for="group in groups" :key="group.key" class="field-picker__group">
        <button
          v-if="group.collapsed"
          type="button"
          class="field-picker__more"
          @click="showMore = !showMore"
        >
          {{ showMore ? '▾' : '▸' }} {{ group.label }}（{{ group.fields.length }}）
        </button>
        <p v-else class="field-picker__title">{{ group.label }}</p>

        <template v-if="!group.collapsed || showMore">
          <button
            v-for="field in group.fields"
            :key="field.field"
            type="button"
            class="field-picker__item"
            @click="choose(field.field)"
          >
            {{ field.label }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.field-picker {
  position: relative;
  display: inline-block;
}

.field-picker__trigger {
  padding: 0;
  color: var(--industrial-primary);
}

.field-picker__panel {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  min-width: 148px;
  max-height: 260px;
  padding: 6px;
  overflow: auto;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  background: var(--industrial-surface);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
}

.field-picker__group + .field-picker__group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--industrial-grid-light);
}

.field-picker__title {
  margin: 0 0 2px;
  padding-left: 6px;
  color: var(--industrial-muted);
  font-size: 11px;
}

.field-picker__more {
  width: 100%;
  padding: 3px 6px;
  border: 0;
  border-radius: 3px;
  color: var(--industrial-muted);
  background: transparent;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.field-picker__more:hover,
.field-picker__item:hover {
  background: var(--industrial-header);
}

.field-picker__item {
  display: block;
  width: 100%;
  padding: 4px 8px;
  border: 0;
  border-radius: 3px;
  color: var(--industrial-text);
  background: transparent;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
</style>
