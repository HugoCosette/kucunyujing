import { cleanSplitTables, getSplitSourceRoles } from './cleanMerge'
import { CLEANING_CACHE_ROLE_IDS } from './cleaningCache'
import { analyzeSourceSheet, describeMissingColumns } from './sourceImport'
import { parseInventorySheet } from './inventoryImport'
import { attachSalesToInventory, parseSalesSheet } from './salesImport'

// 需要用户提供的分表：产品资料（基准表）与出码率可由 tools/cleaning/cache/ 缓存兜底，
// 其余 4 张（出入库明细 / 库存结存表 / 欠货 / 生产排单）每次必选。
export const SPLIT_TABLE_ROLES = getSplitSourceRoles().map((role) => ({
  ...role,
  cached: CLEANING_CACHE_ROLE_IDS.includes(role.id),
}))

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
    missing: SPLIT_TABLE_ROLES.filter((role) => !role.cached && !assigned[role.id]),
  }
}

// 清洗结果（表头 + 数据行）转成导入流程使用的行结构，直接复用已有解析器。
function toSheetRows(columns, rows) {
  return [
    { rowNumber: 1, cells: columns },
    ...rows.map((cells, index) => ({ rowNumber: index + 2, cells })),
  ]
}

// 从清洗出的总表反推缓存：产品资料取「能换算成公斤」的 SKU 全集，出码率按品名去重。
// 总表是清洗的产物，直接用它保证缓存与清洗口径完全一致。
function buildCacheFromTotalTable(table) {
  const header = table.columns
  const at = (name) => header.indexOf(name)
  const iProduct = at('品名')
  const iColor = at('颜色')
  const iTree = at('树形分类')
  const iRate = at('出码率')
  const iFactor = at('公斤系数')

  const productMaster = []
  const rates = new Map()
  for (const row of table.rows) {
    const product = String(row[iProduct] ?? '').trim()
    const color = String(row[iColor] ?? '').trim()
    const rate = Number(row[iRate]) || 0
    const factor = row[iFactor]
    if (!product || !color) continue
    if (factor === '' || factor === null || factor === undefined) continue
    if (rate > 0 && !rates.has(product)) rates.set(product, rate)
    productMaster.push({
      品名: product,
      颜色: color,
      单位: rate > 0 ? '码' : '公斤',
      树形分类: String(row[iTree] ?? '').trim(),
    })
  }

  return {
    rates: [...rates.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
      .map(([品名, 出码率]) => ({ 品名, 出码率 })),
    productMaster,
  }
}

// 开发态：这次导入选了产品资料 / 出码率，就把结果写回 tools/cleaning/cache/*.json。
// 生产构建的资源是只读的，客户端不改缓存（更新走重新部署或后端接口）。
async function persistCleaningCacheDev(files, tables) {
  if (!import.meta.env.DEV) return
  if (!files?.['产品资料'] && !files?.rates) return
  try {
    const payload = {
      ...buildCacheFromTotalTable(tables.总表),
      updatedAt: new Date().toISOString().slice(0, 10),
    }
    await fetch('/__cleaning-cache/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    // 缓存写回失败不影响本次导入，只在控制台留痕
    console.warn('清洗缓存写回失败', error)
  }
}

/**
 * 分表 → 清洗出总表与销售表 → 走现有导入流程解析成可写回主面板的数据。
 * @param {Record<string, File>} files 按分表 label 传入的文件（产品资料 / 出码率可缺省，缺省走缓存）
 * @param {{onProgress?: (progress: {percent: number, message: string}) => void}} [options]
 */
export async function runSplitTableImport(files, { onProgress } = {}) {
  const { tables } = await cleanSplitTables({ files, onProgress })
  await persistCleaningCacheDev(files, tables)

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
