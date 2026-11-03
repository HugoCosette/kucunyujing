import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'

function findFile(root, predicate) {
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    const st = statSync(p)
    if (st.isDirectory()) { const r = findFile(p, predicate); if (r) return r }
    else if (predicate(name)) return p
  }
  return null
}

const file = findFile('.', (n) => /1000.*\.xlsx$/i.test(n))
const buf = readFileSync(file)
const files = unzipSync(new Uint8Array(buf))
const sharedXml = strFromU8(files['xl/sharedStrings.xml'] || new Uint8Array())
const sheetXml = strFromU8(files['xl/worksheets/sheet1.xml'])

const strings = []
const siRe = /<si>([\s\S]*?)<\/si>/g
let m
while ((m = siRe.exec(sharedXml)) !== null) {
  const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g
  let txt = ''
  let tm
  while ((tm = tRe.exec(m[1])) !== null) txt += tm[1]
  strings.push(txt)
}

const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g
const rows = []
let rm
while ((rm = rowRe.exec(sheetXml)) !== null) {
  const cells = {}
  const cellRegex = /<c r="([A-Z]+)(\d+)"(?:[^>]*?t="([^"]*)")?[^>]*>(?:<v>([\s\S]*?)<\/v>)?/g
  let cm
  while ((cm = cellRegex.exec(rm[2])) !== null) {
    const col = cm[1]
    const type = cm[3]
    const raw = cm[4]
    let val = raw
    if (type === 's') val = strings[Number(raw)]
    cells[col] = val
  }
  rows.push(cells)
}

for (let i = 0; i < Math.min(rows.length, 12); i++) {
  console.log(i, JSON.stringify(rows[i]))
}
