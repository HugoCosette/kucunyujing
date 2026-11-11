<script setup>
import { computed, ref, watch } from 'vue'
import { ElButton, ElInput, ElMessage, ElOption, ElSelect, ElSwitch } from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import { DEFAULT_PANEL_KEY } from '@/data/panels'
import { useInventoryStore } from '@/stores/inventory'
import { usePurchaseStore } from '@/stores/purchase'
import {
  exportSettingsFile,
  importSettingsFile,
  normalizeSettings,
} from '@/purchase'
import { readWorkbookRows } from '@/utils/xlsxStream'

// 下单设置：染厂清单、树形分类与分单人员、SKU 可选染厂，全部落盘到 src/purchase/settings.json。
// 页面用草稿编辑，点「确定」才写回；导入 Excel 只负责补齐名单，不动已有的启用状态与分配。
const props = defineProps({
  panelKey: {
    type: String,
    default: DEFAULT_PANEL_KEY,
  },
})

const purchaseStore = usePurchaseStore()
const inventoryStore = useInventoryStore(props.panelKey)

const draft = ref(normalizeSettings(purchaseStore.settings))

const signature = (settings) =>
  JSON.stringify({
    dyeFactories: settings.dyeFactories,
    treeCategories: settings.treeCategories,
    skuFactories: settings.skuFactories,
    skuCategoryOverrides: settings.skuCategoryOverrides,
  })
const dirty = computed(() => signature(draft.value) !== signature(purchaseStore.settings))

const newFactoryName = ref('')
const newCategoryName = ref('')
const skuKeyword = ref('')
const importInputRef = ref(null)
const settingsInputRef = ref(null)
const importMode = ref('')

watch(
  () => purchaseStore.settings,
  (next) => {
    if (!dirty.value) draft.value = normalizeSettings(next)
  },
)

const itemBySkuId = computed(() => {
  const map = new Map()
  for (const item of inventoryStore.inventoryItems) {
    const skuId = String(item.skuId ?? '').trim()
    if (skuId) map.set(skuId, item)
  }
  return map
})

const skuCandidates = computed(() => {
  const text = skuKeyword.value.trim().toLowerCase()
  if (!text) return []
  const matched = []
  for (const item of inventoryStore.inventoryItems) {
    const skuId = String(item.skuId ?? '').trim()
    if (!skuId) continue
    const product = String(item.product ?? '').toLowerCase()
    const color = String(item.color ?? '').toLowerCase()
    if (!product.includes(text) && !color.includes(text)) continue
    matched.push({ skuId, product: item.product, color: item.color })
    if (matched.length >= 30) break
  }
  return matched
})

const configuredSkus = computed(() =>
  Object.entries(draft.value.skuFactories).map(([skuId, ids]) => {
    const item = itemBySkuId.value.get(skuId)
    return {
      skuId,
      ids,
      product: item?.product ?? skuId.split('|')[0] ?? skuId,
      color: item?.color ?? skuId.split('|')[1] ?? '',
      treeCategory: item?.treeCategory ?? '',
    }
  }),
)

const factoryOptions = computed(() => draft.value.dyeFactories)
const categoryOptions = computed(() => draft.value.treeCategories.map((entry) => entry.name))

function nextFactoryId() {
  const used = new Set(draft.value.dyeFactories.map((factory) => factory.id))
  let index = draft.value.dyeFactories.length + 1
  while (used.has(`df-${index}`)) index += 1
  return `df-${index}`
}

function addFactory() {
  const name = newFactoryName.value.trim()
  if (!name) return
  if (draft.value.dyeFactories.some((factory) => factory.name === name)) {
    ElMessage.warning(`染厂「${name}」已存在`)
    return
  }
  draft.value.dyeFactories.push({ id: nextFactoryId(), name, enabled: true })
  newFactoryName.value = ''
}

function removeFactory(index) {
  const [removed] = draft.value.dyeFactories.splice(index, 1)
  if (!removed) return
  for (const [skuId, ids] of Object.entries(draft.value.skuFactories)) {
    const next = ids.filter((id) => id !== removed.id)
    if (next.length) draft.value.skuFactories[skuId] = next
    else delete draft.value.skuFactories[skuId]
  }
}

function addCategory() {
  const name = newCategoryName.value.trim()
  if (!name) return
  if (draft.value.treeCategories.some((entry) => entry.name === name)) {
    ElMessage.warning(`分类「${name}」已存在`)
    return
  }
  draft.value.treeCategories.push({ name, assignees: [] })
  newCategoryName.value = ''
}

function removeCategory(index) {
  draft.value.treeCategories.splice(index, 1)
}

function addSkuConfig(candidate) {
  if (!candidate?.skuId) return
  if (draft.value.skuFactories[candidate.skuId]) {
    ElMessage.info(`「${candidate.product} ${candidate.color}」已单独配置`)
    return
  }
  // 新加入的 SKU 先全选启用染厂，用户再取消不可用的那几个。
  draft.value.skuFactories[candidate.skuId] = draft.value.dyeFactories
    .filter((factory) => factory.enabled !== false)
    .map((factory) => factory.id)
  skuKeyword.value = ''
}

function removeSkuConfig(skuId) {
  delete draft.value.skuFactories[skuId]
}

function setSkuCategory(skuId, category) {
  const value = String(category ?? '').trim()
  if (value) draft.value.skuCategoryOverrides[skuId] = value
  else delete draft.value.skuCategoryOverrides[skuId]
}

// 从 Excel 读一列：前 10 行里定位表头，之后逐行取该列的非空文本。
async function readColumnValues(file, headerName) {
  const data = await file.arrayBuffer()
  const { rows } = readWorkbookRows(data)

  let headerRowNumber = null
  let columnIndex = -1
  for (const row of rows.slice(0, 10)) {
    const index = row.cells.findIndex((cell) => String(cell ?? '').trim() === headerName)
    if (index >= 0) {
      headerRowNumber = row.rowNumber
      columnIndex = index
      break
    }
  }
  if (headerRowNumber === null) throw new Error(`未找到「${headerName}」列`)

  const values = []
  let started = false
  for (const row of rows) {
    if (!started) {
      if (row.rowNumber === headerRowNumber) started = true
      continue
    }
    const value = String(row.cells[columnIndex] ?? '').trim()
    if (value) values.push(value)
  }
  return values
}

function pickImportFile(mode) {
  importMode.value = mode
  importInputRef.value?.click()
}

async function handleImportFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return

  try {
    if (importMode.value === 'factories') {
      const names = await readColumnValues(file, '染厂名称')
      const existing = new Set(draft.value.dyeFactories.map((factory) => factory.name))
      let added = 0
      for (const name of new Set(names)) {
        if (existing.has(name)) continue
        existing.add(name)
        draft.value.dyeFactories.push({ id: nextFactoryId(), name, enabled: true })
        added += 1
      }
      ElMessage.success(added ? `已新增 ${added} 家染厂` : '没有新的染厂')
      return
    }

    const names = await readColumnValues(file, '树形分类')
    const existing = new Set(draft.value.treeCategories.map((entry) => entry.name))
    let added = 0
    for (const name of new Set(names)) {
      if (existing.has(name)) continue
      existing.add(name)
      draft.value.treeCategories.push({ name, assignees: [] })
      added += 1
    }
    ElMessage.success(added ? `已新增 ${added} 个树形分类` : '没有新的树形分类')
  } catch (error) {
    ElMessage.error(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function pickSettingsFile() {
  settingsInputRef.value?.click()
}

async function handleSettingsFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return

  try {
    draft.value = importSettingsFile(await file.text())
    ElMessage.success('设置文件已载入草稿，点「确定」后生效')
  } catch (error) {
    ElMessage.error(`设置文件解析失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function exportSettings() {
  exportSettingsFile(draft.value)
  ElMessage.success('下单设置已导出')
}

function discard() {
  draft.value = normalizeSettings(purchaseStore.settings)
}

async function confirm() {
  const saved = await purchaseStore.applySettings(draft.value)
  draft.value = normalizeSettings(saved.settings)
  ElMessage.success(
    saved.written ? '下单设置已保存到 src/purchase/settings.json' : '下单设置已保存到本地缓存',
  )
}
</script>

<template>
  <main class="settings-page">
    <div class="settings-content">
      <PanelNavigation />

      <header class="settings-heading">
        <h1>下单设置</h1>
        <p>
          维护可选的染厂、每个树形分类的分单人员，以及哪些 SKU 只能选哪些染厂。保存后写入
          <code>src/purchase/settings.json</code>，采购下单页立即可用。
        </p>
      </header>

      <div class="settings-bar">
        <span class="settings-bar__state" :class="{ 'settings-bar__state--dirty': dirty }">
          {{ dirty ? '有未保存的修改' : '已保存' }}
        </span>
        <div class="settings-bar__actions">
          <ElButton size="small" @click="pickSettingsFile">导入设置文件</ElButton>
          <ElButton size="small" @click="exportSettings">导出设置文件</ElButton>
          <ElButton size="small" :disabled="!dirty" @click="discard">放弃</ElButton>
          <ElButton size="small" type="primary" :disabled="!dirty" @click="confirm">
            确定
          </ElButton>
        </div>
      </div>

      <section class="settings-card">
        <div class="settings-card__head">
          <div>
            <h2>染厂清单</h2>
            <p>分订单的染厂下拉取自这里；停用的染厂不出现在下拉里，但已有分订单保留原厂名。</p>
          </div>
          <div class="settings-card__tools">
            <ElButton size="small" @click="pickImportFile('factories')">从 Excel 导入</ElButton>
          </div>
        </div>

        <div class="settings-table" role="table" aria-label="染厂清单">
          <div class="settings-row settings-row--factory settings-row--head" role="row">
            <span role="columnheader">染厂名称</span>
            <span role="columnheader">启用</span>
            <span role="columnheader">操作</span>
          </div>
          <div
            v-for="(factory, index) in draft.dyeFactories"
            :key="factory.id"
            class="settings-row settings-row--factory"
            role="row"
          >
            <ElInput v-model="factory.name" size="small" aria-label="染厂名称" />
            <ElSwitch v-model="factory.enabled" size="small" aria-label="是否启用" />
            <ElButton size="small" text type="danger" @click="removeFactory(index)">删除</ElButton>
          </div>
          <p v-if="draft.dyeFactories.length === 0" class="settings-empty">还没有染厂</p>
        </div>

        <div class="settings-add">
          <ElInput
            v-model="newFactoryName"
            size="small"
            placeholder="新增染厂名称"
            class="settings-add__input"
            @keyup.enter="addFactory"
          />
          <ElButton size="small" @click="addFactory">添加染厂</ElButton>
        </div>
      </section>

      <section class="settings-card">
        <div class="settings-card__head">
          <div>
            <h2>树形分类与分单人员</h2>
            <p>
              一个 SKU 只属于一个树形分类（来自产品资料的「树形分类」列），分订单的分单人员下拉取该分类的名单。
            </p>
          </div>
          <div class="settings-card__tools">
            <ElButton size="small" @click="pickImportFile('categories')">
              从产品资料导入分类
            </ElButton>
          </div>
        </div>

        <div class="settings-table" role="table" aria-label="树形分类与分单人员">
          <div class="settings-row settings-row--category settings-row--head" role="row">
            <span role="columnheader">树形分类</span>
            <span role="columnheader">分单人员</span>
            <span role="columnheader">操作</span>
          </div>
          <div
            v-for="(category, index) in draft.treeCategories"
            :key="category.name"
            class="settings-row settings-row--category"
            role="row"
          >
            <span class="settings-cell">{{ category.name }}</span>
            <ElSelect
              v-model="category.assignees"
              size="small"
              multiple
              filterable
              allow-create
              default-first-option
              collapse-tags
              collapse-tags-tooltip
              placeholder="添加分单人员"
              aria-label="分单人员"
            >
              <ElOption
                v-for="person in category.assignees"
                :key="person"
                :label="person"
                :value="person"
              />
            </ElSelect>
            <ElButton size="small" text type="danger" @click="removeCategory(index)">删除</ElButton>
          </div>
          <p v-if="draft.treeCategories.length === 0" class="settings-empty">
            还没有树形分类
          </p>
        </div>

        <div class="settings-add">
          <ElInput
            v-model="newCategoryName"
            size="small"
            placeholder="新增树形分类名称"
            class="settings-add__input"
            @keyup.enter="addCategory"
          />
          <ElButton size="small" @click="addCategory">添加分类</ElButton>
        </div>
      </section>

      <section class="settings-card">
        <div class="settings-card__head">
          <div>
            <h2>SKU 可选染厂</h2>
            <p>
              没单独配置的 SKU 默认可用全部启用的染厂；需要限定染厂时在这里加入该 SKU，并取消不可用的染厂。
              树形分类留空则沿用产品资料里的分类。
            </p>
          </div>
          <span class="settings-card__count">已配置 {{ configuredSkus.length }} 个 SKU</span>
        </div>

        <div class="settings-add">
          <ElInput
            v-model="skuKeyword"
            size="small"
            placeholder="搜索品名或颜色，回车添加第一个结果"
            class="settings-add__input"
            clearable
            @keyup.enter="addSkuConfig(skuCandidates[0])"
          />
        </div>

        <div v-if="skuKeyword.trim()" class="settings-candidates">
          <button
            v-for="candidate in skuCandidates"
            :key="candidate.skuId"
            type="button"
            class="settings-candidate"
            @click="addSkuConfig(candidate)"
          >
            {{ candidate.product }} · {{ candidate.color }}
          </button>
          <p v-if="skuCandidates.length === 0" class="settings-empty">
            没有匹配的 SKU（需要先导入总表）
          </p>
        </div>

        <div class="settings-table" role="table" aria-label="SKU 可选染厂">
          <div class="settings-row settings-row--sku settings-row--head" role="row">
            <span role="columnheader">SKU</span>
            <span role="columnheader">树形分类</span>
            <span role="columnheader">可选染厂</span>
            <span role="columnheader">操作</span>
          </div>
          <div
            v-for="row in configuredSkus"
            :key="row.skuId"
            class="settings-row settings-row--sku"
            role="row"
          >
            <span class="settings-cell" :title="row.skuId">
              {{ row.product }} · {{ row.color }}
              <em v-if="!row.treeCategory" class="settings-cell__warn">分类未维护</em>
            </span>
            <ElSelect
              :model-value="draft.skuCategoryOverrides[row.skuId] ?? ''"
              size="small"
              filterable
              allow-create
              clearable
              placeholder="沿用导入值"
              aria-label="树形分类覆盖"
              @update:model-value="setSkuCategory(row.skuId, $event)"
            >
              <ElOption
                v-for="name in categoryOptions"
                :key="name"
                :label="name"
                :value="name"
              />
            </ElSelect>
            <ElSelect
              v-model="draft.skuFactories[row.skuId]"
              size="small"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择染厂（空 = 全部）"
              aria-label="可选染厂"
            >
              <ElOption
                v-for="factory in factoryOptions"
                :key="factory.id"
                :label="factory.name"
                :value="factory.id"
                :disabled="factory.enabled === false"
              />
            </ElSelect>
            <ElButton size="small" text type="danger" @click="removeSkuConfig(row.skuId)">
              删除
            </ElButton>
          </div>
          <p v-if="configuredSkus.length === 0" class="settings-empty">
            还没有单独配置的 SKU，全部 SKU 默认可用所有已启用染厂
          </p>
        </div>
      </section>

      <input
        ref="importInputRef"
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        class="settings-file-input"
        @change="handleImportFile"
      />
      <input
        ref="settingsInputRef"
        type="file"
        accept="application/json,.json"
        class="settings-file-input"
        @change="handleSettingsFile"
      />
    </div>
  </main>
</template>

<style scoped>
.settings-page {
  min-height: 100vh;
  padding: 12px;
  background: var(--industrial-page);
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px 24px;
  background: var(--industrial-surface);
  border: 1px solid var(--industrial-grid);
  border-radius: 6px;
}

.settings-heading h1 {
  margin: 0 0 4px;
  color: var(--industrial-text);
  font-size: 20px;
}

.settings-heading p {
  max-width: 900px;
  margin: 0;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.settings-heading code {
  padding: 1px 4px;
  background: var(--industrial-header);
  border-radius: 3px;
  font-size: 12px;
}

.settings-bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  background: var(--industrial-surface);
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
}

.settings-bar__state {
  color: var(--industrial-muted);
  font-size: 12px;
}

.settings-bar__state--dirty {
  color: var(--industrial-replenish);
  font-weight: 600;
}

.settings-bar__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.settings-card {
  padding: 12px 14px 14px;
  background: var(--industrial-surface);
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
}

.settings-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.settings-card__head h2 {
  margin: 0 0 4px;
  color: var(--industrial-text);
  font-size: 15px;
}

.settings-card__head p {
  max-width: 820px;
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.6;
}

.settings-card__count {
  color: var(--industrial-muted);
  font-size: 12px;
}

.settings-table {
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
  overflow: hidden;
}

.settings-row {
  display: grid;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--industrial-grid-light);
  font-size: 13px;
}

.settings-row:first-child {
  border-top: none;
}

.settings-row--head {
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-size: 12px;
  font-weight: 600;
}

.settings-row--factory {
  grid-template-columns: minmax(180px, 1fr) 72px 64px;
}

.settings-row--category {
  grid-template-columns: minmax(220px, 1fr) minmax(220px, 1.4fr) 64px;
}

.settings-row--sku {
  grid-template-columns: minmax(200px, 1.1fr) minmax(160px, 0.9fr) minmax(220px, 1.4fr) 64px;
}

.settings-cell {
  overflow: hidden;
  color: var(--industrial-text);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.settings-cell__warn {
  margin-left: 6px;
  color: var(--industrial-replenish);
  font-size: 11px;
  font-style: normal;
}

.settings-empty {
  margin: 0;
  padding: 16px 10px;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.settings-add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.settings-add__input {
  width: min(320px, 100%);
}

.settings-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed var(--industrial-grid);
  border-radius: 4px;
}

.settings-candidate {
  padding: 4px 10px;
  color: var(--industrial-text);
  background: var(--industrial-page);
  border: 1px solid var(--industrial-grid);
  border-radius: 12px;
  font-size: 12px;
  cursor: pointer;
}

.settings-candidate:hover {
  border-color: var(--industrial-primary);
  color: var(--industrial-primary);
}

.settings-file-input {
  display: none;
}
</style>
