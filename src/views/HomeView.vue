<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElSelect,
  ElTable,
  ElTableColumn,
} from 'element-plus'
import { zipSync } from 'fflate'
import { stockingRules } from '@/data/stockingRules'
import { useInventoryStore } from '@/stores/inventory'
import { groupRowsByProduct } from '@/utils/productGroups'
import {
  calculateInventoryRow,
  formatFactors,
  formatQuantity,
  formatRate,
  formatRatio,
  normalizeProductName,
} from '@/utils/inventory'

const inventoryStore = useInventoryStore()
const inventoryItems = inventoryStore.inventoryItems
const purchaseList = inventoryStore.purchaseList
const plannedUndoHistory = inventoryStore.plannedUndoHistory
const purchaseListRows = computed(() =>
  purchaseList.map((purchaseItem) => {
    const item = inventoryItems.find((entry) => entry.id === purchaseItem.id)
    return item
      ? { ...purchaseItem, product: item.product, color: item.color }
      : purchaseItem
  }),
)
const productDrafts = reactive({})
const plannedDrafts = reactive({})
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const selectedWarningTones = ref([])
const productFilter = ref('')
const colorFilter = ref('')
const inventoryTableRef = ref(null)
const collapsingProductKeys = ref(new Set())
const expandingProductKeys = ref(new Set())
const selectedRowId = ref(null)
const addItemDialogVisible = ref(false)
const addItemFormRef = ref(null)
const addItemForm = reactive(createEmptyItem())
const urgentPlanDialogVisible = ref(false)
const urgentPlanRows = ref([])
const purchaseListDialogVisible = ref(false)
const flyingPurchaseIcon = ref(null)
const purchaseListPulse = ref(false)
let purchaseFlyTimer = 0
let purchasePulseTimer = 0

function createEmptyItem() {
  return {
    product: '',
    color: '',
    category: '黑白',
    stockingType: '常规',
    planned: null,
    producing: 0,
    backorder: 0,
    weeklyUsage: 0,
    warehouseStock: 0,
  }
}

function validateProductColor(_rule, value, callback) {
  const product = normalizeProductName(value ?? '')
  const color = addItemForm.color.trim()
  if (
    product &&
    color &&
    inventoryItems.some(
      (item) => item.product === product && item.color.trim() === color,
    )
  ) {
    callback(new Error('该品名和颜色已存在'))
    return
  }
  callback()
}

const addItemRules = {
  product: [
    { required: true, whitespace: true, message: '请输入品名', trigger: 'blur' },
    { validator: validateProductColor, trigger: 'blur' },
  ],
  color: [
    { required: true, whitespace: true, message: '请输入颜色', trigger: 'blur' },
    { validator: validateProductColor, trigger: 'blur' },
  ],
}

async function openAddItemDialog() {
  Object.assign(addItemForm, createEmptyItem())
  addItemDialogVisible.value = true
  await nextTick()
  addItemFormRef.value?.clearValidate()
}

function submitNewItem() {
  addItemFormRef.value?.validate((valid) => {
    if (!valid) return

    const product = normalizeProductName(addItemForm.product)
    const item = {
      id: Math.max(0, ...inventoryItems.map((entry) => entry.id)) + 1,
      ...addItemForm,
      product,
      color: addItemForm.color.trim(),
    }
    inventoryItems.push(item)
    selectedRowId.value = item.id
    addItemDialogVisible.value = false
  })
}

const inventoryLeafRows = computed(() => {
  return inventoryItems
    .map((item) => {
      const row = calculateInventoryRow(item, stockingRules)
      const hasDraft = Reflect.has(plannedDrafts, item.id)
      const plannedDraft = hasDraft ? plannedDrafts[item.id] : item.planned

      return {
        ...row,
        hasPlannedDraft: hasDraft,
        hasPlannedUndo: Reflect.has(plannedUndoHistory, item.id),
        plannedDraft,
        plannedPreviewTone: calculateInventoryRow(
          { ...item, planned: plannedDraft ?? 0 },
          stockingRules,
        ).urgencyTone,
      }
    })
    .sort(
      (first, second) =>
        productCollator.compare(first.product, second.product) ||
        Number(second.color === '黑色') - Number(first.color === '黑色') ||
        productCollator.compare(first.color, second.color) ||
        first.id - second.id,
    )
})

const warningFilters = [
  { key: 'all', label: '全部' },
  { key: 'red', label: '紧急' },
  { key: 'yellow', label: '常规' },
  { key: 'green', label: '正常' },
  { key: 'purple', label: '超库存' },
]
const warningCounts = computed(() => ({
  all: inventoryLeafRows.value.length,
  red: inventoryLeafRows.value.filter((row) => row.urgencyTone === 'red').length,
  yellow: inventoryLeafRows.value.filter((row) => row.urgencyTone === 'yellow').length,
  green: inventoryLeafRows.value.filter((row) => row.urgencyTone === 'green').length,
  purple: inventoryLeafRows.value.filter((row) => row.urgencyTone === 'purple').length,
}))
const hasActiveFilters = computed(
  () =>
    productFilter.value.trim() !== '' ||
    colorFilter.value.trim() !== '' ||
    selectedWarningTones.value.length > 0,
)
const filteredInventoryLeafRows = computed(() =>
  inventoryLeafRows.value.filter((row) => {
    const productMatches = row.product
      .toLocaleLowerCase('zh-CN')
      .includes(productFilter.value.trim().toLocaleLowerCase('zh-CN'))
    const colorMatches = row.color
      .toLocaleLowerCase('zh-CN')
      .includes(colorFilter.value.trim().toLocaleLowerCase('zh-CN'))
    const warningMatches =
      selectedWarningTones.value.length === 0 ||
      selectedWarningTones.value.includes(row.urgencyTone)

    return productMatches && colorMatches && warningMatches
  }),
)
const inventoryRows = computed(() => groupRowsByProduct(filteredInventoryLeafRows.value))

function resetFilters() {
  productFilter.value = ''
  colorFilter.value = ''
  selectedWarningTones.value = []
}

function toggleWarningFilter(key) {
  if (key === 'all') {
    resetFilters()
    return
  }

  const selectedTones = new Set(selectedWarningTones.value)
  if (selectedTones.has(key)) selectedTones.delete(key)
  else selectedTones.add(key)
  selectedWarningTones.value = [...selectedTones]
}

const expandedProductKeys = ref(inventoryRows.value.map((row) => row.id))
let knownProductKeys = new Set(expandedProductKeys.value)
const productTransitionTimers = new Map()
const productTransitionDuration = 120

function clearProductTransition(productKey) {
  const timer = productTransitionTimers.get(productKey)
  if (timer) clearTimeout(timer)
  productTransitionTimers.delete(productKey)
  collapsingProductKeys.value.delete(productKey)
  expandingProductKeys.value.delete(productKey)
}

function animateProductExpansion(productKey) {
  clearProductTransition(productKey)
  expandingProductKeys.value.add(productKey)
  productTransitionTimers.set(
    productKey,
    setTimeout(() => {
      expandingProductKeys.value.delete(productKey)
      productTransitionTimers.delete(productKey)
    }, productTransitionDuration),
  )
}

function animateProductCollapse(row) {
  const productKey = row.id
  clearProductTransition(productKey)
  collapsingProductKeys.value.add(productKey)
  productTransitionTimers.set(
    productKey,
    setTimeout(() => {
      inventoryTableRef.value?.toggleRowExpansion(row, false)
      collapsingProductKeys.value.delete(productKey)
      productTransitionTimers.delete(productKey)
    }, productTransitionDuration),
  )
}

watch(inventoryRows, (groups) => {
  const currentKeys = new Set(groups.map((row) => row.id))
  const expandedKeys = new Set(expandedProductKeys.value.filter((key) => currentKeys.has(key)))
  for (const group of groups) {
    if (!knownProductKeys.has(group.id)) expandedKeys.add(group.id)
  }
  knownProductKeys = currentKeys
  expandedProductKeys.value = [...expandedKeys]
})

function handleExpandChange(row, expanded) {
  if (!row.isProductGroup) return
  const keys = new Set(expandedProductKeys.value)
  if (expanded) keys.add(row.id)
  else keys.delete(row.id)
  expandedProductKeys.value = [...keys]
  if (expanded) animateProductExpansion(row.id)
}

function handleCellClick(row, column) {
  if (!row.isProductGroup || column.property !== 'product') return

  if (collapsingProductKeys.value.has(row.id)) {
    clearProductTransition(row.id)
    animateProductExpansion(row.id)
    return
  }

  const isExpanded = expandedProductKeys.value.includes(row.id)
  if (isExpanded) {
    animateProductCollapse(row)
    return
  }

  inventoryTableRef.value?.toggleRowExpansion(row, true)
}

onBeforeUnmount(() => {
  productTransitionTimers.forEach((timer) => clearTimeout(timer))
  if (purchaseFlyTimer) clearTimeout(purchaseFlyTimer)
  if (purchasePulseTimer) clearTimeout(purchasePulseTimer)
})

const urgentRows = computed(() =>
    inventoryLeafRows.value.filter((row) => row.urgencyTone === 'red'),
)
const hasUrgentPlan = computed(() =>
  urgentPlanRows.value.some((row) => row.additionalPlan > 0),
)

function openUrgentPlanDialog() {
  urgentPlanRows.value = urgentRows.value.map((row) => ({
    id: row.id,
    product: row.product,
    color: row.color,
    currentPlanned: row.planned ?? 0,
    additionalPlan: 0,
    recommendedPlan: Math.max(0, Math.ceil(row.normalStock * 0.8 - row.theoreticalStock)),
  }))
  urgentPlanDialogVisible.value = true
}

function submitUrgentPlans() {
  for (const planRow of urgentPlanRows.value) {
    if (planRow.additionalPlan <= 0) continue

    const item = inventoryItems.find((entry) => entry.id === planRow.id)
    if (item) {
      plannedUndoHistory[planRow.id] = {
        previousPlanned: item.planned,
        previousPurchaseItem: snapshotPurchaseItem(planRow.id),
      }
      item.planned = (item.planned ?? 0) + planRow.additionalPlan
      delete plannedDrafts[planRow.id]
      syncPurchaseItem(item)
    }
  }

  urgentPlanDialogVisible.value = false
  urgentPlanRows.value = []
}

function applyAllRecommendedPlans() {
  urgentPlanRows.value.forEach((row) => {
    row.additionalPlan = row.recommendedPlan
  })
}

function getCellClassName({ row, column }) {
  if (!row.isProductGroup && column.property === 'urgency') {
    return `urgency-cell urgency-cell--${row.urgencyTone}`
  }
  if (row.isProductGroup && column.property === 'product') {
    return 'product-cell-clickable'
  }
  if (!row.isProductGroup && column.property === 'planned') {
    return `planned-cell planned-cell--${row.plannedPreviewTone}`
  }
  return ''
}

function hasPlannedDraft(id) {
  return Object.prototype.hasOwnProperty.call(plannedDrafts, id)
}

function getPlannedDraft(row) {
  return row.plannedDraft
}

function getPlannedPlaceholder(row) {
  if (!row.strategyAvailable) return ''

  const existingPlanned = row.planned ?? 0
  const targetPlanned = Math.max(
    existingPlanned,
    0,
    Math.ceil(row.normalStock * 0.8 - row.producing - row.warehouseStock),
  )
  return `${formatQuantity(targetPlanned)}`
}

function getPlannedPlaceholderTitle(row) {
  if (!row.strategyAvailable) return '备货规则缺省，无法计算建议需安排量'

  return `建议填写 ${getPlannedPlaceholder(row)}，使理论库存达到正常库存的 80% 下限；该建议不会自动采纳`
}

function updatePlannedDraft(id, value) {
  if (Reflect.has(plannedUndoHistory, id)) return

  plannedDrafts[id] = value
}

function snapshotPurchaseItem(id) {
  const purchaseItem = purchaseList.find((entry) => entry.id === id)
  return purchaseItem ? { ...purchaseItem } : null
}

function syncPurchaseItem(item) {
  const purchaseIndex = purchaseList.findIndex((entry) => entry.id === item.id)
  if (purchaseIndex === -1) {
    purchaseList.push({
      id: item.id,
      product: item.product,
      color: item.color,
      planned: item.planned ?? 0,
      actualPlan: null,
    })
    return
  }

  purchaseList[purchaseIndex].product = item.product
  purchaseList[purchaseIndex].color = item.color
  purchaseList[purchaseIndex].planned = item.planned ?? 0
}

function restorePurchaseItem(id, previousPurchaseItem) {
  const purchaseIndex = purchaseList.findIndex((entry) => entry.id === id)
  if (previousPurchaseItem) {
    if (purchaseIndex === -1) purchaseList.push({ ...previousPurchaseItem })
    else purchaseList.splice(purchaseIndex, 1, { ...previousPurchaseItem })
  } else if (purchaseIndex !== -1) {
    purchaseList.splice(purchaseIndex, 1)
  }
}

function updatePurchaseActualPlan(id, value) {
  const purchaseItem = purchaseList.find((entry) => entry.id === id)
  if (purchaseItem) purchaseItem.actualPlan = value
}

function acceptPlannedDraft(row) {
  if (!hasPlannedDraft(row.id)) {
    undoPlannedAcceptance(row)
    return
  }

  const item = inventoryItems.find((entry) => entry.id === row.id)
  if (!item) return

  plannedUndoHistory[row.id] = {
    previousPlanned: item.planned,
    previousPurchaseItem: snapshotPurchaseItem(row.id),
  }
  item.planned = plannedDrafts[row.id] ?? 0
  delete plannedDrafts[row.id]
  syncPurchaseItem(item)
}

function handlePlannedAction(row, event) {
  const isAccepting = hasPlannedDraft(row.id)
  acceptPlannedDraft(row)
  if (isAccepting) animatePurchaseListButton(event.currentTarget)
}

function animatePurchaseListButton(sourceElement) {
  const targetElement = document.querySelector('.purchase-list-button')
  if (!sourceElement || !targetElement) return

  const source = sourceElement.getBoundingClientRect()
  const target = targetElement.getBoundingClientRect()
  const iconSize = 20

  if (purchaseFlyTimer) clearTimeout(purchaseFlyTimer)

  flyingPurchaseIcon.value = {
    left: source.left + source.width / 2 - iconSize / 2,
    top: source.top + source.height / 2 - iconSize / 2,
    offsetX: target.left + target.width / 2 - source.left - source.width / 2,
    offsetY: target.top + target.height / 2 - source.top - source.height / 2,
  }

  purchaseFlyTimer = window.setTimeout(clearFlyingPurchaseIcon, 1350)
}

function clearFlyingPurchaseIcon() {
  if (purchaseFlyTimer) clearTimeout(purchaseFlyTimer)
  purchaseFlyTimer = 0
  flyingPurchaseIcon.value = null
}

function pulsePurchaseListButton() {
  purchaseListPulse.value = true
  if (purchasePulseTimer) clearTimeout(purchasePulseTimer)
  purchasePulseTimer = window.setTimeout(() => {
    purchaseListPulse.value = false
    purchasePulseTimer = 0
  }, 650)
}

function onPurchaseIconAnimationEnd() {
  if (!flyingPurchaseIcon.value) return
  clearFlyingPurchaseIcon()
  pulsePurchaseListButton()
}

function undoPlannedAcceptance(row) {
  const undo = plannedUndoHistory[row.id]
  if (!undo) return

  const item = inventoryItems.find((entry) => entry.id === row.id)
  if (!item) return

  item.planned = undo.previousPlanned
  restorePurchaseItem(row.id, undo.previousPurchaseItem)
  delete plannedDrafts[row.id]
  delete plannedUndoHistory[row.id]
}

function getRowClassName({ row }) {
  return [
    row.isProductGroup ? 'product-group-row' : 'product-color-row',
    collapsingProductKeys.value.has(`product:${row.product}`)
      ? 'product-group-collapsing'
      : '',
    expandingProductKeys.value.has(`product:${row.product}`)
      ? 'product-group-expanding'
      : '',
    !row.isProductGroup && row.id === selectedRowId.value ? 'inventory-row-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function handleRowClick(row) {
  if (row.isProductGroup) {
    selectedRowId.value = null
    return
  }

  selectedRowId.value = row.id
}

function getProductInputWidth(product) {
  const value = productDrafts[product] ?? product
  const textWidth = [...value].reduce(
    (width, character) => width + (/[^\x00-\xff]/.test(character) ? 14 : 8),
    0,
  )

  return `${Math.min(108, Math.max(48, textWidth + 12))}px`
}

function getColorInputWidth(color) {
  const textWidth = [...color].reduce(
    (width, character) => width + (/[^\x00-\xff]/.test(character) ? 14 : 8),
    0,
  )

  return `${Math.min(84, Math.max(44, textWidth + 12))}px`
}

function updateValue(id, field, value) {
  if (value !== null || field === 'planned') {
    const item = inventoryItems.find((inventoryItem) => inventoryItem.id === id)
    if (item) item[field] = value
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function getExcelColumnName(index) {
  let name = ''
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

function createExcelCell(value, reference, styleIndex = 0) {
  const style = styleIndex > 0 ? ` s="${styleIndex}"` : ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`
  }

  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value ?? '')}</t></is></c>`
}

function exportInventoryToExcel() {
  const columnGroups = [
    { label: '信息', columns: ['备货类型', '色彩'] },
    { label: '商品', columns: ['品名', '颜色', '预警'] },
    { label: '入口', columns: ['需安排', '生产中'] },
    { label: '出口', columns: ['欠货', '周消耗'] },
    { label: '库存', columns: ['在仓库存', '在途库存', '理论库存'] },
    { label: '数据反馈', columns: ['缺口量', '缺口率', '库销比'] },
    { label: '备货策略', columns: ['红线库存', '正常库存', '峰值库存', '系数'] },
  ]
  const groupHeaders = []
  const merges = []
  let columnIndex = 0

  columnGroups.forEach(({ label, columns }) => {
    const start = columnIndex
    groupHeaders.push(label, ...Array(columns.length - 1).fill(''))
    columnIndex += columns.length
    if (columns.length > 1) {
      merges.push({ s: { r: 0, c: start }, e: { r: 0, c: columnIndex - 1 } })
    }
  })

  const headers = columnGroups.flatMap(({ columns }) => columns)
  const data = inventoryLeafRows.value.map((row) => [
    row.stockingType,
    row.category,
    row.product,
    row.color,
    row.urgencyText,
    row.planned,
    row.producing,
    row.backorder,
    row.weeklyUsage,
    row.warehouseStock,
    row.inTransitStock,
    row.theoreticalStock,
    row.shortage ?? '缺省',
    formatRate(row.shortageRate, row.strategyAvailable),
    formatRatio(row.stockSalesRatio),
    row.redLineStock ?? '缺省',
    row.normalStock ?? '缺省',
    row.peakStock ?? '缺省',
    formatFactors(row),
  ])
  const rows = [groupHeaders, headers, ...data]
  const worksheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          if (rowIndex === 0 && columnIndex > 0 && groupHeaders[columnIndex] === '') return ''
          const styleIndex = rowIndex === 0 ? 1 : rowIndex === 1 ? 2 : 0
          const reference = `${getExcelColumnName(columnIndex)}${rowIndex + 1}`
          return createExcelCell(value, reference, styleIndex)
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  const mergeReferences = merges
    .map(
      ({ s, e }) =>
        `${getExcelColumnName(s.c)}${s.r + 1}:${getExcelColumnName(e.c)}${e.r + 1}`,
    )
    .join(' ')
  const columnWidths = [10, 10, 18, 12, 14, 12, 12, 12, 10, 10, 12, 12, 12, 12, 12, 10, 12, 12, 12]
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('')
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columnWidths}</cols><sheetData>${worksheetRows}</sheetData><autoFilter ref="A2:S${rows.length}"/><mergeCells count="${merges.length}">${mergeReferences
    .split(' ')
    .filter(Boolean)
    .map((ref) => `<mergeCell ref="${ref}"/>`)
    .join('')}</mergeCells></worksheet>`
  const styleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF2F3B43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5EDF1"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="库存数据" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml,
    'xl/styles.xml': styleXml,
  }

  try {
    const workbookBytes = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]),
      ),
      { level: 6 },
    )
    const workbookBlob = new Blob([workbookBytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const downloadUrl = URL.createObjectURL(workbookBlob)
    const link = document.createElement('a')
    const timestamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')
    link.href = downloadUrl
    link.download = `库存数据-${timestamp}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    ElMessage.success('Excel 文件已保存')
  } catch (error) {
    console.error('Failed to export inventory workbook', error)
    ElMessage.error(`Excel 导出失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function exportPurchaseListToExcel() {
  const rows = [
    ['品名', '颜色', '需安排', '实际计划'],
    ...purchaseListRows.value.map((item) => [
      item.product,
      item.color,
      item.planned,
      item.actualPlan ?? '',
    ]),
  ]
  const worksheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const reference = `${getExcelColumnName(columnIndex)}${rowIndex + 1}`
          return createExcelCell(value, reference, rowIndex === 0 ? 1 : 0)
        })
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/><col min="3" max="4" width="16" customWidth="1"/></cols><sheetData>${worksheetRows}</sheetData><autoFilter ref="A1:D${rows.length}"/></worksheet>`
  const styleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF2F3B43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="本次采购清单" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': worksheetXml,
    'xl/styles.xml': styleXml,
  }

  try {
    const workbookBytes = zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]),
      ),
      { level: 6 },
    )
    const workbookBlob = new Blob([workbookBytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const downloadUrl = URL.createObjectURL(workbookBlob)
    const link = document.createElement('a')
    const timestamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-')
    link.href = downloadUrl
    link.download = `本次采购清单-${timestamp}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    ElMessage.success('本次采购清单已导出')
  } catch (error) {
    console.error('Failed to export purchase list workbook', error)
    ElMessage.error(`采购清单导出失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

function updateProductDraft(product, value) {
  productDrafts[product] = value
}

function commitProduct(currentProduct) {
  const updatedProduct = productDrafts[currentProduct]
  if (updatedProduct === undefined) return

  const product = normalizeProductName(updatedProduct)
  if (product) {
    inventoryItems.forEach((item) => {
      if (item.product === currentProduct) item.product = product
    })
  }

  delete productDrafts[currentProduct]
}

</script>

<template>
  <main class="inventory-page">
    <span
      v-if="flyingPurchaseIcon"
      class="purchase-fly-icon"
      :style="{
        left: `${flyingPurchaseIcon.left}px`,
        top: `${flyingPurchaseIcon.top}px`,
        '--purchase-fly-x': `${flyingPurchaseIcon.offsetX}px`,
        '--purchase-fly-y': `${flyingPurchaseIcon.offsetY}px`,
      }"
      aria-hidden="true"
      @animationend="onPurchaseIconAnimationEnd"
    >
      <svg viewBox="0 0 20 20">
        <path
          d="M4 6.5h12l-1 9H5l-1-9Zm3 0V5a3 3 0 0 1 6 0v1.5M8 10v2m4-2v2"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.6"
        />
      </svg>
    </span>
    <nav class="page-navigation" aria-label="页面导航">
      <RouterLink to="/" class="page-navigation-link">主面板</RouterLink>
      <RouterLink to="/config" class="page-navigation-link">配置信息</RouterLink>
    </nav>
    <div class="table-toolbar">
      <div class="table-toolbar-group table-toolbar-group--left">
        <ElButton type="primary" class="add-item-button" @click="openAddItemDialog">
          + 加入商品
        </ElButton>
        <ElButton class="export-excel-button" @click="exportInventoryToExcel">
          保存Excel
        </ElButton>
      </div>
      <div class="table-toolbar-group table-toolbar-group--right">
        <ElButton
          class="urgent-plan-button"
          :disabled="urgentRows.length === 0"
          @click="openUrgentPlanDialog"
        >
          紧急补货 <span class="urgent-count">{{ urgentRows.length }}</span>
        </ElButton>
        <ElButton
          class="purchase-list-button"
          :class="{ 'purchase-list-button--received': purchaseListPulse }"
          @click="purchaseListDialogVisible = true"
        >
          本次采购清单 <span class="urgent-count">{{ purchaseList.length }}</span>
        </ElButton>
      </div>
    </div>
    <div class="inventory-filters" aria-label="库存筛选">
      <ElInput
        v-model="productFilter"
        class="text-filter"
        placeholder="按品名筛选"
        aria-label="按品名筛选"
        clearable
      />
      <ElInput
        v-model="colorFilter"
        class="text-filter"
        placeholder="按颜色筛选"
        aria-label="按颜色筛选"
        clearable
      />
      <div class="warning-filters" role="group" aria-label="按预警状态筛选">
        <button
          v-for="filter in warningFilters"
          :key="filter.key"
          type="button"
          class="warning-filter"
          :class="[
            `warning-filter--${filter.key}`,
            {
              'warning-filter--active':
                filter.key === 'all'
                  ? !hasActiveFilters
                  : selectedWarningTones.includes(filter.key),
            },
          ]"
          :aria-pressed="
            filter.key === 'all'
              ? !hasActiveFilters
              : selectedWarningTones.includes(filter.key)
          "
          @click="toggleWarningFilter(filter.key)"
        >
          <span
            v-if="filter.key !== 'all'"
            class="warning-filter-indicator"
            :class="`urgency-indicator--${filter.key}`"
            aria-hidden="true"
          />
          {{ filter.label }}
          <span class="warning-filter-count">{{ warningCounts[filter.key] }}</span>
        </button>
      </div>
      <ElButton class="reset-filters-button" @click="resetFilters">重置</ElButton>
    </div>
    <ElTable
      ref="inventoryTableRef"
      class="inventory-table"
      :data="inventoryRows"
      row-key="id"
      :expand-row-keys="expandedProductKeys"
      @expand-change="handleExpandChange"
      :tree-props="{ children: 'children' }"
      :cell-class-name="getCellClassName"
      :row-class-name="getRowClassName"
      @cell-click="handleCellClick"
      @row-click="handleRowClick"
      border
      table-layout="fixed"
    >
    <ElTableColumn label="商品" align="center">
      <ElTableColumn prop="product" label="品名/颜色" min-width="116" align="center">
        <template #default="{ row }">
          <ElInput
            v-if="row.isProductGroup"
            :model-value="productDrafts[row.product] ?? row.product"
            :style="{ width: getProductInputWidth(row.product) }"
            class="product-input"
            aria-label="品名"
            @update:model-value="updateProductDraft(row.product, $event)"
            @blur="commitProduct(row.product)"
          />
          <ElInput
            v-else
            :model-value="row.color"
            :style="{ width: getColorInputWidth(row.color) }"
            size="small"
            class="editable-text"
            aria-label="颜色"
            @update:model-value="updateValue(row.id, 'color', $event)"
          />
        </template>
      </ElTableColumn>
      <ElTableColumn prop="urgency" label="预警" min-width="38" align="center">
        <template #default="{ row }">
          <span
            v-if="!row.isProductGroup"
            class="urgency-indicator"
            :class="`urgency-indicator--${row.urgencyTone}`"
            :title="row.urgencyText"
            :aria-label="`紧急状态：${row.urgencyText}`"
          />
        </template>
      </ElTableColumn>
    </ElTableColumn>

    <ElTableColumn label="入口" align="center">
      <ElTableColumn prop="planned" label="需安排" min-width="122" align="center">
        <template #default="{ row }">
          <template v-if="row.isProductGroup">{{ formatQuantity(row.planned) }}</template>
          <div v-else class="planned-entry">
            <div
              class="planned-input-shell"
              :class="{ 'planned-input-shell--locked': row.hasPlannedUndo }"
            >
              <ElInputNumber
                :model-value="getPlannedDraft(row)"
                :placeholder="getPlannedPlaceholder(row)"
                :title="row.hasPlannedUndo ? '已采纳，点击撤销后可修改' : getPlannedPlaceholderTitle(row)"
                :min="0"
                :controls="false"
                size="small"
                class="editable-number planned-input"
                aria-label="需安排"
                :disabled="row.hasPlannedUndo"
                @input="updatePlannedDraft(row.id, $event)"
                @update:model-value="updatePlannedDraft(row.id, $event)"
              />
              <svg
                v-if="row.hasPlannedUndo"
                class="planned-lock-icon"
                viewBox="0 0 16 16"
                aria-label="已采纳并锁定"
                role="img"
              >
                <path
                  d="M4.5 6V4.75a3.5 3.5 0 0 1 7 0V6m-8 0h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm4.5 3v2"
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.5"
                />
              </svg>
            </div>
            <ElButton
              class="planned-accept-button"
              size="small"
              :disabled="!row.hasPlannedDraft && !row.hasPlannedUndo"
              :aria-label="`${row.product} ${row.color} ${row.hasPlannedDraft || !row.hasPlannedUndo ? '采纳需安排' : '撤销需安排'}`"
              @click.stop="handlePlannedAction(row, $event)"
            >
              {{ row.hasPlannedDraft || !row.hasPlannedUndo ? '采纳' : '撤销' }}
            </ElButton>
          </div>
        </template>
      </ElTableColumn>
      <ElTableColumn label="生产中" min-width="52" align="center">
        <template #default="{ row }">
          <template v-if="row.isProductGroup">{{ formatQuantity(row.producing) }}</template>
          <ElInputNumber
            v-else
            :model-value="row.producing"
            :min="0"
            :controls="false"
            size="small"
            class="editable-number"
            aria-label="生产中"
            @update:model-value="updateValue(row.id, 'producing', $event)"
          />
        </template>
      </ElTableColumn>
    </ElTableColumn>

    <ElTableColumn label="出口" align="center">
      <ElTableColumn label="欠货" min-width="48" align="center">
        <template #default="{ row }">
          <template v-if="row.isProductGroup">{{ formatQuantity(row.backorder) }}</template>
          <ElInputNumber
            v-else
            :model-value="row.backorder"
            :min="0"
            :controls="false"
            size="small"
            class="editable-number"
            aria-label="欠货"
            @update:model-value="updateValue(row.id, 'backorder', $event)"
          />
        </template>
      </ElTableColumn>
      <ElTableColumn label="周消耗" min-width="54" align="center">
        <template #default="{ row }">
          <template v-if="row.isProductGroup">{{ formatQuantity(row.weeklyUsage) }}</template>
          <ElInputNumber
            v-else
            :model-value="row.weeklyUsage"
            :min="0"
            :controls="false"
            size="small"
            class="editable-number"
            aria-label="周消耗"
            @update:model-value="updateValue(row.id, 'weeklyUsage', $event)"
          />
        </template>
      </ElTableColumn>
    </ElTableColumn>

    <ElTableColumn label="库存" align="center">
      <ElTableColumn label="在仓库存" min-width="54" align="center">
        <template #default="{ row }">
          <template v-if="row.isProductGroup">{{ formatQuantity(row.warehouseStock) }}</template>
          <ElInputNumber
            v-else
            :model-value="row.warehouseStock"
            :min="0"
            :controls="false"
            size="small"
            class="editable-number"
            aria-label="在仓库存"
            @update:model-value="updateValue(row.id, 'warehouseStock', $event)"
          />
        </template>
      </ElTableColumn>
      <ElTableColumn label="在途库存" min-width="54" align="center">
        <template #default="{ row }">{{ formatQuantity(row.inTransitStock) }}</template>
      </ElTableColumn>
      <ElTableColumn label="理论库存" min-width="54" align="center">
        <template #default="{ row }">{{ formatQuantity(row.theoreticalStock) }}</template>
      </ElTableColumn>
    </ElTableColumn>

    <ElTableColumn label="数据反馈" align="center">
      <ElTableColumn label="缺口量" min-width="48" align="center">
        <template #default="{ row }">{{ formatQuantity(row.shortage) }}</template>
      </ElTableColumn>
      <ElTableColumn label="缺口率" min-width="52" align="center">
        <template #default="{ row }">
          {{ formatRate(row.shortageRate, row.strategyAvailable) }}
        </template>
      </ElTableColumn>
      <ElTableColumn label="库销比" min-width="44" align="center">
        <template #default="{ row }">{{ formatRatio(row.stockSalesRatio) }}</template>
      </ElTableColumn>
    </ElTableColumn>
    </ElTable>

    <ElDialog
      v-model="addItemDialogVisible"
      title="加入商品"
      width="560px"
      class="add-item-dialog"
      :close-on-click-modal="false"
    >
      <ElForm
        ref="addItemFormRef"
        :model="addItemForm"
        :rules="addItemRules"
        label-width="100px"
        class="add-item-form"
      >
        <div class="add-item-grid">
          <ElFormItem label="品名" prop="product">
            <ElInput
              v-model="addItemForm.product"
              placeholder="输入新品名；已有品名请填写相同名称"
            />
          </ElFormItem>
          <ElFormItem label="颜色" prop="color">
            <ElInput v-model="addItemForm.color" placeholder="请输入颜色" />
          </ElFormItem>
          <ElFormItem label="备货类型">
            <ElSelect v-model="addItemForm.stockingType">
              <ElOption label="热销" value="热销" />
              <ElOption label="常规" value="常规" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem label="色彩">
            <ElSelect v-model="addItemForm.category">
              <ElOption label="黑白" value="黑白" />
              <ElOption label="彩色" value="彩色" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem label="需安排">
            <ElInputNumber v-model="addItemForm.planned" :min="0" :controls="false" />
          </ElFormItem>
          <ElFormItem label="生产中">
            <ElInputNumber v-model="addItemForm.producing" :min="0" :controls="false" />
          </ElFormItem>
          <ElFormItem label="欠货">
            <ElInputNumber v-model="addItemForm.backorder" :min="0" :controls="false" />
          </ElFormItem>
          <ElFormItem label="周消耗">
            <ElInputNumber v-model="addItemForm.weeklyUsage" :min="0" :controls="false" />
          </ElFormItem>
          <ElFormItem label="在仓库存">
            <ElInputNumber v-model="addItemForm.warehouseStock" :min="0" :controls="false" />
          </ElFormItem>
        </div>
      </ElForm>
      <template #footer>
        <div class="dialog-footer">
          <ElButton @click="addItemDialogVisible = false">取消</ElButton>
          <ElButton type="primary" @click="submitNewItem">加入</ElButton>
        </div>
      </template>
    </ElDialog>

    <ElDialog
      v-model="urgentPlanDialogVisible"
      title="紧急补货计划"
      width="820px"
      class="urgent-plan-dialog"
      :close-on-click-modal="false"
    >
      <p class="urgent-plan-hint">
        填写新增计划数量，提交后将累加到主表“需安排”。推荐计划数按补至绿色状态的最低数量计算。
      </p>
      <div class="urgent-plan-table" role="table" aria-label="紧急补货计划">
        <div class="urgent-plan-header" role="row">
          <span role="columnheader">商品信息</span>
          <span role="columnheader">目前需安排</span>
          <span role="columnheader">新增计划</span>
          <span role="columnheader">推荐计划数</span>
        </div>
        <div
          v-for="row in urgentPlanRows"
          :key="row.id"
          class="urgent-plan-row"
          role="row"
        >
          <div class="urgent-plan-product" role="cell">
            <strong>{{ row.product }}</strong>
            <span>{{ row.color }}</span>
          </div>
          <span role="cell">{{ formatQuantity(row.currentPlanned) }}</span>
          <div role="cell">
            <ElInputNumber
              v-model="row.additionalPlan"
              :min="0"
              :precision="0"
              :controls="false"
              size="small"
              class="urgent-plan-input"
              :aria-label="`${row.product} ${row.color} 新增计划`"
            />
          </div>
          <div class="urgent-plan-recommendation" role="cell">
            <strong>{{ formatQuantity(row.recommendedPlan) }}</strong>
            <ElButton
              text
              type="primary"
              @click="row.additionalPlan = row.recommendedPlan"
            >
              采用
            </ElButton>
          </div>
        </div>
        <div v-if="urgentPlanRows.length === 0" class="urgent-plan-empty">
          当前没有紧急补货商品
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <ElButton @click="urgentPlanDialogVisible = false">取消</ElButton>
          <ElButton
            class="apply-all-button"
            :disabled="urgentPlanRows.length === 0"
            @click="applyAllRecommendedPlans"
          >
            全部采用
          </ElButton>
          <ElButton type="primary" :disabled="!hasUrgentPlan" @click="submitUrgentPlans">
            确认提交
          </ElButton>
        </div>
      </template>
    </ElDialog>

    <ElDialog
      v-model="purchaseListDialogVisible"
      title="本次采购清单"
      width="680px"
      class="purchase-list-dialog"
      :close-on-click-modal="false"
    >
      <p class="purchase-list-hint">
        已采纳的需安排会加入清单；同一商品颜色只保留一条。实际计划仅作采购记录，不影响库存计算。
      </p>
      <ElTable
        :data="purchaseListRows"
        row-key="id"
        border
        table-layout="fixed"
        class="purchase-list-table"
        empty-text="暂无已采纳的采购计划"
      >
        <ElTableColumn prop="product" label="品名" min-width="190" />
        <ElTableColumn prop="color" label="颜色" width="110" align="center" />
        <ElTableColumn prop="planned" label="需安排" width="120" align="center">
          <template #default="{ row }">{{ formatQuantity(row.planned) }}</template>
        </ElTableColumn>
        <ElTableColumn label="实际计划" width="170" align="center">
          <template #default="{ row }">
            <ElInputNumber
              :model-value="row.actualPlan"
              :min="0"
              :precision="0"
              :controls="false"
              size="small"
              class="purchase-list-actual-input"
              :aria-label="`${row.product} ${row.color} 实际计划`"
              @update:model-value="updatePurchaseActualPlan(row.id, $event)"
            />
          </template>
        </ElTableColumn>
      </ElTable>
      <template #footer>
        <div class="dialog-footer">
          <ElButton @click="purchaseListDialogVisible = false">关闭</ElButton>
          <ElButton
            type="primary"
            :disabled="purchaseList.length === 0"
            @click="exportPurchaseListToExcel"
          >
            导出 Excel
          </ElButton>
        </div>
      </template>
    </ElDialog>
  </main>
</template>

<style scoped>
:global(:root) {
  --industrial-page: #e7ecef;
  --industrial-surface: #f5f7f8;
  --industrial-header: #d4dee4;
  --industrial-grid: #aab6be;
  --industrial-grid-light: #c4cdd3;
  --industrial-primary: #3f718d;
  --industrial-primary-hover: #4d829f;
  --industrial-primary-active: #315e77;
  --industrial-danger: #b84f48;
  --industrial-danger-hover: #a9433d;
  --industrial-danger-active: #923a35;
  --industrial-text: #2f3b43;
  --industrial-muted: #65737c;
  --industrial-urgent: #b84f48;
  --industrial-overstock: #8e7a91;
  --industrial-normal: #829a85;
  --industrial-replenish: #c49a52;
  --industrial-unavailable: #e1e6e9;
}

.inventory-page {
  position: relative;
  min-height: 100vh;
  padding: 12px;
  background: var(--industrial-page);
}

.purchase-fly-icon {
  position: fixed;
  z-index: 4000;
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.85);
  border-radius: 50%;
  background: var(--industrial-primary);
  box-shadow: 0 2px 7px rgba(34, 57, 69, 0.35);
  pointer-events: none;
  animation: purchase-icon-fly 900ms cubic-bezier(0.2, 0.75, 0.25, 1) both;
}

.purchase-fly-icon svg {
  width: 14px;
  height: 14px;
}

@keyframes purchase-icon-fly {
  to {
    transform: translate3d(var(--purchase-fly-x), var(--purchase-fly-y), 0) scale(0.45);
    opacity: 0.2;
  }
}

@media (prefers-reduced-motion: reduce) {
  .purchase-fly-icon {
    animation-duration: 1ms;
  }

  .purchase-list-button--received {
    animation-duration: 1ms;
  }
}

.page-navigation {
  display: flex;
  gap: 6px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--industrial-grid);
}

.page-navigation-link {
  padding: 9px 16px;
  color: var(--industrial-muted);
  border-bottom: 2px solid transparent;
  text-decoration: none;
}

.page-navigation-link:hover,
.page-navigation-link.router-link-active {
  color: var(--industrial-primary);
}

.page-navigation-link.router-link-active {
  border-bottom-color: var(--industrial-primary);
  font-weight: 600;
}

.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
}

.table-toolbar-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.table-toolbar-group--left {
  justify-content: flex-start;
}

.table-toolbar-group--right {
  justify-content: flex-end;
}

.table-toolbar-group :deep(.el-button) {
  margin-left: 0;
}

@media (max-width: 600px) {
  .table-toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .table-toolbar-group {
    flex-wrap: wrap;
  }
}

.inventory-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 0 8px;
}

.text-filter {
  width: 150px;
}

.warning-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.warning-filter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 3px 9px;
  color: var(--industrial-muted);
  border: 1px solid var(--industrial-grid);
  border-radius: 3px;
  background: var(--industrial-surface);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.warning-filter:hover,
.warning-filter--active {
  color: var(--industrial-primary);
  border-color: var(--industrial-primary);
  background: #e5edf1;
}

.warning-filter:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: 2px;
}

.warning-filter-indicator {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border: 1px solid rgba(47, 59, 67, 0.25);
  border-radius: 1px;
}

.warning-filter-indicator.urgency-indicator--red {
  background: var(--industrial-urgent);
}

.warning-filter-indicator.urgency-indicator--yellow {
  background: var(--industrial-replenish);
}

.warning-filter-indicator.urgency-indicator--green {
  background: var(--industrial-normal);
}

.warning-filter-indicator.urgency-indicator--purple {
  background: var(--industrial-overstock);
}

.warning-filter-count {
  min-width: 16px;
  color: var(--industrial-text);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.urgent-plan-button {
  --el-button-text-color: #fff;
  --el-button-bg-color: var(--industrial-danger);
  --el-button-border-color: var(--industrial-danger);
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: var(--industrial-danger-hover);
  --el-button-hover-border-color: var(--industrial-danger-hover);
  --el-button-active-bg-color: var(--industrial-danger-active);
  --el-button-active-border-color: var(--industrial-danger-active);
}

.urgent-count {
  min-width: 18px;
  margin-left: 4px;
  font-weight: 700;
}

.add-item-button {
  --el-button-bg-color: var(--industrial-primary);
  --el-button-border-color: var(--industrial-primary);
  --el-button-hover-bg-color: var(--industrial-primary-hover);
  --el-button-hover-border-color: var(--industrial-primary-hover);
  --el-button-active-bg-color: var(--industrial-primary-active);
  --el-button-active-border-color: var(--industrial-primary-active);
}

.export-excel-button {
  --el-button-text-color: var(--industrial-primary);
  --el-button-bg-color: var(--industrial-surface);
  --el-button-border-color: var(--industrial-primary);
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: var(--industrial-primary-hover);
  --el-button-hover-border-color: var(--industrial-primary-hover);
  --el-button-active-text-color: #fff;
  --el-button-active-bg-color: var(--industrial-primary-active);
  --el-button-active-border-color: var(--industrial-primary-active);
}

.purchase-list-button {
  --el-button-text-color: var(--industrial-primary);
  --el-button-bg-color: #e5edf1;
  --el-button-border-color: #8da2ad;
  --el-button-hover-text-color: #fff;
  --el-button-hover-bg-color: var(--industrial-primary-hover);
  --el-button-hover-border-color: var(--industrial-primary-hover);
  --el-button-active-text-color: #fff;
  --el-button-active-bg-color: var(--industrial-primary-active);
  --el-button-active-border-color: var(--industrial-primary-active);
}

.purchase-list-button--received {
  animation: purchase-list-pulse 600ms ease-out;
}

@keyframes purchase-list-pulse {
  35% {
    transform: scale(1.08);
    box-shadow: 0 0 0 4px rgba(63, 113, 141, 0.2);
  }
}

.add-item-form :deep(.el-select),
.add-item-form :deep(.el-input-number) {
  width: 100%;
}

.add-item-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 20px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:global(.add-item-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
}

:global(.urgent-plan-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
}

:global(.purchase-list-dialog) {
  --el-color-primary: var(--industrial-primary);
  --el-dialog-bg-color: var(--industrial-surface);
  --el-text-color-primary: var(--industrial-text);
  --el-text-color-regular: var(--industrial-text);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-fill-color-blank: var(--industrial-surface);
}

.purchase-list-hint {
  margin: 0 0 14px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.purchase-list-table {
  width: 100%;
  --el-table-border-color: var(--industrial-grid);
  --el-table-header-bg-color: transparent;
  --el-table-tr-bg-color: var(--industrial-surface);
  --el-table-row-hover-bg-color: #edf1f3;
  --el-bg-color: var(--industrial-surface);
  --el-fill-color-blank: var(--industrial-surface);
  color: var(--industrial-text);
}

.purchase-list-actual-input {
  width: 130px;
}

.urgent-plan-hint {
  margin: 0 0 16px;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

.urgent-plan-table {
  max-height: min(55vh, 480px);
  overflow: auto;
  border: 1px solid var(--industrial-grid);
  border-radius: 4px;
}

.urgent-plan-header,
.urgent-plan-row {
  display: grid;
  grid-template-columns: minmax(190px, 1.5fr) repeat(3, minmax(120px, 1fr));
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 6px 12px;
  text-align: center;
}

.urgent-plan-header {
  position: sticky;
  top: 0;
  z-index: 1;
  color: var(--industrial-text);
  background: var(--industrial-header);
  font-weight: 600;
}

.urgent-plan-row {
  border-top: 1px solid var(--industrial-grid-light);
  color: var(--industrial-text);
}

.urgent-plan-product {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
}

.urgent-plan-product span {
  color: var(--industrial-muted);
}

.urgent-plan-input {
  width: 100%;
}

.urgent-plan-recommendation {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--industrial-primary);
}

.urgent-plan-empty {
  padding: 28px 12px;
  color: var(--industrial-muted);
  text-align: center;
}

.inventory-table {
  width: 100%;
  --el-color-primary: var(--industrial-primary);
  --el-border-color: var(--industrial-grid);
  --el-border-color-light: var(--industrial-grid-light);
  --el-table-border-color: var(--industrial-grid);
  --el-table-header-bg-color: var(--industrial-header);
  --el-table-tr-bg-color: var(--industrial-surface);
  --el-table-row-hover-bg-color: var(--industrial-surface);
  --el-bg-color: var(--industrial-surface);
  --el-fill-color-blank: var(--industrial-surface);
  color: var(--industrial-text);
  font-size: 13px;
}

.inventory-table :deep(td.el-table__cell) {
  background-color: var(--industrial-surface) !important;
}

.inventory-table :deep(.el-table__body tr.product-group-row > td.el-table__cell) {
  background-color: var(--industrial-header) !important;
  font-weight: 600;
}

.inventory-table :deep(th.el-table__cell),
.inventory-table :deep(td.el-table__cell) {
  padding: 2px 0;
}

.inventory-table :deep(th.el-table__cell) {
  color: var(--industrial-text);
  font-weight: 500;
  background: var(--industrial-header) !important;
}

.inventory-table :deep(.cell) {
  padding: 0 2px;
  line-height: 20px;
  white-space: nowrap;
}

.inventory-table :deep(.el-table__body td.el-table__cell) {
  position: relative;
}

.inventory-table :deep(td.product-cell-clickable) {
  cursor: pointer;
}

.inventory-table :deep(td.product-cell-clickable .el-table__expand-icon) {
  pointer-events: none;
}

.inventory-table :deep(td.product-cell-clickable .product-input .el-input__inner) {
  cursor: pointer;
}

.inventory-table :deep(tr.product-color-row.product-group-expanding > td) {
  animation: sku-row-enter 120ms ease-out both;
}

.inventory-table :deep(tr.product-color-row.product-group-collapsing > td) {
  animation: sku-row-leave 120ms ease-in forwards;
  pointer-events: none;
}

@keyframes sku-row-enter {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes sku-row-leave {
  to {
    opacity: 0;
    transform: translateY(-3px);
  }
}

.inventory-table :deep(.el-table__body td.el-table__cell > .cell) {
  position: relative;
  z-index: 1;
}

.inventory-table :deep(
  .el-table__body tr:not(.inventory-row-selected):hover > td.el-table__cell
) {
  box-shadow: inset 0 2px rgba(63, 113, 141, 0.58), inset 0 -2px rgba(63, 113, 141, 0.58);
}

.inventory-table :deep(
  .el-table__body tr:not(.inventory-row-selected):hover > td.el-table__cell:first-child
) {
  box-shadow:
    inset 2px 0 rgba(63, 113, 141, 0.58),
    inset 0 2px rgba(63, 113, 141, 0.58),
    inset 0 -2px rgba(63, 113, 141, 0.58);
}

.inventory-table :deep(
  .el-table__body tr:not(.inventory-row-selected):hover > td.el-table__cell:last-child
) {
  box-shadow:
    inset -2px 0 rgba(63, 113, 141, 0.58),
    inset 0 2px rgba(63, 113, 141, 0.58),
    inset 0 -2px rgba(63, 113, 141, 0.58);
}

.inventory-table :deep(.el-table__body tr.inventory-row-selected > td.el-table__cell) {
  box-shadow: inset 0 2px rgba(63, 113, 141, 0.82), inset 0 -2px rgba(63, 113, 141, 0.82);
}

.inventory-table :deep(.el-table__body tr.inventory-row-selected > td.el-table__cell:first-child) {
  box-shadow:
    inset 2px 0 rgba(63, 113, 141, 0.82),
    inset 0 2px rgba(63, 113, 141, 0.82),
    inset 0 -2px rgba(63, 113, 141, 0.82);
}

.inventory-table :deep(.el-table__body tr.inventory-row-selected > td.el-table__cell:last-child) {
  box-shadow:
    inset -2px 0 rgba(63, 113, 141, 0.82),
    inset 0 2px rgba(63, 113, 141, 0.82),
    inset 0 -2px rgba(63, 113, 141, 0.82);
}

.inventory-table :deep(.el-table__body td.el-table__cell.product-cell-highlighted) {
  box-shadow: inset 0 0 0 2px rgba(63, 113, 141, 0.82) !important;
}

.inventory-table :deep(.editable-number) {
  width: 100%;
}

.inventory-table :deep(.editable-number .el-input),
.inventory-table :deep(.editable-number .el-input__wrapper),
.inventory-table :deep(.editable-number .el-input__inner) {
  width: 100%;
}

.inventory-table :deep(.editable-number .el-input__wrapper) {
  padding: 0 2px;
  background: transparent;
  box-shadow: none;
}

.inventory-table :deep(.editable-number .el-input__inner),
.inventory-table :deep(.editable-text .el-input__inner),
.inventory-table :deep(.editable-select .el-select__selected-item) {
  color: var(--industrial-text);
}

.inventory-table :deep(.editable-number .el-input__inner) {
  text-align: center;
}

.inventory-table :deep(.editable-text .el-input__wrapper) {
  padding: 0 3px;
  background: transparent;
  box-shadow: none;
}

.inventory-table :deep(.editable-text .el-input__inner) {
  text-align: center;
}

.inventory-table :deep(.product-input .el-input__wrapper) {
  padding: 0 2px;
  background: transparent;
  box-shadow: none;
}

.inventory-table :deep(.product-input .el-input__inner) {
  text-align: center;
  color: inherit;
  text-overflow: clip;
}

.inventory-table :deep(.product-input .el-input__wrapper.is-focus) {
  border-color: var(--industrial-primary);
  box-shadow: 0 0 0 1px rgba(63, 113, 141, 0.24);
}

.inventory-table :deep(.editable-text .el-input__inner) {
  text-overflow: clip;
}

.inventory-table :deep(.editable-select) {
  width: 100%;
}

.inventory-table :deep(.editable-select .el-select__wrapper) {
  min-height: 22px;
  padding: 0 2px;
  background: transparent;
  box-shadow: none;
}

.inventory-table :deep(.editable-select .el-select__selected-item) {
  font-size: 13px;
}

.inventory-table :deep(.planned-cell) {
  font-weight: 700;
}

.inventory-table :deep(.planned-cell .editable-number .el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--industrial-primary) inset !important;
}

.planned-entry {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
}

.inventory-table :deep(.planned-input) {
  width: 84px;
  flex: 0 0 84px;
}

.planned-input-shell {
  position: relative;
  width: 84px;
  flex: 0 0 84px;
}

.inventory-table :deep(.planned-cell .planned-input-shell--locked .planned-input .el-input__wrapper) {
  padding-right: 20px;
  background-color: #dce6eb !important;
  box-shadow: 0 0 0 1px #8da2ad inset !important;
}

.inventory-table :deep(.planned-input-shell--locked .el-input__inner) {
  color: #263d49 !important;
  -webkit-text-fill-color: #263d49 !important;
}

.planned-lock-icon {
  position: absolute;
  top: 50%;
  right: 5px;
  z-index: 1;
  width: 12px;
  height: 12px;
  color: #496777;
  pointer-events: none;
  transform: translateY(-50%);
}

.inventory-table :deep(.planned-accept-button) {
  min-height: 22px;
  height: 22px;
  padding: 0 4px;
  font-size: 11px;
}

.inventory-table :deep(.planned-cell--red .editable-number .el-input__wrapper) {
  background-color: #f8e5e3 !important;
}

.inventory-table :deep(.planned-cell--yellow .editable-number .el-input__wrapper) {
  background-color: #f7efdc !important;
}

.inventory-table :deep(.planned-cell--green .editable-number .el-input__wrapper) {
  background-color: #e8efe9 !important;
}

.inventory-table :deep(.planned-cell--purple .editable-number .el-input__wrapper) {
  background-color: #eee8f0 !important;
}

.inventory-table :deep(.planned-cell--unavailable .editable-number .el-input__wrapper) {
  background-color: var(--industrial-surface) !important;
}

.inventory-table :deep(.planned-cell .editable-number .el-input__inner) {
  font-weight: 700;
}

.inventory-table :deep(.urgency-indicator) {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 1px solid rgba(47, 59, 67, 0.18);
  border-radius: 2px;
  vertical-align: middle;
}

.inventory-table :deep(.urgency-indicator--red) {
  width: 20px;
  height: 20px;
  background-color: var(--industrial-urgent);
}

.inventory-table :deep(.urgency-indicator--purple) {
  width: 16px;
  height: 16px;
  background-color: var(--industrial-overstock);
}

.inventory-table :deep(.urgency-indicator--green) {
  width: 10px;
  height: 10px;
  background-color: var(--industrial-normal);
}

.inventory-table :deep(.urgency-indicator--yellow) {
  width: 16px;
  height: 16px;
  background-color: var(--industrial-replenish);
}

.inventory-table :deep(.urgency-indicator--unavailable) {
  width: 10px;
  height: 10px;
  background-color: var(--industrial-unavailable);
}
</style>
