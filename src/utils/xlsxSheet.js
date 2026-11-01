import { strFromU8, unzipSync } from 'fflate'

// 只解压读取表头与数据需要的部件，跳过样式、图片等大文件，降低导入开销。
const META_PARTS = new Set([
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
])

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new TypeError('不支持的 Excel 文件内容')
}

function decodeXml(value) {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g,
    (entity, code) => {
      if (code === 'lt') return '<'
      if (code === 'gt') return '>'
      if (code === 'quot') return '"'
      if (code === 'apos') return "'"
      if (code === 'amp') return '&'

      const number =
        code[1] === 'x'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10)
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity
    },
  )
}

function columnNameToIndex(name) {
  let index = 0
  for (const char of name.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return index - 1
}

function parseSharedStrings(xml) {
  if (!xml) return []

  const strings = []
  const entryRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let entryMatch
  while ((entryMatch = entryRegex.exec(xml))) {
    const texts = []
    const textRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let textMatch
    while ((textMatch = textRegex.exec(entryMatch[1]))) texts.push(textMatch[1])
    strings.push(decodeXml(texts.join('')))
  }
  return strings
}

function resolveFirstSheet(workbookXml, relationshipsXml) {
  const sheetTag = /<sheet\b[^>]*>/.exec(workbookXml)?.[0] ?? ''
  const sheetName = decodeXml(/\bname="([^"]*)"/.exec(sheetTag)?.[1] ?? '')
  const relationshipId = /\br:id="([^"]*)"/.exec(sheetTag)?.[1]

  let target = ''
  if (relationshipId) {
    const relationshipRegex = /<Relationship\b[^>]*>/g
    let relationshipMatch
    while ((relationshipMatch = relationshipRegex.exec(relationshipsXml))) {
      if (/\bId="([^"]*)"/.exec(relationshipMatch[0])?.[1] !== relationshipId) continue
      target = /\bTarget="([^"]*)"/.exec(relationshipMatch[0])?.[1] ?? ''
      break
    }
  }

  const normalized = target.replace(/^\/+/, '')
  const path = normalized.startsWith('xl/')
    ? normalized
    : `xl/${normalized || 'worksheets/sheet1.xml'}`
  return { sheetName, path }
}

function readCellValue(body, type, sharedStrings) {
  if (!body) return ''

  if (type === 's') {
    const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])
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

  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (raw === undefined) return ''

  const text = decodeXml(raw)
  if (type === 'str' || type === 'b') return text

  const number = Number(text)
  return text.trim() !== '' && Number.isFinite(number) ? number : text
}

function parseSheetRows(sheetXml, sharedStrings) {
  const rows = []
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rowMatch

  while ((rowMatch = rowRegex.exec(sheetXml))) {
    const rowNumber =
      Number(/\br="(\d+)"/.exec(rowMatch[0])?.[1]) || rows.length + 1
    const cells = []
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch

    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attributes = cellMatch[1]
      const reference = /\br="([A-Za-z]+)\d+"/.exec(attributes)?.[1]
      const columnIndex = reference
        ? columnNameToIndex(reference)
        : cells.length
      cells[columnIndex] = readCellValue(
        cellMatch[2] ?? '',
        /\bt="([^"]*)"/.exec(attributes)?.[1],
        sharedStrings,
      )
    }

    rows.push({
      rowNumber,
      cells: Array.from(cells, (cell) => (cell === undefined ? '' : cell)),
    })
  }

  return rows
}

// 读取工作簿中第一张工作表的单元格文本，返回按单元格序号对齐的行数据。
export function readWorkbookRows(data) {
  const bytes = toBytes(data)

  let metaParts
  try {
    metaParts = unzipSync(bytes, { filter: (file) => META_PARTS.has(file.name) })
  } catch {
    throw new Error('无法解析文件，请确认为 .xlsx 格式的 Excel 文件')
  }

  const workbookXml = metaParts['xl/workbook.xml']
    ? strFromU8(metaParts['xl/workbook.xml'])
    : ''
  if (!workbookXml) throw new Error('Excel 缺少工作簿信息，无法读取')

  const relationshipsXml = metaParts['xl/_rels/workbook.xml.rels']
    ? strFromU8(metaParts['xl/_rels/workbook.xml.rels'])
    : ''
  const { sheetName, path } = resolveFirstSheet(workbookXml, relationshipsXml)

  const sheetParts = unzipSync(bytes, { filter: (file) => file.name === path })
  const sheetBytes = sheetParts[path]
  if (!sheetBytes) throw new Error(`未找到工作表：${sheetName || path}`)

  const sharedStrings = parseSharedStrings(
    metaParts['xl/sharedStrings.xml']
      ? strFromU8(metaParts['xl/sharedStrings.xml'])
      : '',
  )

  return {
    sheetName: sheetName || 'Sheet1',
    rows: parseSheetRows(strFromU8(sheetBytes), sharedStrings),
  }
}
