<script setup>
import { ElTooltip } from 'element-plus'

defineProps({
  label: { type: String, default: '' },
  // { unit: string, rows: [标签, 说明][] }；没有说明的列传 null，表头保持原样。
  hint: { type: Object, default: null },
})
</script>

<template>
  <ElTooltip
    :disabled="!hint"
    placement="bottom"
    effect="light"
    :show-after="160"
    :hide-after="0"
    :enterable="false"
    popper-class="table-header-hint-popper"
  >
    <template #content>
      <div class="table-header-hint">
        <p class="table-header-hint__head">
          <span>{{ label }}</span>
          <span v-if="hint?.unit" class="table-header-hint__unit">{{ hint.unit }}</span>
        </p>
        <p
          v-for="(row, index) in hint?.rows ?? []"
          :key="`${row[0]}-${index}`"
          class="table-header-hint__row"
        >
          <span class="table-header-hint__tag">{{ row[0] }}</span>
          <span class="table-header-hint__text">{{ row[1] }}</span>
        </p>
      </div>
    </template>
    <span class="table-header-hint__trigger" :class="{ 'table-header-hint__trigger--hinted': hint }">
      <span class="table-header-hint__label">{{ label }}</span>
    </span>
  </ElTooltip>
</template>

<style scoped>
.table-header-hint__trigger {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: inherit;
  min-width: 0;
  height: 100%;
}

.table-header-hint__label {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table-header-hint__trigger--hinted {
  cursor: help;
}

.table-header-hint__trigger--hinted .table-header-hint__label {
  text-decoration: underline dotted var(--industrial-muted);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.table-header-hint__trigger--hinted:hover .table-header-hint__label {
  text-decoration-style: solid;
}

.table-header-hint {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 320px;
  color: var(--industrial-text);
  font-size: 12px;
  line-height: 1.55;
}

.table-header-hint__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 0 0 3px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--industrial-grid-light);
  font-weight: 600;
}

.table-header-hint__unit {
  color: var(--industrial-muted);
  font-weight: 500;
}

.table-header-hint__row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 8px;
  margin: 0;
}

.table-header-hint__tag {
  color: var(--industrial-muted);
}

.table-header-hint__text {
  color: var(--industrial-text);
  word-break: break-word;
}
</style>
