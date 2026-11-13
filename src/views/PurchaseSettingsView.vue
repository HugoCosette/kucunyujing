<script setup>
import { computed, ref, watch } from 'vue'
import { ElButton, ElCheckbox, ElCheckboxGroup, ElInput, ElMessage, ElOption, ElSelect, ElSwitch } from 'element-plus'
import PanelNavigation from '@/components/PanelNavigation.vue'
import VatRuleSettings from '@/components/VatRuleSettings.vue'
import { useInventoryStore } from '@/stores/inventory'
import { usePurchaseStore } from '@/stores/purchase'
import {
  exportSettingsFile,
  importSettingsFile,
  normalizeSettings,
  validateVatRules,
} from '@/purchase'
import { readWorkbookRows } from '@/utils/xlsxStream'

// 下单设置：染厂清单、分单人员表、树形分类、SKU 可选染厂、缸规则，全部落盘到 src/purchase/settings.json。
// 页面用草稿编辑，点「确定」才写回；导入 Excel 只负责补齐名单，不动已有的启用状态与分配。
const purchaseStore = usePurchaseStore()
const inventoryStore = useInventoryStore()

const draft = ref(normalizeSettings(purchaseStore.settings))
const selectedCategoryName = ref(draft.value.treeCategories[0]?.name ?? '')
const selectedCategory = computed(
  () => draft.value.treeCategories.find((entry) => entry.name === selectedCategoryName.value) ?? null,
)

// 分类被删掉 / 设置被替换（导入、放弃、确定）后，保证下拉框仍停在一个存在的分类上。
watch(
  () => draft.value.treeCategories.map((entry) => entry.name),
  (names) => {
    if (names.includes(selectedCategoryName.value)) return
    selectedCategoryName.value = names[0] ?? ''
  },
)

const signature = (settings) =>
  JSON.stringify({
    dyeFactories: settings.dyeFactories,
    assignees: settings.assignees,
    treeCategories: settings.treeCategories,
    skuFactories: settings.skuFactories,
    skuCategoryOverrides: settings.skuCategoryOverrides,
    vatRules: settings.vatRules,
    defaultVatRuleId: settings.defaultVatRuleId,
    spuVatRules: settings.spuVatRules,
  })
const dirty = computed(() => signature(draft.value) !== signature(purchaseStore.settings))

// 缸规则面板只读写草稿里的三个字段，保存 / 放弃仍由本页统一处理。
const vatSettings = computed({
  get: () => ({
    vatRules: draft.value.vatRules,
    defaultVatRuleId: draft.value.defaultVatRuleId,
    spuVatRules: draft.value.spuVatRules,
  }),
  set: (value) => {
    draft.value.vatRules = value.vatRules
    draft.value.defaultVatRuleId = value.defaultVatRuleId
    draft.value.spuVatRules = value.spuVatRules
  },
})

// 品名（SPU）候选：SKU 数与该品名的月均条数合计，绑定缸规则时用来判断影响面。
const spuOptions = computed(() => {
  const map = new Map()
  for (const item of inventoryStore.inventoryItems) {
    const product = String(item.product ?? '').trim()
    if (!product) continue
    const entry = map.get(product) ?? { product, skuCount: 0, monthlyAvg: 0 }
    entry.skuCount += 1
    if (Number.isFinite(item.monthlyAvgCount)) entry.monthlyAvg += item.monthlyAvgCount
    map.set(product, entry)
  }
  return [...map.values()].sort((a, b) => a.product.localeCompare(b.product, 'zh-CN'))
})

const newFactoryName = ref('')
const newPersonName = ref('')
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

function addPerson() {
  const name = newPersonName.value.trim()
  if (!name) return
  if (draft.value.assignees.includes(name)) {
    ElMessage.warning(`分单人员「${name}」已存在`)
    return
  }
  draft.value.assignees.push(name)
  newPersonName.value = ''
}

// 人员从表里删除后，各分类里同名的分配一并清掉，避免留下选不到的名字。
function removePerson(index) {
  const [removed] = draft.value.assignees.splice(index, 1)
  if (!removed) return
  for (const category of draft.value.treeCategories) {
    category.assignees = category.assignees.filter((person) => person !== removed)
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
  selectedCategoryName.value = name
}

function removeCategory(index) {
  const [removed] = draft.value.treeCategories.splice(index, 1)
  if (removed && removed.name === selectedCategoryName.value) {
    selectedCategoryName.value = draft.value.treeCategories[index]?.name ?? ''
  }
}

function removeSelectedCategory() {
  const index = draft.value.treeCategories.findIndex(
    (entry) => entry.name === selectedCategoryName.value,
  )
  if (index >= 0) removeCategory(index)
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
  const errors = validateVatRules(draft.value.vatRules)
  if (errors.length) {
    ElMessage.error(errors[0].message)
    return
  }
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
          维护可选的染厂、分单人员表、树形分类的分单人员、哪些 SKU 只能选哪些染厂，以及按品名（SPU）生效的缸规则。保存后写入
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

      <VatRuleSettings v-model="vatSettings" :spus="spuOptions" />

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
            <h2>分单人员表</h2>
            <p>
              下单时的分单人员只能从这里选；在下方各树形分类里点人员名字即可分配。
            </p>
          </div>
          <span class="settings-card__count">共 {{ draft.assignees.length }} 人</span>
        </div>

        <div class="settings-people" role="list" aria-label="分单人员表">
          <span
            v-for="(person, index) in draft.assignees"
            :key="person"
            class="person-chip person-chip--roster"
            role="listitem"
          >
            {{ person }}
            <button
              type="button"
              class="person-chip__remove"
              :aria-label="`删除分单人员 ${person}`"
              @click="removePerson(index)"
            >
              ×
            </button>
          </span>
          <span v-if="draft.assignees.length === 0" class="settings-inline-empty">
            还没有分单人员
          </span>
        </div>

        <div class="settings-add">
          <ElInput
            v-model="newPersonName"
            size="small"
            placeholder="新增分单人员姓名"
            class="settings-add__input"
            @keyup.enter="addPerson"
          />
          <ElButton size="small" @click="addPerson">添加人员</ElButton>
        </div>
      </section>

      <section class="settings-card">
        <div class="settings-card__head">
          <div>
            <h2>树形分类与分单人员</h2>
            <p>
              一个 SKU 只属于一个树形分类（来自产品资料的「树形分类」列）。先在下拉框里选分类，再给这个分类打勾分单人员；下单页优先用这里勾选的人，分类没勾人时回退到分单人员表全部人员。
            </p>
          </div>
          <div class="settings-card__tools">
            <ElButton size="small" @click="pickImportFile('categories')">
              从产品资料导入分类
            </ElButton>
          </div>
        </div>

        <div class="settings-category-picker">
          <div class="settings-category-picker__row">
            <ElSelect
              v-model="selectedCategoryName"
              size="small"
              filterable
              placeholder="选择树形分类"
              class="settings-category-picker__select"
            >
              <ElOption
                v-for="category in draft.treeCategories"
                :key="category.name"
                :label="category.name"
                :value="category.name"
              >
                <span class="settings-category-option">
                  <span class="settings-category-option__name">{{ category.name }}</span>
                  <span class="settings-category-option__count">
                    {{ category.assignees.length }} 人
                  </span>
                </span>
              </ElOption>
            </ElSelect>
            <span class="settings-card__count">共 {{ draft.treeCategories.length }} 个分类</span>
          </div>

          <div v-if="selectedCategory" class="settings-category-editor">
            <div class="settings-category-editor__head">
              <strong class="settings-category-editor__name">{{ selectedCategory.name }}</strong>
              <span class="settings-category-editor__count">
                {{ selectedCategory.assignees.length }} 人已分配
              </span>
              <ElButton
                class="settings-category-editor__remove"
                size="small"
                text
                type="danger"
                @click="removeSelectedCategory"
              >
                删除该分类
              </ElButton>
            </div>
            <ElCheckboxGroup
              v-model="selectedCategory.assignees"
              class="settings-category-editor__people"
            >
              <ElCheckbox v-for="person in draft.assignees" :key="person" :value="person">
                {{ person }}
              </ElCheckbox>
            </ElCheckboxGroup>
            <span v-if="draft.assignees.length === 0" class="settings-inline-empty">
              请先在「分单人员表」添加人员
            </span>
          </div>
          <p v-else class="settings-empty">还没有树形分类</p>
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

.settings-row--sku {
  grid-template-columns: minmax(200px, 1.1fr) minmax(160px, 0.9fr) minmax(220px, 1.4fr) 64px;
}

.settings-people {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 2px 0 4px;
}

.person-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  color: var(--industrial-text);
  background: var(--industrial-page);
  border: 1px solid var(--industrial-grid);
  border-radius: 12px;
  font-size: 12px;
  line-height: 1.6;
}

.person-chip--roster {
  padding-right: 4px;
}

.person-chip__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  color: var(--industrial-muted);
  background: transparent;
  border: none;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.person-chip__remove:hover {
  color: #b45454;
  background: rgba(180, 84, 84, 0.12);
}

.settings-inline-empty {
  color: var(--industrial-muted);
  font-size: 12px;
}

.settings-category-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  background: var(--industrial-surface);
  border: 1px solid var(--industrial-grid-light);
  border-radius: 6px;
}

.settings-category-picker__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.settings-category-picker__select {
  width: min(340px, 100%);
}

.settings-category-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.settings-category-option__count {
  color: var(--industrial-muted);
  font-size: 11px;
}

.settings-category-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--industrial-grid-light);
}

.settings-category-editor__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  color: var(--industrial-text);
  font-size: 13px;
}

.settings-category-editor__name {
  font-weight: 600;
}

.settings-category-editor__count {
  color: var(--industrial-muted);
  font-size: 12px;
}

.settings-category-editor__remove {
  margin-left: auto;
}

.settings-category-editor__people {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
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
