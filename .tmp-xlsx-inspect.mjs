import { readFileSync } from "node:fs"
import { unzipSync, strFromU8 } from "fflate"
const file = process.argv[2]
const limit = Number(process.argv[3] ?? 6)
const zip = unzipSync(new Uint8Array(readFileSync(file)))
const dec = (n) => (zip[n] ? strFromU8(zip[n]) : "")
const sharedXml = dec("xl/sharedStrings.xml")
const shared = []
for (const si of sharedXml.split(/<si>/).slice(1)) {
  const texts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1])
  shared.push(texts.join("").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"))
}
const wb = dec("xl/workbook.xml")
const rels = dec("xl/_rels/workbook.xml.rels")
const relMap = {}
for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]] = m[2]
const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: m[1], target: (relMap[m[2]] ?? "").replace(/^\//,"") }))
console.log("FILE:", file)
console.log("SHEETS:", sheets.map((s) => s.name).join(" | "))
for (const sheet of sheets) {
  const p = sheet.target.startsWith("xl/") ? sheet.target : "xl/" + sheet.target
  const xml = dec(p)
  const dim = /<dimension ref="([^"]+)"/.exec(xml)?.[1]
  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]).slice(0, 20)
  console.log(`\n=== ${sheet.name} dim=${dim} merges=${merges.join(",")} ===`)
  const rows = [...xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].slice(0, limit)
  for (const r of rows) {
    const cells = [...r[2].matchAll(/<c ([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)].map((m) => {
      const attrs = m[1]
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const t = /t="([^"]+)"/.exec(attrs)?.[1]
      const body = m[3] ?? ""
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ""
      const inline = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")
      const val = t === "s" ? shared[Number(v)] : t === "inlineStr" ? inline : v
      return `${ref}=${JSON.stringify(val ?? "")}`
    })
    console.log(`r${r[1]}: ${cells.join("  ")}`)
  }
}
