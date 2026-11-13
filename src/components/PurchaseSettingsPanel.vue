<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElButton, ElCheckbox, ElCheckboxGroup, ElDialog, ElInput, ElMessage, ElOption, ElSelect, ElSwitch } from 'element-plus'
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
// 本组件只负责内容区；外壳（导航 / 顶部工具条 / 左栏）在 ConfigView 里统一渲染。
defineProps({
  activePanel: {
    type: String,
    default: 'vat',
  },
})

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

// ---------------------------------------------------------------------------
// 以下只服务于新的展示层：分区切换与只读表格的弹窗草稿。
// 写入仍落在 draft 上，保存 / 放弃由统一的外壳工具条处理。
// ---------------------------------------------------------------------------
const enabledFactoryCount = computed(
  () => draft.value.dyeFactories.filter((factory) => factory.enabled !== false).length,
)

// 左栏摘要：外壳只读这个对象，不直接碰 draft。
const meta = computed(() => ({
  vatRules: draft.value.vatRules.length,
  factories: draft.value.dyeFactories.length,
  enabledFactories: enabledFactoryCount.value,
  people: draft.value.assignees.length,
  categories: draft.value.treeCategories.length,
  skus: configuredSkus.value.length,
}))

function personCategories(person) {
  return draft.value.treeCategories
    .filter((category) => category.assignees?.includes(person))
    .map((category) => category.name)
    .join('、')
}

function factoryName(factoryId) {
  return (
    draft.value.dyeFactories.find((factory) => factory.id === factoryId)?.name ?? String(factoryId)
  )
}

// —— 染厂弹窗 ——
const factoryDialogVisible = ref(false)
const factoryEditingId = ref('')
const factoryDraft = reactive({ name: '', enabled: true })

function openCreateFactory() {
  factoryEditingId.value = ''
  factoryDraft.name = ''
  factoryDraft.enabled = true
  factoryDialogVisible.value = true
}

function openEditFactory(factory) {
  factoryEditingId.value = factory.id
  factoryDraft.name = factory.name
  factoryDraft.enabled = factory.enabled !== false
  factoryDialogVisible.value = true
}

function saveFactoryDraft() {
  const name = factoryDraft.name.trim()
  if (!name) {
    ElMessage.warning('染厂名称不能为空')
    return
  }
  if (
    draft.value.dyeFactories.some(
      (factory) => factory.name === name && factory.id !== factoryEditingId.value,
    )
  ) {
    ElMessage.warning(`染厂「${name}」已存在`)
    return
  }
  if (factoryEditingId.value) {
    const target = draft.value.dyeFactories.find((factory) => factory.id === factoryEditingId.value)
    if (target) {
      target.name = name
      target.enabled = factoryDraft.enabled
    }
  } else {
    draft.value.dyeFactories.push({ id: nextFactoryId(), name, enabled: factoryDraft.enabled })
  }
  factoryDialogVisible.value = false
}

// —— 分单人员弹窗 ——
const personDialogVisible = ref(false)
const personDraft = reactive({ name: '' })

function openCreatePerson() {
  personDraft.name = ''
  personDialogVisible.value = true
}

function savePersonDraft() {
  const name = personDraft.name.trim()
  if (!name) {
    ElMessage.warning('姓名不能为空')
    return
  }
  if (draft.value.assignees.includes(name)) {
    ElMessage.warning(`分单人员「${name}」已存在`)
    return
  }
  draft.value.assignees.push(name)
  personDialogVisible.value = false
}

// —— 分类弹窗 ——
const categoryDialogVisible = ref(false)
const categoryEditingName = ref('')
const categoryDraft = reactive({ name: '', assignees: [] })

function openCreateCategory() {
  categoryEditingName.value = ''
  categoryDraft.name = ''
  categoryDraft.assignees = []
  categoryDialogVisible.value = true
}

function openEditCategory(category) {
  categoryEditingName.value = category.name
  categoryDraft.name = category.name
  categoryDraft.assignees = [...(category.assignees ?? [])]
  categoryDialogVisible.value = true
}

function saveCategoryDraft() {
  const name = categoryDraft.name.trim()
  if (!name) {
    ElMessage.warning('分类名称不能为空')
    return
  }
  if (categoryEditingName.value) {
    const target = draft.value.treeCategories.find(
      (category) => category.name === categoryEditingName.value,
    )
    if (target) target.assignees = [...categoryDraft.assignees]
  } else {
    if (draft.value.treeCategories.some((category) => category.name === name)) {
      ElMessage.warning(`分类「${name}」已存在`)
      return
    }
    draft.value.treeCategories.push({ name, assignees: [...categoryDraft.assignees] })
    selectedCategoryName.value = name
  }
  categoryDialogVisible.value = false
}

// —— SKU 可选染厂弹窗 ——
const skuDialogVisible = ref(false)
const skuAddDialogVisible = ref(false)
const skuEditingId = ref('')
const skuDraft = reactive({ category: '', factoryIds: [] })
const skuEditingRow = computed(
  () => configuredSkus.value.find((row) => row.skuId === skuEditingId.value) ?? null,
)

function openEditSku(row) {
  skuEditingId.value = row.skuId
  skuDraft.category = draft.value.skuCategoryOverrides[row.skuId] ?? ''
  skuDraft.factoryIds = [...(row.ids ?? [])]
  skuDialogVisible.value = true
}

function saveSkuDraft() {
  setSkuCategory(skuEditingId.value, skuDraft.category)
  draft.value.skuFactories[skuEditingId.value] = [...skuDraft.factoryIds]
  skuDialogVisible.value = false
}

// 新增入口：复用同一个搜索框与候选列表，选中后立即按「全部启用染厂」加入。
function addSkuFromDialog(candidate) {
  addSkuConfig(candidate)
  skuAddDialogVisible.value = false
}

// 外壳工具条通过 ref 调用这几个方法；dirty / meta 用于状态标签与左栏摘要。
defineExpose({ dirty, meta, discard, confirm, pickSettingsFile, exportSettings })
</script>

<template>
  <div class="purchase-settings">
          <!-- 缸规则 -->
          <VatRuleSettings v-show="activePanel === 'vat'" v-model="vatSettings" :spus="spuOptions" />

          <!-- 染厂清单 -->
          <section v-show="activePanel === 'factories'" class="panel">
            <div class="panel__head">
              <h2 class="panel__title">染厂清单</h2>
            </div>
            <div class="panel__body">
              <div class="tbl-block">
                <table class="score-table">
                  <thead>
                    <tr>
                      <th>染厂名称</th>
                      <th style="width: 84px">状态</th>
                      <th class="is-actions" style="width: 64px">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(factory, index) in draft.dyeFactories" :key="factory.id">
                      <td>{{ factory.name }}</td>
                      <td>
                        <span class="tag" :class="{ 'tag--muted': factory.enabled === false }">
                          {{ factory.enabled === false ? '停用' : '启用' }}
                        </span>
                      </td>
                      <td class="is-actions">
                        <span class="row-acts">
                          <button
                            type="button"
                            class="icon-btn"
                            title="编辑"
                            @click="openEditFactory(factory)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="m10.6 2.9 2.5 2.5-7.1 7.1-3.1.6.6-3.1 7.1-7.1Z"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="icon-btn icon-btn--danger"
                            title="删除"
                            @click="removeFactory(index)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8M6.7 6.6v4M9.3 6.6v4"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linecap="round"
                              />
                            </svg>
                          </button>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="draft.dyeFactories.length === 0" class="manual-block__empty">还没有染厂</p>
                <div class="tbl-foot">
                  <span class="tbl-foot__hint">
                    共 {{ draft.dyeFactories.length }} 家 · {{ enabledFactoryCount }} 家启用
                  </span>
                  <button type="button" class="btn btn--text btn--sm" @click="pickImportFile('factories')">
                    从 Excel 导入
                  </button>
                  <button type="button" class="btn btn--sm" @click="openCreateFactory">新增</button>
                </div>
              </div>
            </div>
          </section>

          <!-- 分单人员表 -->
          <section v-show="activePanel === 'people'" class="panel">
            <div class="panel__head">
              <h2 class="panel__title">分单人员表</h2>
            </div>
            <div class="panel__body">
              <div class="tbl-block">
                <div v-if="draft.assignees.length" class="person-cards">
                  <span
                    v-for="(person, index) in draft.assignees"
                    :key="person"
                    class="person-card"
                    :title="personCategories(person) || '未分配分类'"
                  >
                    <span class="person-card__name">{{ person }}</span>
                    <button
                      type="button"
                      class="person-card__remove"
                      title="删除"
                      :aria-label="`删除 ${person}`"
                      @click="removePerson(index)"
                    >
                      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path
                          d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                        />
                      </svg>
                    </button>
                  </span>
                </div>
                <p v-else class="manual-block__empty">还没有分单人员</p>
                <div class="tbl-foot">
                  <span class="tbl-foot__hint">
                    共 {{ draft.assignees.length }} 人 · 分单时先按树形分类找人
                  </span>
                  <button type="button" class="btn btn--sm" @click="openCreatePerson">新增</button>
                </div>
              </div>
            </div>
          </section>

          <!-- 树形分类与分单人员 -->
          <section v-show="activePanel === 'categories'" class="panel">
            <div class="panel__head">
              <h2 class="panel__title">树形分类与分单人员</h2>
            </div>
            <div class="panel__body">
              <div class="tbl-block">
                <table class="score-table">
                  <thead>
                    <tr>
                      <th style="width: 168px">树形分类</th>
                      <th>分单人员</th>
                      <th class="is-actions" style="width: 64px">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(category, index) in draft.treeCategories" :key="category.name">
                      <td>{{ category.name }}</td>
                      <td>
                        <span v-if="category.assignees.length" class="chips">
                          <span v-for="person in category.assignees" :key="person" class="chip">
                            {{ person }}
                          </span>
                        </span>
                        <span v-else class="score-table__muted">
                          未分配（回退到分单人员表全部人员）
                        </span>
                      </td>
                      <td class="is-actions">
                        <span class="row-acts">
                          <button
                            type="button"
                            class="icon-btn"
                            title="编辑"
                            @click="openEditCategory(category)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="m10.6 2.9 2.5 2.5-7.1 7.1-3.1.6.6-3.1 7.1-7.1Z"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="icon-btn icon-btn--danger"
                            title="删除"
                            @click="removeCategory(index)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8M6.7 6.6v4M9.3 6.6v4"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linecap="round"
                              />
                            </svg>
                          </button>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="draft.treeCategories.length === 0" class="manual-block__empty">
                  还没有树形分类
                </p>
                <div class="tbl-foot">
                  <span class="tbl-foot__hint">
                    共 {{ draft.treeCategories.length }} 个分类 · 未分配时回退到分单人员表
                  </span>
                  <button type="button" class="btn btn--text btn--sm" @click="pickImportFile('categories')">
                    从产品资料导入
                  </button>
                  <button type="button" class="btn btn--sm" @click="openCreateCategory">新增</button>
                </div>
              </div>
            </div>
          </section>

          <!-- SKU 可选染厂 -->
          <section v-show="activePanel === 'sku-factories'" class="panel">
            <div class="panel__head">
              <h2 class="panel__title">SKU 可选染厂</h2>
            </div>
            <div class="panel__body">
              <div class="tbl-block tbl-block--wide">
                <div class="tbl-toolbar">
                  <label class="field">
                    <svg class="field__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.3" />
                      <path
                        d="m10.4 10.4 3 3"
                        stroke="currentColor"
                        stroke-width="1.3"
                        stroke-linecap="round"
                      />
                    </svg>
                    <input
                      v-model="skuKeyword"
                      class="input input--search"
                      placeholder="搜索品名 / 颜色，点结果加入"
                      style="width: 232px"
                    />
                  </label>
                  <span class="tbl-toolbar__meta">
                    已配置 {{ configuredSkus.length }} 个 SKU
                  </span>
                </div>

                <div v-if="skuKeyword.trim()" class="sku-candidates">
                  <button
                    v-for="candidate in skuCandidates"
                    :key="candidate.skuId"
                    type="button"
                    class="sku-candidate"
                    @click="addSkuConfig(candidate)"
                  >
                    {{ candidate.product }} · {{ candidate.color }}
                  </button>
                  <p v-if="skuCandidates.length === 0" class="sku-candidates__empty">
                    没有匹配的 SKU（需要先导入总表）
                  </p>
                </div>

                <table class="score-table">
                  <thead>
                    <tr>
                      <th style="width: 148px">唯一标识</th>
                      <th style="width: 188px">品名 / 颜色</th>
                      <th style="width: 110px">树形分类</th>
                      <th>可选染厂</th>
                      <th class="is-actions" style="width: 64px">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in configuredSkus" :key="row.skuId">
                      <td class="score-table__mono">{{ row.skuId }}</td>
                      <td>{{ row.product }} · {{ row.color }}</td>
                      <td>
                        {{ draft.skuCategoryOverrides[row.skuId] ?? row.treeCategory ?? '—' }}
                      </td>
                      <td>
                        <span v-if="row.ids.length" class="chips">
                          <span v-for="id in row.ids" :key="id" class="tag">
                            {{ factoryName(id) }}
                          </span>
                        </span>
                        <span v-else class="score-table__muted">全部启用染厂</span>
                      </td>
                      <td class="is-actions">
                        <span class="row-acts">
                          <button
                            type="button"
                            class="icon-btn"
                            title="编辑"
                            @click="openEditSku(row)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="m10.6 2.9 2.5 2.5-7.1 7.1-3.1.6.6-3.1 7.1-7.1Z"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linejoin="round"
                              />
                            </svg>
                          </button>
                          <button
                            type="button"
                            class="icon-btn icon-btn--danger"
                            title="删除"
                            @click="removeSkuConfig(row.skuId)"
                          >
                            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                              <path
                                d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8M6.7 6.6v4M9.3 6.6v4"
                                stroke="currentColor"
                                stroke-width="1.2"
                                stroke-linecap="round"
                              />
                            </svg>
                          </button>
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="configuredSkus.length === 0" class="manual-block__empty">
                  还没有单独配置的 SKU，全部 SKU 默认可用所有已启用染厂
                </p>

                <div class="tbl-foot">
                  <span class="tbl-foot__hint">
                    未单独配置 = 全部启用染厂可选；空列表同样视为全部
                  </span>
                  <button type="button" class="btn btn--sm" @click="skuAddDialogVisible = true">
                    新增
                  </button>
                </div>
              </div>
            </div>
          </section>

    <!-- 染厂编辑 -->
    <ElDialog
      v-model="factoryDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      :title="factoryEditingId ? '编辑染厂' : '新增染厂'"
    >
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">染厂名称</span>
          <div class="form__row-ctrl">
            <ElInput v-model="factoryDraft.name" size="small" aria-label="染厂名称" />
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">状态</span>
          <div class="form__row-ctrl">
            <ElSwitch v-model="factoryDraft.enabled" size="small" aria-label="是否启用" />
            <span class="form__row-hint">停用后不出现在下单下拉里，已有分订单保留原厂名。</span>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="factoryDialogVisible = false">
            取消
          </button>
          <button type="button" class="btn btn--primary btn--sm" @click="saveFactoryDraft">
            确定
          </button>
        </div>
      </template>
    </ElDialog>

    <!-- 分单人员新增 -->
    <ElDialog
      v-model="personDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      title="新增分单人员"
    >
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">姓名</span>
          <div class="form__row-ctrl">
            <ElInput
              v-model="personDraft.name"
              size="small"
              aria-label="分单人员姓名"
              @keyup.enter="savePersonDraft"
            />
          </div>
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="personDialogVisible = false">
            取消
          </button>
          <button type="button" class="btn btn--primary btn--sm" @click="savePersonDraft">
            确定
          </button>
        </div>
      </template>
    </ElDialog>

    <!-- 分类编辑 -->
    <ElDialog
      v-model="categoryDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      :title="categoryEditingName ? '编辑分类分单人员' : '新增树形分类'"
    >
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">分类名称</span>
          <div class="form__row-ctrl">
            <ElInput
              v-model="categoryDraft.name"
              size="small"
              :disabled="Boolean(categoryEditingName)"
              aria-label="树形分类名称"
            />
            <span v-if="categoryEditingName" class="form__row-hint">
              分类名来自产品资料，改名请重新导入。
            </span>
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">分单人员</span>
          <div class="form__row-ctrl">
            <ElCheckboxGroup v-model="categoryDraft.assignees" class="category-people">
              <ElCheckbox v-for="person in draft.assignees" :key="person" :value="person">
                {{ person }}
              </ElCheckbox>
            </ElCheckboxGroup>
            <span v-if="draft.assignees.length === 0" class="form__row-hint">
              请先在「分单人员表」添加人员。
            </span>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="categoryDialogVisible = false">
            取消
          </button>
          <button type="button" class="btn btn--primary btn--sm" @click="saveCategoryDraft">
            确定
          </button>
        </div>
      </template>
    </ElDialog>

    <!-- SKU 可选染厂编辑 -->
    <ElDialog
      v-model="skuAddDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      title="新增 SKU 约束"
    >
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">搜索 SKU</span>
          <div class="form__row-ctrl">
            <ElInput
              v-model="skuKeyword"
              size="small"
              clearable
              placeholder="品名或颜色"
              aria-label="搜索品名或颜色"
            />
            <span class="form__row-hint">需要先导入总表；点击结果即可加入约束。</span>
          </div>
        </div>
        <div class="chips">
          <button
            v-for="candidate in skuCandidates"
            :key="candidate.skuId"
            type="button"
            class="sku-candidate"
            @click="addSkuFromDialog(candidate)"
          >
            {{ candidate.product }} · {{ candidate.color }}
          </button>
        </div>
        <p v-if="skuKeyword.trim() && skuCandidates.length === 0" class="sku-candidates__empty">
          没有匹配的 SKU（需要先导入总表）
        </p>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="skuAddDialogVisible = false">
            取消
          </button>
        </div>
      </template>
    </ElDialog>

    <ElDialog
      v-model="skuDialogVisible"
      class="ui-dialog"
      width="560px"
      append-to-body
      align-center
      title="编辑 SKU 可选染厂"
    >
      <div v-if="skuEditingRow" class="form">
        <div class="form__row">
          <span class="form__row-label">品名 / 颜色</span>
          <div class="form__row-ctrl">
            <span class="form__static">
              {{ skuEditingRow.product }} · {{ skuEditingRow.color }}
            </span>
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">树形分类</span>
          <div class="form__row-ctrl">
            <ElSelect
              v-model="skuDraft.category"
              size="small"
              filterable
              allow-create
              clearable
              placeholder="沿用导入值"
              aria-label="树形分类覆盖"
            >
              <ElOption v-for="name in categoryOptions" :key="name" :label="name" :value="name" />
            </ElSelect>
            <span class="form__row-hint">留空表示沿用产品资料里的分类。</span>
          </div>
        </div>
        <div class="form__row">
          <span class="form__row-label">可选染厂</span>
          <div class="form__row-ctrl">
            <ElSelect
              v-model="skuDraft.factoryIds"
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
            <span class="form__row-hint">全不选 = 全部启用染厂可选。</span>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="skuDialogVisible = false">取消</button>
          <button type="button" class="btn btn--primary btn--sm" @click="saveSkuDraft">确定</button>
        </div>
      </template>
    </ElDialog>

    <input
      ref="settingsInputRef"
      type="file"
      accept="application/json,.json"
      class="hidden-input"
      @change="handleSettingsFile"
    />
    <input
      ref="importInputRef"
      type="file"
      accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      class="hidden-input"
      @change="handleImportFile"
    />
  </div>
</template>

<style scoped>
.hidden-input {
  display: none;
}

.sku-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
  padding: 6px 8px;
  border: 1px solid var(--industrial-grid-light);
  background: #f0f4f6;
}

.sku-candidate {
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 2px;
  background: #fff;
  color: var(--industrial-text);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}

.sku-candidate:hover {
  border-color: var(--industrial-primary);
  color: var(--industrial-primary);
}

.sku-candidates__empty {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.category-people {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}

.person-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--industrial-grid-light);
  background: #fff;
}

.person-card {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 13px;
  background: #f5f8fa;
  color: var(--industrial-text);
  font-size: 12.5px;
  line-height: 1;
}

.person-card__name {
  white-space: nowrap;
}

.person-card__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--industrial-muted);
  cursor: pointer;
}

.person-card__remove svg {
  width: 10px;
  height: 10px;
}

.person-card__remove:hover {
  background: rgba(211, 68, 68, 0.12);
  color: #c0392b;
}
</style>
