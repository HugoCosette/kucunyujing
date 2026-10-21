<script setup>
import { computed, nextTick, reactive, ref } from 'vue'
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
import { initialInventoryItems } from '@/data/inventoryItems'
import { stockingRules } from '@/data/stockingRules'
import {
  calculateInventoryRow,
  formatFactors,
  formatProductEditorValue,
  formatQuantity,
  formatRate,
  formatRatio,
  normalizeProductName,
} from '@/utils/inventory'

const inventoryItems = reactive(initialInventoryItems.map((item) => ({ ...item })))
const productDrafts = reactive({})
const productCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const selectedRowId = ref(null)
const selectedProductGroup = ref(null)
const addItemDialogVisible = ref(false)
const addItemFormRef = ref(null)
const addItemForm = reactive(createEmptyItem())
const urgentPlanDialogVisible = ref(false)
const urgentPlanRows = ref([])

function createEmptyItem() {
  return {
    product: '',
    color: '',
    level: 'S',
    category: '黑白',
    stockingType: '基础',
    planned: 0,
    scheduled: 0,
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
    selectedProductGroup.value = null
    addItemDialogVisible.value = false
  })
}

const inventoryRows = computed(() => {
  return inventoryItems
    .map((item) => calculateInventoryRow(item, stockingRules))
    .sort(
      (first, second) =>
        productCollator.compare(first.product, second.product) ||
        Number(second.color === '黑色') - Number(first.color === '黑色') ||
        productCollator.compare(first.color, second.color) ||
        first.id - second.id,
    )
})

const urgentRows = computed(() => inventoryRows.value.filter((row) => row.urgencyTone === 'red'))
const hasUrgentPlan = computed(() =>
  urgentPlanRows.value.some((row) => row.additionalPlan > 0),
)

function openUrgentPlanDialog() {
  urgentPlanRows.value = urgentRows.value.map((row) => ({
    id: row.id,
    product: row.product,
    color: row.color,
    currentPlanned: row.planned,
    additionalPlan: 0,
    recommendedPlan: Math.max(0, Math.ceil(row.normalStock * 0.8 - row.projectedStock)),
  }))
  urgentPlanDialogVisible.value = true
}

function submitUrgentPlans() {
  for (const planRow of urgentPlanRows.value) {
    if (planRow.additionalPlan <= 0) continue

    const item = inventoryItems.find((entry) => entry.id === planRow.id)
    if (item) item.planned += planRow.additionalPlan
  }

  urgentPlanDialogVisible.value = false
  urgentPlanRows.value = []
}

function applyAllRecommendedPlans() {
  urgentPlanRows.value.forEach((row) => {
    row.additionalPlan = row.recommendedPlan
  })
}

const productRowSpans = computed(() => {
  const spans = new Map()
  const rows = inventoryRows.value

  for (let start = 0; start < rows.length; ) {
    let end = start + 1
    while (end < rows.length && rows[end].product === rows[start].product) {
      end += 1
    }

    spans.set(rows[start].id, end - start)
    for (let index = start + 1; index < end; index += 1) {
      spans.set(rows[index].id, 0)
    }
    start = end
  }

  return spans
})

function mergeProductCells({ row, column }) {
  if (column.property !== 'product') return { rowspan: 1, colspan: 1 }
  const rowspan = productRowSpans.value.get(row.id) ?? 1
  return { rowspan, colspan: rowspan === 0 ? 0 : 1 }
}

function getCellClassName({ row, column }) {
  if (column.property === 'product' && row.product === selectedProduct.value) {
    return 'product-cell-highlighted'
  }
  if (column.property === 'urgency') {
    return `urgency-cell urgency-cell--${row.urgencyTone}`
  }
  if (column.property === 'planned') return 'planned-cell'
  return ''
}

function getRowClassName({ row }) {
  const selectedAsGroup =
    selectedProductGroup.value !== null && row.product === selectedProductGroup.value
  return row.id === selectedRowId.value || selectedAsGroup ? 'inventory-row-selected' : ''
}

function handleRowClick(row, column) {
  if (column.property === 'product') {
    selectedProductGroup.value = row.product
    selectedRowId.value = null
    return
  }

  selectedProductGroup.value = null
  selectedRowId.value = row.id
}

function getProductInputWidth(product) {
  const value = productDrafts[product] ?? formatProductEditorValue(product)
  const longestLineWidth = value.split('\n').reduce((widest, line) => {
    const lineWidth = [...line].reduce(
      (width, character) => width + (/[^\x00-\xff]/.test(character) ? 14 : 8),
      0,
    )
    return Math.max(widest, lineWidth)
  }, 0)

  return `${Math.min(92, Math.max(40, longestLineWidth + 12))}px`
}

function updateValue(id, field, value) {
  if (value !== null) {
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
    { label: '信息', columns: ['等级', '色彩', '备货类型'] },
    { label: '商品', columns: ['品名', '颜色', '紧急状态'] },
    { label: '入口', columns: ['待计划', '已安排', '生产中'] },
    { label: '出口', columns: ['欠货', '周消耗'] },
    { label: '库存', columns: ['在仓库存', '预计库存'] },
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
  const data = inventoryRows.value.map((row) => [
    row.level,
    row.category,
    row.stockingType,
    row.product,
    row.color,
    row.urgencyText,
    row.planned,
    row.scheduled,
    row.producing,
    row.backorder,
    row.weeklyUsage,
    row.warehouseStock,
    row.projectedStock,
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
  const columnWidths = [8, 10, 12, 18, 12, 14, 12, 12, 12, 10, 10, 12, 12, 12, 12, 10, 12, 12, 12, 10]
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('')
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columnWidths}</cols><sheetData>${worksheetRows}</sheetData><autoFilter ref="A2:T${rows.length}"/><mergeCells count="${merges.length}">${mergeReferences
    .split(' ')
    .filter(Boolean)
    .map((ref) => `<mergeCell ref="${ref}"/>`)
    .join('')}</mergeCells></worksheet>`
  const styleXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3F718D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD4DEE4"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="1" borderId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

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

const selectedProduct = computed(
  () =>
    selectedProductGroup.value ??
    inventoryItems.find((item) => item.id === selectedRowId.value)?.product,
)

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
    <div class="table-scroll">
      <div class="table-content">
        <div class="table-toolbar">
          <ElButton
            class="urgent-plan-button"
            :disabled="urgentRows.length === 0"
            @click="openUrgentPlanDialog"
          >
            紧急补货 <span class="urgent-count">{{ urgentRows.length }}</span>
          </ElButton>
          <ElButton type="primary" class="add-item-button" @click="openAddItemDialog">
            + 加入商品
          </ElButton>
          <ElButton class="export-excel-button" @click="exportInventoryToExcel">
            保存Excel
          </ElButton>
        </div>
        <ElTable
          class="inventory-table"
          :data="inventoryRows"
          :cell-class-name="getCellClassName"
          :span-method="mergeProductCells"
          :row-class-name="getRowClassName"
          @row-click="handleRowClick"
          border
          table-layout="fixed"
        >
        <ElTableColumn label="信息" align="center">
          <ElTableColumn label="等级" width="58" align="center">
            <template #default="{ row }">
              <ElSelect
                :model-value="row.level"
                size="small"
                class="editable-select"
                aria-label="等级"
                @update:model-value="updateValue(row.id, 'level', $event)"
              >
                <ElOption label="SS" value="SS" />
                <ElOption label="S" value="S" />
                <ElOption label="A" value="A" />
              </ElSelect>
            </template>
          </ElTableColumn>
          <ElTableColumn label="色彩" width="64" align="center">
            <template #default="{ row }">
              <ElSelect
                :model-value="row.category"
                size="small"
                class="editable-select"
                aria-label="色彩"
                @update:model-value="updateValue(row.id, 'category', $event)"
              >
                <ElOption label="黑白" value="黑白" />
                <ElOption label="彩色" value="彩色" />
              </ElSelect>
            </template>
          </ElTableColumn>
          <ElTableColumn label="备货类型" width="76" align="center">
            <template #default="{ row }">
              <ElSelect
                :model-value="row.stockingType"
                size="small"
                class="editable-select"
                aria-label="备货类型"
                @update:model-value="updateValue(row.id, 'stockingType', $event)"
              >
                <ElOption label="基础" value="基础" />
                <ElOption label="热销" value="热销" />
              </ElSelect>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="商品" align="center">
          <ElTableColumn prop="product" label="品名" width="100" align="center">
            <template #default="{ row }">
              <ElInput
                :model-value="
                  productDrafts[row.product] ?? formatProductEditorValue(row.product)
                "
                :style="{ width: getProductInputWidth(row.product) }"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 2 }"
                resize="none"
                class="product-input"
                aria-label="品名"
                @update:model-value="updateProductDraft(row.product, $event)"
                @blur="commitProduct(row.product)"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn prop="color" label="颜色" width="72" align="center">
            <template #default="{ row }">
              <ElInput
                :model-value="row.color"
                size="small"
                class="editable-text"
                aria-label="颜色"
                @update:model-value="updateValue(row.id, 'color', $event)"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn prop="urgency" label="紧急状态" width="88" align="center">
            <template #default="{ row }">
              <span v-if="row.urgencyTone !== 'green'">{{ row.urgencyText }}</span>
            </template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="入口" align="center">
          <ElTableColumn prop="planned" label="待计划" width="72" align="center">
            <template #default="{ row }">
              <ElInputNumber
                :model-value="row.planned"
                :min="0"
                :controls="false"
                size="small"
                class="editable-number"
                aria-label="待计划"
                @update:model-value="updateValue(row.id, 'planned', $event)"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn label="已安排" width="72" align="center">
            <template #default="{ row }">
              <ElInputNumber
                :model-value="row.scheduled"
                :min="0"
                :controls="false"
                size="small"
                class="editable-number"
                aria-label="已安排"
                @update:model-value="updateValue(row.id, 'scheduled', $event)"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn label="生产中" width="72" align="center">
            <template #default="{ row }">
              <ElInputNumber
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
          <ElTableColumn label="欠货" width="72" align="center">
            <template #default="{ row }">
              <ElInputNumber
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
          <ElTableColumn label="周消耗" width="72" align="center">
            <template #default="{ row }">
              <ElInputNumber
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
          <ElTableColumn label="在仓库存" width="72" align="center">
            <template #default="{ row }">
              <ElInputNumber
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
          <ElTableColumn label="预计库存" width="64" align="center">
            <template #default="{ row }">{{ formatQuantity(row.projectedStock) }}</template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="数据反馈" align="center">
          <ElTableColumn label="缺口量" width="60" align="center">
            <template #default="{ row }">{{ formatQuantity(row.shortage) }}</template>
          </ElTableColumn>
          <ElTableColumn label="缺口率" width="68" align="center">
            <template #default="{ row }">
              {{ formatRate(row.shortageRate, row.strategyAvailable) }}
            </template>
          </ElTableColumn>
          <ElTableColumn label="库销比" width="58" align="center">
            <template #default="{ row }">{{ formatRatio(row.stockSalesRatio) }}</template>
          </ElTableColumn>
        </ElTableColumn>

        <ElTableColumn label="备货策略" align="center">
          <ElTableColumn label="红线库存" width="60" align="center">
            <template #default="{ row }">{{ formatQuantity(row.redLineStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="正常库存" width="60" align="center">
            <template #default="{ row }">{{ formatQuantity(row.normalStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="峰值库存" width="60" align="center">
            <template #default="{ row }">{{ formatQuantity(row.peakStock) }}</template>
          </ElTableColumn>
          <ElTableColumn label="系数" width="68" align="center">
            <template #default="{ row }">
              <span :title="row.strategyAvailable ? '红线 / 正常 / 峰值' : '备货系数缺省'">
                {{ formatFactors(row) }}
              </span>
            </template>
          </ElTableColumn>
        </ElTableColumn>
        </ElTable>
      </div>
    </div>

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
          <ElFormItem label="等级">
            <ElSelect v-model="addItemForm.level">
              <ElOption label="SS" value="SS" />
              <ElOption label="S" value="S" />
              <ElOption label="A" value="A" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem label="色彩">
            <ElSelect v-model="addItemForm.category">
              <ElOption label="黑白" value="黑白" />
              <ElOption label="彩色" value="彩色" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem label="备货类型">
            <ElSelect v-model="addItemForm.stockingType">
              <ElOption label="基础" value="基础" />
              <ElOption label="热销" value="热销" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem label="待计划">
            <ElInputNumber v-model="addItemForm.planned" :min="0" :controls="false" />
          </ElFormItem>
          <ElFormItem label="已安排">
            <ElInputNumber v-model="addItemForm.scheduled" :min="0" :controls="false" />
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
        填写新增计划数量，提交后将累加到主表“待计划”。推荐计划数按补至绿色状态的最低数量计算。
      </p>
      <div class="urgent-plan-table" role="table" aria-label="紧急补货计划">
        <div class="urgent-plan-header" role="row">
          <span role="columnheader">商品信息</span>
          <span role="columnheader">目前待计划</span>
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
  min-height: 100vh;
  padding: 12px;
  background: var(--industrial-page);
}

.table-scroll {
  width: 100%;
  overflow-x: auto;
}

.table-content {
  width: 1388px;
  margin: 0 auto;
}

.table-toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-bottom: 8px;
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
  width: 1388px;
  min-width: 1388px;
  flex: 0 0 1388px;
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

.inventory-table :deep(.el-table__body td.el-table__cell > .cell) {
  position: relative;
  z-index: 1;
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

.inventory-table :deep(.product-input .el-textarea__inner) {
  min-height: 34px !important;
  padding: 2px 3px;
  line-height: 15px;
  text-align: center;
  color: inherit;
  border: 1px solid var(--industrial-grid);
  background: transparent;
  box-shadow: none;
  overflow-wrap: anywhere;
  resize: none;
}

.inventory-table :deep(.product-input .el-textarea__inner:focus) {
  border-color: var(--industrial-primary);
  background: transparent;
  box-shadow: 0 0 0 1px rgba(63, 113, 141, 0.24);
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

.inventory-table :deep(.planned-cell .editable-number .el-input__inner) {
  font-weight: 700;
}

.inventory-table :deep(.urgency-cell) {
  color: #26333b;
  font-weight: 600;
}

.inventory-table :deep(td.el-table__cell.urgency-cell--red) {
  color: #fff;
  background-color: var(--industrial-urgent) !important;
}

.inventory-table :deep(td.el-table__cell.urgency-cell--purple) {
  background-color: var(--industrial-overstock) !important;
}

.inventory-table :deep(td.el-table__cell.urgency-cell--green) {
  background-color: var(--industrial-normal) !important;
}

.inventory-table :deep(td.el-table__cell.urgency-cell--yellow) {
  background-color: var(--industrial-replenish) !important;
}

.inventory-table :deep(td.el-table__cell.urgency-cell--unavailable) {
  color: var(--industrial-text);
  background-color: var(--industrial-unavailable) !important;
}
</style>
