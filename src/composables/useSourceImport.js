import { ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import { useInventoryStore } from '@/stores/inventory'
import { applyImportedInventory } from '@/utils/inventoryApply'
import { parseInventorySheet } from '@/utils/inventoryImport'
import { attachSalesToInventory, parseSalesSheet } from '@/utils/salesImport'
import { analyzeSourceSheet, describeMissingColumns } from '@/utils/sourceImport'
import { readWorkbookRows } from '@/utils/xlsxSheet'

const MAX_FILE_SIZE = 50 * 1024 * 1024

// 唯一导入流程：总表与销售表必须同时选中，两个文件都按“唯一标识”关联到同一个 SKU。
export function useSourceImport({ panelKey, onApplied }) {
  const inventoryStore = useInventoryStore(panelKey)
  const fileInputRef = ref(null)
  const dialogVisible = ref(false)
  // 导入结果含上万条 SKU 的映射表，用 shallowRef 避免深响应式包装。
  const summary = shallowRef(null)

  function trigger() {
    const input = fileInputRef.value
    if (!input) return
    input.value = ''
    input.click()
  }

  async function handleFilesChange(event) {
    const input = event.target
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length) return

    const problems = []
    let inventory = null
    let sales = null

    for (const file of files) {
      if (!/\.xlsx$/i.test(file.name)) {
        problems.push({ fileName: file.name, message: '仅支持 .xlsx 格式的 Excel 文件' })
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        problems.push({ fileName: file.name, message: '文件超过 50MB，请拆分后再导入' })
        continue
      }

      try {
        const { sheetName, rows } = readWorkbookRows(await file.arrayBuffer())
        const roles = analyzeSourceSheet(rows)
        const problem = describeMissingColumns(roles)
        if (problem) {
          problems.push({ fileName: file.name, message: problem })
          continue
        }

        if (roles.hasInventoryColumns) {
          if (inventory) {
            problems.push({ fileName: file.name, message: '已选择过总表，本文件的总表数据未导入' })
          } else {
            inventory = { fileName: file.name, sheetName, ...parseInventorySheet(rows) }
          }
        }
        if (roles.hasSalesColumns) {
          if (sales) {
            problems.push({ fileName: file.name, message: '已选择过销售表，本文件的销售数据未导入' })
          } else {
            sales = { fileName: file.name, sheetName, ...parseSalesSheet(rows) }
          }
        }
      } catch (error) {
        console.error('Failed to read source workbook', file.name, error)
        problems.push({
          fileName: file.name,
          message: error instanceof Error ? error.message : '未知错误',
        })
      }
    }

    if (!inventory) {
      problems.push({ fileName: '总表', message: '必须同时导入总表（含库存列）' })
    }
    if (!sales) {
      problems.push({ fileName: '销售表', message: '必须同时导入销售表（含动销指标或月份列）' })
    }

    if (!inventory && !sales) {
      ElMessage.error(problems[problems.length - 1]?.message ?? '未识别到可导入的表格')
      return
    }

    if (inventory && sales) {
      sales = { ...sales, merge: attachSalesToInventory(sales.rows, inventory.items) }
    }

    summary.value = { inventory, sales, problems }
    dialogVisible.value = true
  }

  function cancel() {
    dialogVisible.value = false
    summary.value = null
  }

  function confirm() {
    const current = summary.value
    if (!current?.inventory || !current?.sales) {
      ElMessage.error('需要同时导入总表与销售表')
      return
    }

    const { inventory, sales } = current
    applyImportedInventory(inventoryStore, inventory.items, {
      salesBySku: sales.merge.bySku,
    })
    inventoryStore.salesSheet = {
      fileName: sales.fileName,
      sheetName: sales.sheetName,
      months: sales.months,
      metricFields: sales.metricFields,
      bySku: sales.merge.bySku,
    }

    onApplied?.(current)
    cancel()
  }

  return { fileInputRef, dialogVisible, summary, trigger, handleFilesChange, cancel, confirm }
}
