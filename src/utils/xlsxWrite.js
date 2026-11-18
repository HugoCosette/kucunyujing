// 极简 xlsx 写盘：不引第三方库，直接拼 OOXML 再用 fflate 打包。
// 只做「多张工作表 + 表头加粗」这一档，够历史 / 对账这类只读导出用。
// 主面板的采购清单导出仍在自己拼（口径与列宽已定稿），新页面统一走这里。
import { zipSync } from 'fflate'

const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
const WORKBOOK_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function columnName(index) {
  let name = ''
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

function cellXml(value, reference, styleIndex) {
  const style = styleIndex > 0 ? ` s="${styleIndex}"` : ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`
  }
  return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value ?? '')}</t></is></c>`
}

function sheetXml(sheet) {
  const rows = Array.isArray(sheet.rows) ? sheet.rows : []
  if (!rows.length) return null

  const sheetData = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => cellXml(value, `${columnName(columnIndex)}${rowIndex + 1}`, rowIndex === 0 ? 1 : 0))
        .join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')

  const widths = Array.isArray(sheet.widths) ? sheet.widths : []
  const cols = widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('')

  const lastColumn = columnName(Math.max(...rows.map((row) => row.length), 1) - 1)
  // 首行冻结 + 自动筛选：历史表交给业务自己再筛一遍。
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetData}</sheetData><autoFilter ref="A1:${lastColumn}${rows.length}"/></worksheet>`
}

const STYLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FF2F3B43"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F6F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/**
 * sheets: [{ name, rows, widths }]，rows 的每行是单元格数组，第一行当表头。
 * 返回 xlsx 字节，交给 saveWorkbook 落地。
 */
export function buildWorkbook(sheets) {
  const usable = []
  for (const sheet of sheets ?? []) {
    const xml = sheetXml(sheet)
    if (!xml) continue
    // Excel 工作表名上限 31 字符，且不允许 : \ / ? * [ ]
    const name = String(sheet.name ?? `Sheet${usable.length + 1}`)
      .replace(/[:\\/?*[\]]/g, '-')
      .slice(0, 31)
    usable.push({ name: name || `Sheet${usable.length + 1}`, xml })
  }
  if (!usable.length) throw new Error('没有可导出的数据')

  const sheetEntries = usable
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  const sheetOverrides = usable
    .map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${SHEET_TYPE}"/>`)
    .join('')
  const sheetRels = usable
    .map(
      (sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('')
  const styleRelId = usable.length + 1

  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_TYPE}"/>${sheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${styleRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLE_XML,
  }
  usable.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = sheet.xml
  })

  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, new TextEncoder().encode(content)]),
    ),
    { level: 6 },
  )
}

export function saveWorkbook(sheets, fileName) {
  const bytes = buildWorkbook(sheets)
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
