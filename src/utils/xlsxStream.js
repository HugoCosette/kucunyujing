import { unzipSync } from 'fflate'
import { columnNameToIndex, decodeXml, readWorkbookMeta } from './xlsxShared'

// 分段解码的块大小：出入库明细解压后近 150MB，一次性转字符串会占用数倍内存。
const CHUNK_SIZE = 4 * 1024 * 1024

// 值节点可能带属性（写入含换行的文本时会出现 <v xml:space="preserve">），标签必须宽松匹配。
const VALUE_PATTERN = /<v\b[^>]*>([\s\S]*?)<\/v>/

function readCellValue(body, type, sharedStrings) {
  if (!body) return ''

  if (type === 's') {
    const index = Number(VALUE_PATTERN.exec(body)?.[1])
    return Number.isFinite(index) ? sharedStrings[index] ?? '' : ''
  }

  if (type === 'inlineStr') {
    const texts = []
    const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let textMatch
    while ((textMatch = textRegex.exec(body))) texts.push(textMatch[1])
    return decodeXml(texts.join(''))
  }

  if (type === 'e') return ''

  const raw = VALUE_PATTERN.exec(body)?.[1]
  if (raw === undefined) return ''

  const text = decodeXml(raw)
  if (type === 'str' || type === 'b') return text

  const number = Number(text)
  return text.trim() !== '' && Number.isFinite(number) ? number : text
}

// 解析一行的单元格；wanted 提供时只取值需要的列，其余列留空，减少大表解析开销。
function parseRow(xml, sharedStrings, wanted, fallbackRowNumber) {
  const rowNumber = Number(/\br="(\d+)"/.exec(xml)?.[1]) || fallbackRowNumber
  const cells = []
  const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
  let cellMatch

  while ((cellMatch = cellRegex.exec(xml))) {
    const attributes = cellMatch[1]
    const reference = /\br="([A-Za-z]+)\d+"/.exec(attributes)?.[1]
    const columnIndex = reference ? columnNameToIndex(reference) : cells.length
    if (wanted && !wanted.has(columnIndex)) continue
    cells[columnIndex] = readCellValue(
      cellMatch[2] ?? '',
      /\bt="([^"]*)"/.exec(attributes)?.[1],
      sharedStrings,
    )
  }

  return {
    rowNumber,
    cells: Array.from(cells, (cell) => (cell === undefined ? '' : cell)),
  }
}

/**
 * 逐行读取工作簿中指定工作表的行，不把整张表拼成一个巨大字符串。
 * @param {Uint8Array|ArrayBuffer} data 工作簿内容
 * @param {object} [options]
 * @param {number|string} [options.sheet] 工作表下标或名称，默认第一张
 * @param {(row: {rowNumber: number, cells: Array}) => void} [options.onRow] 数据行回调
 * @param {(cells: Array) => (Set<number>|null)} [options.onHeader] 表头行回调；返回值 {Set} 时只保留这些列
 * @param {(ratio: number) => void} [options.onProgress] 解析进度（0-1）
 * @returns {{sheetName: string, rowCount: number}}
 */
export function streamSheetRows(data, { sheet = 0, onRow, onHeader, onProgress } = {}) {
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
    throw new TypeError('不支持的 Excel 文件内容')
  }
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const { sheets, sharedStrings } = readWorkbookMeta(bytes)

  const target =
    typeof sheet === 'number'
      ? sheets[sheet]
      : sheets.find((entry) => entry.name === sheet) ?? null
  if (!target) throw new Error(`未找到工作表：${sheet}`)

  const sheetBytes = unzipSync(bytes, { filter: (file) => file.name === target.path })[
    target.path
  ]
  if (!sheetBytes) throw new Error(`未找到工作表：${target.name || target.path}`)

  let wanted = null
  let headerHandled = !onHeader
  let rowCount = 0
  let pending = ''
  const decoder = new TextDecoder()

  const handleRowXml = (xml) => {
    const row = parseRow(xml, sharedStrings, wanted, rowCount + 1)
    if (!headerHandled) {
      headerHandled = true
      wanted = onHeader(row.cells) ?? null
      return
    }
    rowCount += 1
    onRow?.(row)
  }

  const drainPending = (flush) => {
    let cursor = 0
    for (;;) {
      const start = pending.indexOf('<row', cursor)
      if (start < 0) break

      const openEnd = pending.indexOf('>', start)
      if (openEnd < 0) break // 标签还没读完整，等下一块
      if (pending[openEnd - 1] === '/') {
        handleRowXml(pending.slice(start, openEnd + 1))
        cursor = openEnd + 1
        continue
      }

      const close = pending.indexOf('</row>', openEnd)
      if (close < 0) break // 这一行还没读完，等下一块
      handleRowXml(pending.slice(start, close + 6))
      cursor = close + 6
    }
    pending = pending.slice(cursor)
  }

  const total = sheetBytes.length
  for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, total)
    pending += decoder.decode(sheetBytes.subarray(offset, end), { stream: true })
    drainPending(false)
    onProgress?.(end / total)
  }
  pending += decoder.decode()
  drainPending(true)

  return { sheetName: target.name || target.path, rowCount }
}

// 读取工作簿中指定工作表的单元格文本，返回按单元格序号对齐的行数据。
export function readWorkbookRows(data, sheet = 0) {
  const rows = []
  const { sheetName } = streamSheetRows(data, { sheet, onRow: (row) => rows.push(row) })
  return { sheetName, rows }
}
