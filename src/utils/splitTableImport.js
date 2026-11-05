import { cleanSplitTables, getSplitSourceRoles } from './cleanMerge'
import { analyzeSourceSheet, describeMissingColumns } from './sourceImport'
import { parseInventorySheet } from './inventoryImport'
import { attachSalesToInventory, parseSalesSheet } from './salesImport'

// 需要用户提供的 5 张分表：产品资料为基准表，其余按唯一标识并入。
export const SPLIT_TABLE_ROLES = getSplitSourceRoles()

export const SPLIT_CLEANED_FILES = {
  total: '总表_清洗结果.xlsx',
  sales: '销售表.xlsx',
}

// 按文件名关键字（产品资料 / 出入库明细 / 库存结存表 / 欠货 / Scheduling）自动认领文件。
export function matchSplitTableFiles(fileList) {
  const files = Array.from(fileList ?? [])
  const assigned = {}
  const unmatched = []

  for (const file of files) {
    const name = String(file.name ?? '').toLowerCase()
    const role = SPLIT_TABLE_ROLES.find(
      (entry) =>
        !assigned[entry.id] && entry.keywords.every((keyword) => name.includes(keyword.toLowerCase())),
    )
    if (!role) {
      unmatched.push(file)
      continue
    }
    assigned[role.id] = file
  }

  return {
    assigned,
    unmatched,
    missing: SPLIT_TABLE_ROLES.filter((role) => !assigned[role.id]),
  }
}

// 清洗结果（表头 + 数据行）转成导入流程使用的行结构，直接复用已有解析器。
function toSheetRows(columns, rows) {
  return [
    { rowNumber: 1, cells: columns },
    ...rows.map((cells, index) => ({ rowNumber: index + 2, cells })),
  ]
}

/**
 * 五张分表 → 清洗出总表与销售表 → 走现有导入流程解析成可写回主面板的数据。
 * @param {Record<string, File>} files 按分表 label 传入的文件
 * @param {{onProgress?: (progress: {percent: number, message: string}) => void}} [options]
 */
export async function runSplitTableImport(files, { onProgress } = {}) {
  const { tables } = await cleanSplitTables({ files, onProgress })

  const totalRows = toSheetRows(tables.总表.columns, tables.总表.rows)
  const salesRows = toSheetRows(tables.销售表.columns, tables.销售表.rows)

  const totalProblem = describeMissingColumns(analyzeSourceSheet(totalRows))
  if (totalProblem) throw new Error(`清洗出的总表无法导入：${totalProblem}`)
  const salesProblem = describeMissingColumns(analyzeSourceSheet(salesRows))
  if (salesProblem) throw new Error(`清洗出的销售表无法导入：${salesProblem}`)

  const inventory = {
    fileName: SPLIT_CLEANED_FILES.total,
    sheetName: '总表',
    ...parseInventorySheet(totalRows),
  }
  const parsedSales = {
    fileName: SPLIT_CLEANED_FILES.sales,
    sheetName: '销售表',
    ...parseSalesSheet(salesRows),
  }
  const sales = {
    ...parsedSales,
    merge: attachSalesToInventory(parsedSales.rows, inventory.items),
  }

  onProgress?.({ percent: 100, sourceId: '', sourcePercent: 100, message: '清洗完成' })

  return {
    inventory,
    sales,
    problems: [],
    // 标记来源，确认弹窗据此提示“由分表清洗得到”
    cleaned: true,
    sourceFiles: SPLIT_TABLE_ROLES.map((role) => ({
      label: role.label,
      fileName: files[role.id]?.name ?? '',
    })),
  }
}
