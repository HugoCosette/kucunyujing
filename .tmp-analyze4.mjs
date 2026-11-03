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

const header = rows[0]
const colMap = {}
for (const [col, val] of Object.entries(header)) colMap[val] = col
const producingCol = colMap['生产中']
const weeklyCol = colMap['周消耗']

const prodVals = []
const weekVals = []
for (let i = 1; i < rows.length; i++) {
  const r = rows[i]
  if (r[producingCol] === undefined && r[weeklyCol] === undefined) continue
  const p = Number(r[producingCol] ?? 0)
  const w = Number(r[weeklyCol] ?? 0)
  if (Number.isFinite(p)) prodVals.push(p)
  if (Number.isFinite(w)) weekVals.push(w)
}
console.log('n', prodVals.length)
const q = (arr, p) => { const s=[...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p*(s.length-1)))] }
console.log('producing min/p25/p50/p75/max', Math.min(...prodVals), q(prodVals,.25), q(prodVals,.5), q(prodVals,.75), Math.max(...prodVals))
console.log('weeklyUsage min/p25/p50/p75/max', Math.min(...weekVals), q(weekVals,.25), q(weekVals,.5), q(weekVals,.75), Math.max(...weekVals))
for (const [p,w] of [[500,700],[1000,500],[1500,800],[2000,1000],[1000,1000],[1500,1000],[2000,1500]]) {
  const hit = prodVals.filter((_,i)=>prodVals[i]>=p && weekVals[i]>=w).length
  console.log(`p>=${p} w>=${w}: ${hit} hot / ${prodVals.length-hit} regular`)
}
