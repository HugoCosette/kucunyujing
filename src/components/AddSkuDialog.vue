<script setup>
import { computed, reactive, watch } from 'vue'
import {
  ElButton,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElSelect,
} from 'element-plus'
import { useInventoryStore } from '@/stores/inventory'
import { useStockingConfigStore } from '@/stores/stocking'
import { CATEGORIES } from '@/stocking/constants'
import { SKU_METRIC_INPUTS, SKU_QUANTITY_INPUTS, addInventorySku } from '@/utils/skuCreate'

// 手动添加 SKU：字段与导入总表 / 销售表一一对应，全部可直接输入。
// 写入 store 后由主面板 toast 给出「查看该 SKU」入口（弹窗里的配置信息与月度销量）。
const props = defineProps({
  visible: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:visible', 'created'])

const inventoryStore = useInventoryStore()
// 屏蔽清单里用过的唯一标识不能再用，否则新加的 SKU 会直接被屏蔽规则挡住。
const stockingStore = useStockingConfigStore()

const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value),
})

function createEmptyDraft() {
  const draft = {
    product: '',
    color: '',
    // 与导入一致：色彩缺省按黑白处理，决定取黑白还是彩色系数。
    category: CATEGORIES[0],
    treeCategory: '',
  }
  for (const { field } of SKU_QUANTITY_INPUTS) draft[field] = null
  for (const { field } of SKU_METRIC_INPUTS) draft[field] = null
  return draft
}

const draft = reactive(createEmptyDraft())

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    Object.assign(draft, createEmptyDraft())
  },
)

function submit() {
  try {
    const item = addInventorySku(inventoryStore, draft, {
      reservedSkuIds: stockingStore.hiddenSkuKeys,
    })
    dialogVisible.value = false
    emit('created', item)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '添加失败')
  }
}
</script>

<template>
  <ElDialog
    v-model="dialogVisible"
    title="添加 SKU"
    width="820px"
    class="add-sku-dialog"
    align-center
    :close-on-click-modal="false"
  >
    <p class="add-sku-hint">
      字段与导入的总表 / 销售表一致，全部可以直接输入。唯一标识自动生成（MANUAL-0001 起递增），品名 + 颜色不能与已有 SKU 重复；库存与销量都按公斤填写。手动添加的 SKU 只保留在当前页面，刷新或重新导入后需要重新添加。
    </p>

    <section class="add-sku-section">
      <h3 class="add-sku-section__title">基础信息</h3>
      <div class="add-sku-grid">
        <label class="add-sku-field">
          <span class="add-sku-field__label">品名<i aria-hidden="true">*</i></span>
          <ElInput v-model="draft.product" placeholder="例如：挪威网" clearable />
        </label>
        <label class="add-sku-field">
          <span class="add-sku-field__label">颜色<i aria-hidden="true">*</i></span>
          <ElInput v-model="draft.color" placeholder="例如：1#黑色" clearable />
        </label>
        <label class="add-sku-field">
          <span class="add-sku-field__label">色彩</span>
          <ElSelect
            v-model="draft.category"
            class="add-sku-select"
            filterable
            allow-create
            default-first-option
            placeholder="黑白 / 彩色"
          >
            <ElOption v-for="category in CATEGORIES" :key="category" :label="category" :value="category" />
          </ElSelect>
        </label>
        <label class="add-sku-field">
          <span class="add-sku-field__label">树形分类</span>
          <ElInput v-model="draft.treeCategory" placeholder="采购下单用的分类，可留空" clearable />
        </label>
      </div>
    </section>

    <section class="add-sku-section">
      <h3 class="add-sku-section__title">数量</h3>
      <div class="add-sku-grid add-sku-grid--compact">
        <label v-for="field in SKU_QUANTITY_INPUTS" :key="field.field" class="add-sku-field">
          <span class="add-sku-field__label">{{ field.label }}</span>
          <ElInputNumber
            v-model="draft[field.field]"
            :min="0"
            :controls="false"
            :value-on-clear="null"
            class="add-sku-number"
            :aria-label="field.label"
          />
        </label>
      </div>
    </section>

    <section class="add-sku-section">
      <h3 class="add-sku-section__title">动销指标</h3>
      <div class="add-sku-grid add-sku-grid--compact">
        <label v-for="field in SKU_METRIC_INPUTS" :key="field.field" class="add-sku-field">
          <span class="add-sku-field__label">{{ field.label }}</span>
          <ElInputNumber
            v-model="draft[field.field]"
            :min="0"
            :controls="false"
            :value-on-clear="null"
            class="add-sku-number"
            :aria-label="field.label"
          />
        </label>
      </div>
      <p class="add-sku-tip">月均条数留空时按「累积条数 ÷ 动销月份」自动计算，它决定该 SKU 落在哪个备货模式。1-12 月的销量与订单数只来自销售表：手动添加的 SKU 没有月度数据，加权月销量为空、日库销比显示「∞」（按销量为 0 处理）。</p>
    </section>

    <template #footer>
      <div class="dialog-footer">
        <ElButton @click="dialogVisible = false">取消</ElButton>
        <ElButton type="primary" @click="submit">添加</ElButton>
      </div>
    </template>
  </ElDialog>
</template>

<style scoped>
.add-sku-hint {
  margin: 0 0 12px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.add-sku-section + .add-sku-section {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--industrial-grid-light);
}

.add-sku-section__title {
  margin: 0 0 8px;
  color: var(--industrial-text);
  font-size: 13px;
  font-weight: 600;
}

.add-sku-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 8px 12px;
}

.add-sku-grid--compact {
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}

.add-sku-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.add-sku-field__label {
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.4;
}

.add-sku-field__label i {
  margin-left: 2px;
  color: var(--industrial-danger);
  font-style: normal;
}

.add-sku-select,
.add-sku-number {
  width: 100%;
}

.add-sku-tip {
  margin: 8px 0 0;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.5;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:global(.el-dialog.add-sku-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
  width: min(820px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
}

:global(.el-dialog.add-sku-dialog .el-dialog__body) {
  min-height: 0;
  overflow: auto;
}
</style>
