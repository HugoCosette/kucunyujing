import { assertSourceHeader, cellText, runCleaning } from '@/cleaning/engine'
import { streamSheetRows } from './xlsxStream'

// 浏览器侧的清洗入口：只负责“怎么把用户选的文件读成记录”，口径全部在 tools/cleaning/engine.mjs。
// 独立调试用的 Node 脚本（tools/cleaning/clean-merge.js）用的是同一个引擎，改口径只需改引擎。

export { getSplitSourceRoles } from '@/cleaning/engine'

// 读取一张分表：解析表头 → 校验列 → 按行回调，只取值需要的列。
async function readSourceRecords(file, source, fields, handle, onProgress) {
  const data = await file.arrayBuffer()
  const columnOf = new Map()

  return streamSheetRows(data, {
    sheet: source.sheet ?? 0,
    onHeader: (cells) => {
      cells.forEach((cell, index) => {
        const label = cellText(cell)
        if (label && !columnOf.has(label)) columnOf.set(label, index)
      })
      assertSourceHeader(source, [...columnOf.keys()])

      const wanted = []
      for (const field of fields) {
        if (columnOf.has(field)) wanted.push(columnOf.get(field))
      }
      return new Set(wanted)
    },
    onRow: ({ cells }) => {
      const row = {}
      let hasValue = false
      for (const field of fields) {
        const index = columnOf.get(field)
        const value = index === undefined ? null : cells[index] ?? null
        row[field] = value
        if (!hasValue && cellText(value) !== '') hasValue = true
      }
      if (hasValue) handle(row)
    },
    onProgress,
  })
}

/**
 * 执行一次分表清洗，返回总表与销售表（含表头的数据行）。
 * @param {object} options
 * @param {Record<string, File|Blob>} options.files 按数据源 label 传入的分表文件
 * @param {(progress: {percent: number, sourceId: string, sourcePercent: number, message: string}) => void} [options.onProgress]
 * @returns {Promise<{tables: Record<string, {columns: string[], rows: Array<Array>}>, stats: object}>}
 */
export function cleanSplitTables({ files, onProgress } = {}) {
  return runCleaning({
    onProgress,
    readRecords: (source, fields, handle, onProgressOfSource) => {
      const file = files?.[source.id]
      if (!file) throw new Error(`缺少「${source.label}」分表文件`)
      return readSourceRecords(file, source, fields, handle, onProgressOfSource)
    },
  })
}
