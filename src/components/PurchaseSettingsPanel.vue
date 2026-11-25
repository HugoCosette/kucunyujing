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
import { composeProductColorSkuId } from '@/utils/inventory'
import { readWorkbookRows } from '@/utils/xlsxStream'
import { saveWorkbook } from '@/utils/xlsxWrite'

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
const factoryKeyword = ref('')
const relationSkuKeyword = ref('')
const relationCandidateKeyword = ref('')
const selectedFactoryId = ref('')
const selectedCandidateSkuIds = ref([])
const relationAddDialogVisible = ref(false)
const relationImportDialogVisible = ref(false)
const relationImportRecords = ref([])
const relationImportLimitUnrestricted = ref(false)
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
  const text = relationCandidateKeyword.value.trim().toLowerCase()
  if (!text) return []
  const matched = []
  for (const item of inventoryStore.inventoryItems) {
    const skuId = String(item.skuId ?? '').trim()
    if (!skuId) continue
    const product = String(item.product ?? '').toLowerCase()
    const color = String(item.color ?? '').toLowerCase()
    const id = skuId.toLowerCase()
    if (!product.includes(text) && !color.includes(text) && !id.includes(text)) continue
    matched.push({
      skuId,
      product: item.product,
      color: item.color,
      treeCategory: item.treeCategory,
    })
    if (matched.length >= 100) break
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
const searchedFactories = computed(() => {
  const text = factoryKeyword.value.trim().toLowerCase()
  if (!text) return draft.value.dyeFactories
  return draft.value.dyeFactories.filter((factory) => factory.name.toLowerCase().includes(text))
})
const selectedFactory = computed(
  () => draft.value.dyeFactories.find((factory) => factory.id === selectedFactoryId.value) ?? null,
)
const currentFactorySkus = computed(() => {
  const factoryId = selectedFactoryId.value
  if (!factoryId) return []
  const text = relationSkuKeyword.value.trim().toLowerCase()
  return Object.entries(draft.value.skuFactories)
    .filter(([, ids]) => ids.includes(factoryId))
    .map(([skuId, ids]) => {
      const item = itemBySkuId.value.get(skuId)
      return {
        skuId,
        ids,
        product: item?.product ?? skuId.split('|')[0] ?? skuId,
        color: item?.color ?? skuId.split('|')[1] ?? '',
      }
    })
    .filter((row) => {
      if (!text) return true
      return [row.skuId, row.product, row.color].join(' ').toLowerCase().includes(text)
    })
    .sort((a, b) => a.product.localeCompare(b.product, 'zh-CN') || a.color.localeCompare(b.color, 'zh-CN'))
})
const factorySkuCounts = computed(() => {
  const counts = new Map(draft.value.dyeFactories.map((factory) => [factory.id, 0]))
  for (const factoryIds of Object.values(draft.value.skuFactories)) {
    for (const factoryId of new Set(factoryIds)) {
      if (counts.has(factoryId)) {
        counts.set(factoryId, counts.get(factoryId) + 1)
      }
    }
  }
  return counts
})
const relationImportRows = computed(() => {
  const factoriesByName = new Map(
    draft.value.dyeFactories.map((factory) => [factory.name.trim().toLowerCase(), factory]),
  )
  const seenPairs = new Set()
  return relationImportRecords.value.map((record) => {
    const factory = factoriesByName.get(record.factoryName.trim().toLowerCase())
    if (!factory) return { ...record, status: '未匹配染厂' }
    if (!itemBySkuId.value.has(record.skuId)) return { ...record, factory, status: '未匹配 SKU' }

    const pair = `${factory.id}\u0000${record.skuId}`
    if (seenPairs.has(pair)) return { ...record, factory, status: '文件内重复' }
    seenPairs.add(pair)

    const existing = draft.value.skuFactories[record.skuId]
    if (existing?.includes(factory.id)) return { ...record, factory, status: '已存在' }
    if (!existing && !relationImportLimitUnrestricted.value) {
      return { ...record, factory, status: '需确认限制范围' }
    }
    return {
      ...record,
      factory,
      status: existing ? '待新增' : '将该 SKU 限定为导入染厂',
    }
  })
})
const relationImportCounts = computed(() =>
  relationImportRows.value.reduce(
    (counts, row) => {
      counts[row.status] = (counts[row.status] ?? 0) + 1
      return counts
    },
    {},
  ),
)
const relationImportAddCount = computed(
  () =>
    (relationImportCounts.value['待新增'] ?? 0) +
    (relationImportCounts.value['将该 SKU 限定为导入染厂'] ?? 0),
)

watch(
  () => draft.value.dyeFactories.map((factory) => factory.id),
  (ids) => {
    if (!ids.includes(selectedFactoryId.value)) selectedFactoryId.value = ids[0] ?? ''
  },
  { immediate: true },
)

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

function isUnrestrictedSku(skuId) {
  return !Object.prototype.hasOwnProperty.call(draft.value.skuFactories, skuId)
}

function beginAddRelation() {
  if (!selectedFactory.value) {
    ElMessage.warning('请先选择染厂')
    return
  }
  relationCandidateKeyword.value = ''
  selectedCandidateSkuIds.value = []
  relationAddDialogVisible.value = true
}

function isAlreadyRelatedToSelectedFactory(skuId) {
  return draft.value.skuFactories[skuId]?.includes(selectedFactoryId.value) ?? false
}

function addSelectedRelations() {
  const factoryId = selectedFactoryId.value
  const factory = selectedFactory.value
  if (!factory) return
  let added = 0
  let restricted = 0
  for (const skuId of selectedCandidateSkuIds.value) {
    const current = draft.value.skuFactories[skuId]
    if (current?.includes(factoryId)) continue
    if (current) current.push(factoryId)
    else {
      draft.value.skuFactories[skuId] = [factoryId]
      restricted += 1
    }
    added += 1
  }
  relationAddDialogVisible.value = false
  selectedCandidateSkuIds.value = []
  if (added) {
    ElMessage.success(
      restricted
        ? `已添加 ${added} 个 SKU，其中 ${restricted} 个从「全部启用染厂」改为仅限「${factory.name}」`
        : `已为「${factory.name}」添加 ${added} 个 SKU`,
    )
  }
}

function removeFactoryRelation(row) {
  const next = row.ids.filter((id) => id !== selectedFactoryId.value)
  if (next.length) {
    draft.value.skuFactories[row.skuId] = next
  } else {
    delete draft.value.skuFactories[row.skuId]
    ElMessage.info('已解除该 SKU 的染厂限制，恢复为全部启用染厂可选')
  }
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

// 关联导入认两种写法：直给的「SKU唯一标识」，或「产品名」+「颜色」（按总表口径拼成 品名|颜色）。
// 「染厂色号」「备注」只是模板里的参考列，导入不落库。
async function readSkuFactoryRelations(file) {
  const { rows } = readWorkbookRows(await file.arrayBuffer())
  let headerRowNumber = null
  let factoryColumn = -1
  let skuColumn = -1
  let productColumn = -1
  let colorColumn = -1

  for (const row of rows.slice(0, 10)) {
    const headers = row.cells.map((cell) => String(cell ?? '').trim())
    factoryColumn = headers.findIndex((header) => header === '染厂名称')
    skuColumn = headers.findIndex((header) =>
      ['SKU唯一标识', '唯一标识', 'skuId'].includes(header),
    )
    productColumn = headers.findIndex((header) => header === '产品名' || header === '品名')
    colorColumn = headers.findIndex((header) => header === '颜色')
    const hasSku = skuColumn >= 0 || (productColumn >= 0 && colorColumn >= 0)
    if (factoryColumn >= 0 && hasSku) {
      headerRowNumber = row.rowNumber
      break
    }
  }
  if (headerRowNumber === null) {
    throw new Error('需要「染厂名称」列，以及「SKU唯一标识」（或「产品名」+「颜色」）列')
  }

  return rows
    .filter((row) => row.rowNumber > headerRowNumber)
    .map((row) => {
      const product = String(row.cells[productColumn] ?? '').trim()
      const color = String(row.cells[colorColumn] ?? '').trim()
      const skuId =
        skuColumn >= 0
          ? String(row.cells[skuColumn] ?? '').trim()
          : product && color
            ? composeProductColorSkuId(product, color)
            : ''
      return {
        rowNumber: row.rowNumber,
        factoryName: String(row.cells[factoryColumn] ?? '').trim(),
        skuId,
      }
    })
    .filter((row) => row.factoryName || row.skuId)
}

function pickImportFile(mode) {
  importMode.value = mode
  importInputRef.value?.click()
}

function pickRelationImport() {
  pickImportFile('sku-factories')
}

// 模板与导入同源：表头就是导入认的列名，用户填完直接走「Excel 导入」。
const RELATION_TEMPLATE_HEADERS = ['染厂名称', '产品名', '颜色', '染厂色号', '备注']

function exportRelationTemplate() {
  saveWorkbook(
    [
      {
        name: '染厂可生产SKU',
        rows: [RELATION_TEMPLATE_HEADERS],
        widths: [18, 22, 22, 20, 26],
      },
    ],
    '染厂可生产SKU-模板.xlsx',
  )
  ElMessage.success('模板已导出')
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

    if (importMode.value === 'sku-factories') {
      relationImportRecords.value = await readSkuFactoryRelations(file)
      relationImportLimitUnrestricted.value = false
      relationImportDialogVisible.value = true
      if (!relationImportRecords.value.length) {
        ElMessage.info('文件中没有可预览的染厂与 SKU 关联行')
      }
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

function applyRelationImport() {
  const additions = relationImportRows.value.filter((row) =>
    ['待新增', '将该 SKU 限定为导入染厂'].includes(row.status),
  )
  if (!additions.length) {
    ElMessage.info('没有可新增的关联')
    return
  }

  const grouped = new Map()
  for (const row of additions) {
    const factoryIds = grouped.get(row.skuId) ?? new Set()
    factoryIds.add(row.factory.id)
    grouped.set(row.skuId, factoryIds)
  }
  for (const [skuId, ids] of grouped) {
    const existing = draft.value.skuFactories[skuId]
    draft.value.skuFactories[skuId] = existing
      ? [...new Set([...existing, ...ids])]
      : [...ids]
  }

  relationImportDialogVisible.value = false
  ElMessage.success(`已导入 ${additions.length} 条染厂与 SKU 关联`)
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
const factoryNamesSummary = computed(() =>
  draft.value.dyeFactories.map((factory) => factory.name).join('、'),
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
const factoryListDialogVisible = ref(false)
const factoryDialogVisible = ref(false)
const factoryEditingId = ref('')
const factoryDraft = reactive({ name: '' })

function openCreateFactory() {
  cancelFactoryEdit()
  factoryDraft.name = ''
  factoryDialogVisible.value = true
}

function openEditFactory(factory) {
  factoryEditingId.value = factory.id
  factoryDraft.name = factory.name
}

function cancelFactoryEdit() {
  factoryEditingId.value = ''
  factoryDraft.name = ''
}

function confirmFactoryEdit(factory) {
  const name = factoryDraft.name.trim()
  if (!name) {
    ElMessage.warning('染厂名称不能为空')
    return
  }
  if (
    draft.value.dyeFactories.some(
      (entry) => entry.name === name && entry.id !== factory.id,
    )
  ) {
    ElMessage.warning(`染厂「${name}」已存在`)
    return
  }
  factory.name = name
  cancelFactoryEdit()
}

function toggleFactoryEnabled(factory, enabled) {
  factory.enabled = enabled
}

function saveFactoryDraft() {
  const name = factoryDraft.name.trim()
  if (!name) {
    ElMessage.warning('染厂名称不能为空')
    return
  }
  if (
    draft.value.dyeFactories.some((factory) => factory.name === name)
  ) {
    ElMessage.warning(`染厂「${name}」已存在`)
    return
  }
  draft.value.dyeFactories.push({ id: nextFactoryId(), name, enabled: true })
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
const skuEditingId = ref('')
const skuUnrestricted = ref(false)
const skuDraft = reactive({ factoryIds: [] })
const skuEditingRow = computed(() => {
  const skuId = skuEditingId.value
  const item = itemBySkuId.value.get(skuId)
  if (!skuId || !item) return null
  return {
    skuId,
    product: item.product ?? skuId.split('|')[0] ?? skuId,
    color: item.color ?? skuId.split('|')[1] ?? '',
    treeCategory: item.treeCategory ?? '',
  }
})

function openEditSku(row) {
  skuEditingId.value = row.skuId
  skuUnrestricted.value = isUnrestrictedSku(row.skuId)
  skuDraft.factoryIds = skuUnrestricted.value
    ? draft.value.dyeFactories
        .filter((factory) => factory.enabled !== false)
        .map((factory) => factory.id)
    : [...(draft.value.skuFactories[row.skuId] ?? [])]
  skuDialogVisible.value = true
}

function saveSkuDraft() {
  if (!skuUnrestricted.value && skuDraft.factoryIds.length === 0) {
    ElMessage.warning('至少选择一家染厂，或启用「全部启用染厂可选」')
    return
  }
  if (skuUnrestricted.value) delete draft.value.skuFactories[skuEditingId.value]
  else draft.value.skuFactories[skuEditingId.value] = [...skuDraft.factoryIds]
  skuDialogVisible.value = false
}

// 外壳工具条通过 ref 调用这几个方法；dirty / meta 用于状态标签与左栏摘要。
defineExpose({ dirty, meta, discard, confirm, pickSettingsFile, exportSettings })
</script>

<template>
  <div class="purchase-settings">
          <!-- 缸规则 -->
          <VatRuleSettings v-show="activePanel === 'vat'" v-model="vatSettings" :spus="spuOptions" />

          <!-- 染厂清单 -->
          <section v-show="['factories', 'sku-factories'].includes(activePanel)" class="panel">
            <div class="panel__head">
              <h2 class="panel__title">染厂清单</h2>
            </div>
            <div class="panel__body">
              <button
                type="button"
                class="factory-summary"
                :title="factoryNamesSummary || '还没有染厂'"
                aria-label="打开染厂清单管理"
                @click="factoryListDialogVisible = true"
              >
                <span class="factory-summary__icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none">
                    <path
                      d="M3.5 16.5V6.8L10 3.5l6.5 3.3v9.7M2.5 16.5h15M7 16.5v-4h6v4M7 8.2h.01M10 8.2h.01M13 8.2h.01"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
                <span class="factory-summary__names">
                  {{ factoryNamesSummary || '还没有染厂' }}
                </span>
                <span class="factory-summary__meta">
                  <strong>{{ draft.dyeFactories.length }}</strong> 家染厂
                  <i aria-hidden="true"></i>
                  <strong>{{ enabledFactoryCount }}</strong> 家启用
                </span>
                <span class="factory-summary__action">
                  管理清单
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="m6 3.5 4.5 4.5L6 12.5"
                      stroke="currentColor"
                      stroke-width="1.4"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
              </button>
            </div>
          </section>

          <!-- 分单人员表 -->
          <section v-show="['people', 'categories'].includes(activePanel)" class="panel">
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
          <section v-show="['people', 'categories'].includes(activePanel)" class="panel">
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
          <section v-show="['factories', 'sku-factories'].includes(activePanel)" class="panel">
            <div class="panel__head relation-panel-head">
              <h2 class="panel__title">染厂可生产的SKU</h2>
              <div class="relation-manager__actions">
                <button type="button" class="btn btn--text btn--sm" @click="exportRelationTemplate">
                  导出模板
                </button>
                <button type="button" class="btn btn--text btn--sm" @click="pickRelationImport">
                  Excel 导入
                </button>
                <button
                  type="button"
                  class="btn btn--primary btn--sm"
                  :disabled="!selectedFactory"
                  @click="beginAddRelation"
                >
                  ＋ 添加 SKU
                </button>
              </div>
            </div>
            <div class="panel__body">
              <div class="relation-manager">
                <div class="relation-manager__layout">
                  <aside class="relation-factories">
                    <div class="relation-factories__head">
                      <strong>染厂</strong>
                      <span>{{ draft.dyeFactories.length }}</span>
                    </div>
                    <ElInput
                      v-model="factoryKeyword"
                      size="small"
                      clearable
                      placeholder="搜索染厂"
                      aria-label="搜索染厂"
                    />
                    <div class="relation-factories__list">
                      <button
                        v-for="factory in searchedFactories"
                        :key="factory.id"
                        type="button"
                        class="relation-factory"
                        :class="{
                          'relation-factory--active': factory.id === selectedFactoryId,
                          'relation-factory--disabled': factory.enabled === false,
                        }"
                        :aria-pressed="factory.id === selectedFactoryId"
                        @click="selectedFactoryId = factory.id"
                      >
                        <span class="relation-factory__name">{{ factory.name }}</span>
                        <span class="relation-factory__meta">
                          {{ factory.enabled === false ? '停用' : `关联 ${factorySkuCounts.get(factory.id) ?? 0}` }}
                        </span>
                      </button>
                      <p v-if="searchedFactories.length === 0" class="relation-empty">
                        没有匹配的染厂
                      </p>
                    </div>
                  </aside>

                  <div v-if="selectedFactory" class="relation-detail">
                    <div class="relation-detail__head">
                      <div>
                        <h3>{{ selectedFactory.name }}</h3>
                      </div>
                      <span
                        class="tag"
                        :class="{ 'tag--muted': selectedFactory.enabled === false }"
                      >
                        {{ selectedFactory.enabled === false ? '已停用' : '已启用' }}
                      </span>
                    </div>

                    <div class="relation-detail__toolbar">
                      <ElInput
                        v-model="relationSkuKeyword"
                        size="small"
                        clearable
                        placeholder="搜索已关联的 SKU"
                        aria-label="搜索当前染厂已关联 SKU"
                      />
                      <span>已限制 {{ currentFactorySkus.length }} 个 SKU</span>
                    </div>

                    <div v-if="currentFactorySkus.length" class="relation-sku-table-wrap">
                      <table class="score-table relation-sku-table">
                        <thead>
                          <tr>
                            <th>品名</th>
                            <th>颜色</th>
                            <th class="is-actions">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="row in currentFactorySkus" :key="row.skuId">
                            <td>{{ row.product }}</td>
                            <td>{{ row.color || '—' }}</td>
                            <td class="is-actions">
                              <span class="row-acts">
                                <button
                                  type="button"
                                  class="btn btn--text btn--sm"
                                  @click="openEditSku(row)"
                                >
                                  配置
                                </button>
                                <button
                                  type="button"
                                  class="btn btn--text btn--sm"
                                  @click="removeFactoryRelation(row)"
                                >
                                  解除
                                </button>
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div v-else class="relation-empty relation-empty--detail">
                      <strong>暂无关联 SKU</strong>
                    </div>
                  </div>
                  <div v-else class="relation-empty relation-empty--detail">
                    <strong>暂无染厂</strong>
                  </div>
                </div>
              </div>
            </div>
          </section>

    <ElDialog
      v-model="factoryListDialogVisible"
      class="ui-dialog"
      width="min(720px, calc(100vw - 24px))"
      append-to-body
      align-center
      title="管理染厂清单"
    >
      <div class="factory-list-dialog">
        <div class="factory-list-dialog__intro">
          <div>
            <p class="factory-list-dialog__description">
              维护采购下单时可选的染厂。停用的染厂不会出现在新订单中。
            </p>
          </div>
          <div class="factory-list-dialog__stats" aria-label="染厂数量">
            <span><strong>{{ draft.dyeFactories.length }}</strong> 家染厂</span>
            <span><strong>{{ enabledFactoryCount }}</strong> 家启用</span>
          </div>
        </div>
        <div class="factory-list-dialog__table-wrap">
          <table class="score-table factory-list-dialog__table">
            <thead>
              <tr>
                <th>染厂名称</th>
                <th style="width: 130px">状态</th>
                <th class="is-actions" style="width: 150px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(factory, index) in draft.dyeFactories" :key="factory.id">
                  <td>
                    <template v-if="factoryEditingId === factory.id">
                      <ElInput
                        v-model="factoryDraft.name"
                        size="small"
                        :aria-label="`编辑染厂名称：${factory.name}`"
                        @keyup.enter="confirmFactoryEdit(factory)"
                        @keyup.esc="cancelFactoryEdit"
                      />
                    </template>
                    <span v-else>{{ factory.name }}</span>
                  </td>
                  <td>
                    <div class="factory-state-control">
                      <ElSwitch
                        :model-value="factory.enabled !== false"
                        :aria-label="`${factory.name}启用状态`"
                        @change="toggleFactoryEnabled(factory, $event)"
                      />
                      <span
                        class="factory-state-label"
                        :class="{
                          'factory-state-label--enabled': factory.enabled !== false,
                        }"
                      >
                        {{ factory.enabled === false ? '停用' : '启用' }}
                      </span>
                    </div>
                  </td>
                  <td class="is-actions">
                    <span class="row-acts">
                      <template v-if="factoryEditingId === factory.id">
                        <button
                          type="button"
                          class="btn btn--primary btn--sm"
                          @click="confirmFactoryEdit(factory)"
                        >
                          确认
                        </button>
                        <button type="button" class="btn btn--sm" @click="cancelFactoryEdit">
                          取消
                        </button>
                      </template>
                      <template v-else>
                        <button
                          type="button"
                          class="icon-btn"
                          title="编辑名称"
                          :disabled="Boolean(factoryEditingId)"
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
                          :disabled="Boolean(factoryEditingId)"
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
                      </template>
                    </span>
                  </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="draft.dyeFactories.length === 0" class="manual-block__empty">还没有染厂</p>
        <div class="tbl-foot">
          <span class="tbl-foot__hint">仅本机草稿变更，点击页面顶部「确定」后生效</span>
          <button type="button" class="btn btn--text btn--sm" @click="pickImportFile('factories')">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M8 10.5V2.8m0 0L5.2 5.6M8 2.8l2.8 2.8M3 9.5v3h10v-3"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            从 Excel 导入
          </button>
          <button type="button" class="btn btn--primary btn--sm" @click="openCreateFactory">
            <span aria-hidden="true">＋</span>
            新增染厂
          </button>
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="factoryListDialogVisible = false">
            关闭
          </button>
        </div>
      </template>
    </ElDialog>

    <!-- 染厂编辑 -->
    <ElDialog
      v-model="factoryDialogVisible"
      class="ui-dialog"
      width="480px"
      append-to-body
      align-center
      title="新增染厂"
    >
      <div class="form">
        <div class="form__row">
          <span class="form__row-label">染厂名称</span>
          <div class="form__row-ctrl">
            <ElInput v-model="factoryDraft.name" size="small" aria-label="染厂名称" />
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

    <ElDialog
      v-model="relationAddDialogVisible"
      class="ui-dialog relation-add-dialog"
      width="min(720px, calc(100vw - 24px))"
      append-to-body
      align-center
      :title="`为「${selectedFactory?.name ?? ''}」添加 SKU`"
    >
      <div class="relation-add">
        <p class="relation-add__hint">
          搜索 SKU 后勾选并批量添加。未限制的 SKU 加入后将改为仅限所选染厂；可在 SKU 配置中调整为多家或全部启用染厂。
        </p>
        <ElInput
          v-model="relationCandidateKeyword"
          size="small"
          clearable
          autofocus
          placeholder="搜索品名、颜色或 SKU 唯一标识"
          aria-label="搜索 SKU"
        />
        <ElCheckboxGroup
          v-if="relationCandidateKeyword.trim()"
          v-model="selectedCandidateSkuIds"
          class="relation-add__results"
        >
          <div
            v-for="candidate in skuCandidates"
            :key="candidate.skuId"
            class="relation-add__row"
          >
            <ElCheckbox
              :value="candidate.skuId"
              :disabled="isAlreadyRelatedToSelectedFactory(candidate.skuId)"
            >
              <span class="relation-add__sku">
                <strong>{{ candidate.product }} · {{ candidate.color }}</strong>
                <small>{{ candidate.skuId }}</small>
              </span>
            </ElCheckbox>
            <span class="relation-add__state">
              {{
                isAlreadyRelatedToSelectedFactory(candidate.skuId)
                  ? '已关联'
                  : isUnrestrictedSku(candidate.skuId)
                    ? '当前不限染厂'
                    : '已有染厂限制'
              }}
            </span>
            <button type="button" class="btn btn--text btn--sm" @click="openEditSku(candidate)">
              配置
            </button>
          </div>
          <p v-if="skuCandidates.length === 0" class="relation-empty">
            没有匹配的 SKU，请确认已导入库存总表。
          </p>
          <p v-else-if="skuCandidates.length >= 100" class="relation-add__hint">
            仅显示前 100 个结果，请继续输入缩小范围。
          </p>
        </ElCheckboxGroup>
        <div v-else class="relation-empty relation-add__empty">
          输入品名、颜色或唯一标识，查找库存中的 SKU。
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="relationAddDialogVisible = false">
            取消
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            :disabled="selectedCandidateSkuIds.length === 0"
            @click="addSelectedRelations"
          >
            添加 {{ selectedCandidateSkuIds.length || '' }} 个 SKU
          </button>
        </div>
      </template>
    </ElDialog>

    <ElDialog
      v-model="relationImportDialogVisible"
      class="ui-dialog relation-import-dialog"
      width="min(900px, calc(100vw - 24px))"
      append-to-body
      align-center
      title="预览染厂与 SKU 关联导入"
    >
      <div class="relation-import">
        <p class="relation-add__hint">
          仅应用有效的新关联。未匹配、重复、已存在的行会保留在预览中但不会写入。文件需含「染厂名称」列，以及「SKU唯一标识」（或「产品名」+「颜色」）列；「染厂色号」「备注」仅作参考，不写入设置。
        </p>
        <div class="relation-import__stats">
          <span><strong>{{ relationImportRecords.length }}</strong> 条数据行</span>
          <span><strong>{{ relationImportAddCount }}</strong> 可新增</span>
          <span><strong>{{ relationImportCounts['需确认限制范围'] ?? 0 }}</strong> 待确认范围</span>
          <span><strong>{{ relationImportCounts['已存在'] ?? 0 }}</strong> 已存在</span>
          <span><strong>{{ (relationImportCounts['未匹配染厂'] ?? 0) + (relationImportCounts['未匹配 SKU'] ?? 0) }}</strong> 未匹配</span>
          <span><strong>{{ relationImportCounts['文件内重复'] ?? 0 }}</strong> 文件重复</span>
        </div>
        <label
          v-if="relationImportCounts['需确认限制范围'] || relationImportCounts['将该 SKU 限定为导入染厂']"
          class="relation-import__confirm"
        >
          <ElCheckbox v-model="relationImportLimitUnrestricted" />
          <span>
            将未限制 SKU 改为仅允许文件中的染厂
          </span>
        </label>
        <div class="relation-import__table-wrap">
          <table class="score-table relation-import__table">
            <thead>
              <tr>
                <th style="width: 64px">行号</th>
                <th>染厂</th>
                <th>SKU 唯一标识</th>
                <th style="width: 190px">预览结果</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in relationImportRows" :key="row.rowNumber">
                <td>{{ row.rowNumber }}</td>
                <td>{{ row.factoryName || '—' }}</td>
                <td class="score-table__mono">{{ row.skuId || '—' }}</td>
                <td>
                  <span
                    class="tag"
                    :class="{
                      'tag--muted': ['已存在', '文件内重复'].includes(row.status),
                      'tag--warning': ['未匹配染厂', '未匹配 SKU', '需确认限制范围'].includes(row.status),
                    }"
                  >
                    {{ row.status }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <template #footer>
        <div class="form__foot">
          <span class="form__foot-spacer"></span>
          <button type="button" class="btn btn--sm" @click="relationImportDialogVisible = false">
            取消
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            :disabled="relationImportRows.every((row) => !['待新增', '将该 SKU 限定为导入染厂'].includes(row.status))"
            @click="applyRelationImport"
          >
            确认导入
          </button>
        </div>
      </template>
    </ElDialog>

    <!-- SKU 可选染厂编辑 -->
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
          <span class="form__row-label">可选染厂</span>
          <div class="form__row-ctrl">
            <label class="relation-unrestricted">
              <ElCheckbox v-model="skuUnrestricted" />
              <span>全部启用染厂可选</span>
            </label>
            <ElSelect
              v-model="skuDraft.factoryIds"
              size="small"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择一家或多家染厂"
              aria-label="可选染厂"
              :disabled="skuUnrestricted"
            >
              <ElOption
                v-for="factory in factoryOptions"
                :key="factory.id"
                :label="factory.name"
                :value="factory.id"
                :disabled="factory.enabled === false"
              />
            </ElSelect>
            <span class="form__row-hint">指定染厂时至少选择一家。</span>
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

.factory-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 48px;
  padding: 7px 10px;
  border: 1px solid #c7d2d9;
  border-radius: 4px;
  background: linear-gradient(110deg, #fff 0%, #f9fbfc 100%);
  color: var(--industrial-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease,
    background 120ms ease;
}

.factory-summary:hover {
  border-color: var(--industrial-primary);
  background: #fff;
  box-shadow: 0 2px 8px rgba(47, 59, 67, 0.08);
}

.factory-summary:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: 2px;
}

.factory-summary__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid #d5e0e6;
  border-radius: 4px;
  background: #edf4f7;
  color: var(--industrial-primary);
}

.factory-summary__icon svg {
  width: 17px;
  height: 17px;
}

.factory-summary__names {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--industrial-text);
  font-size: 12.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.factory-summary__meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--industrial-muted);
  font-size: 11.5px;
  white-space: nowrap;
}

.factory-summary__meta strong {
  color: var(--industrial-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.factory-summary__meta i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: #9aa8b0;
}

.factory-summary__action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  padding: 5px 8px;
  border: 1px solid #d3dfe5;
  border-radius: 3px;
  background: #f5f9fb;
  color: var(--industrial-primary);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.factory-summary__action svg {
  width: 13px;
  height: 13px;
}

.factory-list-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(68vh, 600px);
}

.factory-list-dialog__intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 12px;
  border: 1px solid #d7e1e6;
  border-radius: 4px;
  background: #f0f5f7;
}

.factory-list-dialog__description {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.5;
}

.factory-list-dialog__stats {
  display: flex;
  flex: none;
  gap: 6px;
}

.factory-list-dialog__stats span {
  padding: 4px 8px;
  border: 1px solid #d3dfe5;
  border-radius: 3px;
  background: #fff;
  color: var(--industrial-muted);
  font-size: 11px;
  white-space: nowrap;
}

.factory-list-dialog__stats strong {
  margin-right: 2px;
  color: var(--industrial-primary-active);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.factory-list-dialog__table-wrap {
  max-height: min(46vh, 400px);
  overflow: auto;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
  background: #fff;
}

.factory-list-dialog__table {
  border: 0;
}

.factory-list-dialog__table th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 34px;
  background: #e8eff3;
  color: #43535d;
}

.factory-list-dialog__table td {
  height: 40px;
  background: #fff;
}

.factory-list-dialog__table tbody tr:nth-child(even) td {
  background: #fbfcfd;
}

.factory-list-dialog__table tbody tr:hover td {
  background: #f0f6f8;
}

.factory-list-dialog__table td:first-child {
  font-weight: 500;
}

.factory-list-dialog__table td:first-child .el-input {
  max-width: 360px;
}

.factory-list-dialog__table td:first-child :deep(.el-input__wrapper) {
  min-height: 30px;
}

.factory-list-dialog__table .row-acts .icon-btn {
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 3px;
}

.factory-state-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.factory-state-control :deep(.el-switch) {
  --el-switch-on-color: var(--industrial-primary);
  --el-switch-off-color: #aeb9c0;
  height: 22px;
}

.factory-state-control :deep(.el-switch__core) {
  min-width: 42px;
  height: 24px;
  border-radius: 12px;
}

.factory-state-control :deep(.el-switch__action) {
  width: 18px;
  height: 18px;
}

.factory-state-label {
  color: var(--industrial-muted);
  font-size: 11.5px;
}

.factory-state-label--enabled {
  color: #47745c;
  font-weight: 600;
}

.factory-list-dialog__table .row-acts .btn {
  min-width: 48px;
}

.factory-list-dialog .tbl-foot {
  gap: 8px;
  margin-top: 0;
  padding-top: 2px;
}

.factory-list-dialog .tbl-foot__hint {
  max-width: 300px;
  line-height: 1.4;
}

.factory-list-dialog .btn--text {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.factory-list-dialog .btn--text svg {
  width: 14px;
  height: 14px;
}

@media (max-width: 600px) {
  .factory-summary {
    gap: 6px;
    padding: 6px;
  }

  .factory-summary__icon {
    width: 26px;
    height: 26px;
  }

  .factory-summary__meta {
    display: none;
  }

  .factory-summary__action {
    padding: 4px 6px;
  }

  .factory-list-dialog__intro {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .factory-list-dialog .tbl-foot {
    flex-wrap: wrap;
  }

  .factory-list-dialog .tbl-foot__hint {
    flex: 1 0 100%;
    max-width: none;
  }
}

.relation-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.relation-manager {
  display: grid;
}

.relation-panel-head .relation-manager__actions {
  margin-left: auto;
}

.relation-add__hint {
  margin: 0;
  color: var(--industrial-muted);
  font-size: 12px;
  line-height: 1.65;
}

.relation-manager__actions {
  display: flex;
  flex: 0 0 auto;
  gap: 8px;
}

.relation-manager__layout {
  display: grid;
  grid-template-columns: minmax(210px, 260px) minmax(0, 1fr);
  min-height: 380px;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}

.relation-factories {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-right: 1px solid var(--industrial-grid-light);
  background: #f8fafb;
}

.relation-factories__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--industrial-text);
  font-size: 13px;
}

.relation-factories__head span,
.relation-factory__meta {
  color: var(--industrial-muted);
  font-size: 11px;
  font-weight: 400;
}

.relation-factories__list {
  display: grid;
  align-content: start;
  gap: 4px;
  max-height: 430px;
  overflow: auto;
}

.relation-factory {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 38px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--industrial-text);
  text-align: left;
  cursor: pointer;
}

.relation-factory:hover {
  background: #eef4f7;
}

.relation-factory--active {
  border-color: #b6d2e3;
  background: #eaf3f8;
  color: var(--industrial-primary);
}

.relation-factory--disabled .relation-factory__name {
  color: var(--industrial-muted);
}

.relation-factory__name {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relation-detail {
  min-width: 0;
  padding: 18px;
}

.relation-detail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid #edf1f4;
}

.relation-detail__head h3 {
  margin: 0;
  color: var(--industrial-text);
  font-size: 17px;
  font-weight: 600;
}

.relation-detail__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  color: var(--industrial-muted);
  font-size: 11px;
}

.relation-detail__toolbar .el-input {
  max-width: 280px;
}

.relation-sku-table-wrap,
.relation-import__table-wrap {
  max-height: 390px;
  overflow: auto;
}

.relation-sku-table {
  min-width: 440px;
}

.score-table.relation-sku-table th,
.score-table.relation-sku-table td,
.score-table.relation-sku-table th.is-actions,
.score-table.relation-sku-table td.is-actions {
  text-align: left;
}

.score-table.relation-sku-table td.is-actions .row-acts {
  justify-content: flex-start;
  gap: 4px;
}

.relation-empty {
  padding: 20px 12px;
  color: var(--industrial-muted);
  font-size: 12px;
  text-align: center;
}

.relation-empty--detail {
  display: flex;
  min-height: 160px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
}

.relation-empty--detail strong {
  color: var(--industrial-text);
  font-size: 13px;
}

.relation-add {
  display: grid;
  gap: 12px;
}

.relation-add__results {
  max-height: min(440px, 55vh);
  overflow: auto;
  border: 1px solid var(--industrial-grid-light);
  border-radius: 3px;
}

.relation-add__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px 54px;
  align-items: center;
  gap: 10px;
  min-height: 50px;
  padding: 7px 11px;
  border-bottom: 1px solid #edf1f4;
}

.relation-add__row:last-child {
  border-bottom: 0;
}

.relation-add__sku {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  max-width: 360px;
  color: var(--industrial-text);
}

.relation-add__sku strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.relation-add__sku small,
.relation-add__state {
  color: var(--industrial-muted);
  font-size: 10px;
}

.relation-add__empty {
  border: 1px dashed var(--industrial-grid-light);
  border-radius: 3px;
}

.relation-unrestricted {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--industrial-text);
  font-size: 12px;
}

.relation-import {
  display: grid;
  gap: 12px;
}

.relation-import__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 10px 12px;
  border: 1px solid #e3eaf0;
  border-radius: 3px;
  background: #f7f9fb;
  color: var(--industrial-muted);
  font-size: 11px;
}

.relation-import__stats strong {
  color: var(--industrial-text);
  font-size: 13px;
}

.relation-import__confirm {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #f0d7a8;
  border-radius: 3px;
  background: #fffaf0;
  color: #745a28;
  font-size: 12px;
}

.relation-import__confirm small {
  display: block;
  margin-top: 3px;
  color: var(--industrial-muted);
  font-size: 10px;
}

.relation-import__table {
  min-width: 620px;
}

.tag--warning {
  border-color: #f0d7a8;
  background: #fff7e8;
  color: #986d1e;
}

@media (max-width: 760px) {
  .relation-panel-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .relation-panel-head .relation-manager__actions {
    margin-left: 0;
  }

  .relation-manager__layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .relation-factories {
    border-right: 0;
    border-bottom: 1px solid var(--industrial-grid-light);
  }

  .relation-factories__list {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    max-height: 180px;
  }
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
