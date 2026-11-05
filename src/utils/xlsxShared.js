import { strFromU8, unzipSync } from 'fflate'

// 只解压读取表头与数据需要的部件，跳过样式、图片等大文件，降低导入开销。
export const META_PARTS = new Set([
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/sharedStrings.xml',
])

export function decodeXml(value) {
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

export function columnNameToIndex(name) {
  let index = 0
  for (const char of name.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return index - 1
}

export function parseSharedStrings(xml) {
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

// 关系表里的 Target 有的带 /xl 前缀、有的是相对路径，统一成 zip 内的绝对路径。
function normalizeTarget(target) {
  const normalized = String(target ?? '').replace(/^\/+/, '')
  return normalized.startsWith('xl/')
    ? normalized
    : `xl/${normalized || 'worksheets/sheet1.xml'}`
}

// 解析工作簿里的全部工作表（名称 + zip 内路径），供按名称或下标选表。
function resolveSheets(workbookXml, relationshipsXml) {
  const targets = new Map()
  const relationshipRegex = /<Relationship\b[^>]*>/g
  let relationshipMatch
  while ((relationshipMatch = relationshipRegex.exec(relationshipsXml ?? ''))) {
    const id = /\bId="([^"]*)"/.exec(relationshipMatch[0])?.[1]
    const target = /\bTarget="([^"]*)"/.exec(relationshipMatch[0])?.[1]
    if (id && target) targets.set(id, normalizeTarget(target))
  }

  const sheets = []
  const sheetRegex = /<sheet\b[^>]*>/g
  let sheetMatch
  while ((sheetMatch = sheetRegex.exec(workbookXml))) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(sheetMatch[0])?.[1] ?? '')
    const relationshipId = /\br:id="([^"]*)"/.exec(sheetMatch[0])?.[1]
    sheets.push({ name, path: targets.get(relationshipId) ?? 'xl/worksheets/sheet1.xml' })
  }
  return sheets
}

// 读取工作簿元信息：全部工作表 + 共享字符串。
export function readWorkbookMeta(bytes) {
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
  const sharedStrings = parseSharedStrings(
    metaParts['xl/sharedStrings.xml']
      ? strFromU8(metaParts['xl/sharedStrings.xml'])
      : '',
  )

  return { sheets: resolveSheets(workbookXml, relationshipsXml), sharedStrings }
}
