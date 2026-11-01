import { readFileSync } from "node:fs"
import { unzipSync, strFromU8 } from "fflate"
function load(file){
  const zip = unzipSync(new Uint8Array(readFileSync(file)))
  const dec = (n) => (zip[n] ? strFromU8(zip[n]) : "")
  const sharedXml = dec("xl/sharedStrings.xml"); const shared=[]
  for (const si of sharedXml.split(/<si>/).slice(1)) {
    const texts=[...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m=>m[1])
    shared.push(texts.join("").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"))
  }
  const wb=dec("xl/workbook.xml"), rels=dec("xl/_rels/workbook.xml.rels"); const relMap={}
  for(const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]]=m[2]
  const sheets=[...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(m=>({name:m[1],target:(relMap[m[2]]??"").replace(/^\//,"")}))
  const s0=sheets[0]; const p=s0.target.startsWith("xl/")?s0.target:"xl/"+s0.target
  const xml=dec(p)
  const rows=[...xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)]
  const parsed=rows.map(r=>{
    const arr=[]
    for(const m of r[2].matchAll(/<c ([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)){
      const attrs=m[1]; const ref=/r="([A-Z]+)\d+"/.exec(attrs)?.[1]; const t=/t="([^"]+)"/.exec(attrs)?.[1]; const body=m[3]??""
      const v=/<v>([\s\S]*?)<\/v>/.exec(body)?.[1]??""; const inline=[...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join("")
      const val=t==="s"?shared[Number(v)]:t==="inlineStr"?inline:v
      let n=0; for(const ch of ref??"") n=n*26+(ch.charCodeAt(0)-64)
      if(n>0) arr[n-1]=val
    }
    return arr
  })
  return { sheetNames: sheets.map(s=>s.name), parsed }
}
const prod = load("docs/真实数据/产品数据表1.0.xlsx")
const data = prod.parsed
console.log("产品数据表 rows:", data.length, "sheets:", prod.sheetNames.join(","))
const header = data.slice(0,3)
const body = data.slice(3)
const units = new Map(), trees = new Map()
let groupRows=0, childRows=0, coeffBad=0, emptySku=0, dup=new Map()
for(const r of body){
  const a=(r[0]??"").trim(), b=(r[1]??"").trim(), c=(r[2]??"").trim(), d=(r[3]??"").trim()
  const unit=(r[8]??"").trim(); units.set(unit,(units.get(unit)??0)+1)
  trees.set((r[4]??"").trim(),1)
  if(a && !b) groupRows++
  if(!a) childRows++
  if(!c && !d) emptySku++
  const tiao=Number(r[10]), qty=Number(r[11]), k=Number(r[9])
  if(Number.isFinite(tiao)&&Number.isFinite(qty)&&Number.isFinite(k)&&Math.abs(tiao*k-qty)>0.01) coeffBad++
  const key=c+"|"+d; dup.set(key,(dup.get(key)??0)+1)
}
console.log("body rows:", body.length, "groupRows(A有B空):", groupRows, "A空行:", childRows, "无品名颜色行:", emptySku)
console.log("单位分布:", [...units.entries()].sort((x,y)=>y[1]-x[1]).slice(0,10))
console.log("树形分类数:", trees.size)
console.log("数量!=条数*系数 行数:", coeffBad)
const dupKeys=[...dup.entries()].filter(([,n])=>n>1)
console.log("重复 品名+颜色 键数:", dupKeys.length, "示例:", dupKeys.slice(0,5))
