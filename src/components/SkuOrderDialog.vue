<script setup>
import { computed, ref, watch } from 'vue'
import { ElButton, ElDialog } from 'element-plus'
import SkuOrderEditor from './SkuOrderEditor.vue'
import { usePurchaseStore } from '@/stores/purchase'

// 单个 SKU 的分订单弹窗：主面板「本次采购清单」里点「去下单」时使用。
const props = defineProps({
  visible: {
    type: Boolean,
    default: false,
  },
  item: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['update:visible'])

const purchaseStore = usePurchaseStore()
const draft = ref([])

const skuId = computed(() => String(props.item?.skuId ?? '').trim())
const title = computed(() =>
  props.item ? `采购下单 · ${props.item.product} ${props.item.color}` : '采购下单',
)

// 每次打开都从 store 重新取一份，取消时丢弃草稿即不会污染已保存的数据。
watch(
  () => [props.visible, props.item?.skuId],
  ([visible]) => {
    if (!visible) return
    draft.value = purchaseStore.orderEntries(skuId.value).map((entry) => ({ ...entry }))
  },
  { immediate: true },
)

function close() {
  emit('update:visible', false)
}

function save() {
  if (skuId.value) purchaseStore.setOrderEntries(skuId.value, draft.value)
  close()
}
</script>

<template>
  <ElDialog
    :model-value="visible"
    :title="title"
    width="720px"
    class="sku-order-dialog"
    destroy-on-close
    align-center
    @update:model-value="emit('update:visible', $event)"
  >
    <p v-if="props.item" class="sku-order-dialog__meta">
      树形分类：{{ props.item.treeCategory || '未维护' }} · 可按染厂拆成多张分订单
    </p>

    <SkuOrderEditor v-if="props.item" v-model="draft" :item="props.item" />

    <template #footer>
      <div class="dialog-footer">
        <ElButton @click="close">取消</ElButton>
        <ElButton type="primary" :disabled="!skuId" @click="save">保存分订单</ElButton>
      </div>
    </template>
  </ElDialog>
</template>

<style scoped>
.sku-order-dialog__meta {
  margin: 0 0 12px;
  color: var(--industrial-muted);
  font-size: 13px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:global(.el-dialog.sku-order-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
  width: min(720px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

:global(.el-dialog.sku-order-dialog .el-dialog__body) {
  min-height: 0;
  overflow: auto;
}
</style>
