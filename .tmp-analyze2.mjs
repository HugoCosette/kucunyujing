import { readFileSync } from "node:fs"
import { unzipSync, strFromU8 } from "fflate"
function loadSheet(file, sheetIdx=0){
  const zip = unzipSync(new Uint8Array(readFileSync(file)))
  const dec=(n)=>(zip[n]?strFromU8(zip[n]):"")
  const sharedXml=dec("xl/sharedStrings.xml"); const shared=[]
  for(const si of sharedXml.split(/<si>/).slice(1)){
    const texts=[...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m=>m[1])
    shared.push(texts.join("").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"))
  }
  const wb=dec("xl/workbook.xml"), rels=dec("xl/_rels/workbook.xml.rels"); const relMap={}
  for(const m of rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) relMap[m[1]]=m[2]
  const sheets=[...wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map(m=>({name:m[1],target:(relMap[m[2]]??"").replace(/^\//,"")}))
  const s0=sheets[sheetIdx]; const p=s0.target.startsWith("xl/")?s0.target:"xl/"+s0.target
  const xml=dec(p)
  const out=[]
  for(const r of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
    const arr=[]
    for(const m of r[2].matchAll(/<c ([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)){
      const attrs=m[1]; const ref=/r="([A-Z]+)\d+"/.exec(attrs)?.[1]; const t=/t="([^"]+)"/.exec(attrs)?.[1]; const body=m[3]??""
      const v=/<v>([\s\S]*?)<\/v>/.exec(body)?.[1]??""; const inline=[...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join("")
      const val=t==="s"?shared[Number(v)]:t==="inlineStr"?inline:v
      let n=0; for(const ch of ref??"") n=n*26+(ch.charCodeAt(0)-64)
      if(n>0) arr[n-1]=val
    }
    out.push(arr)
  }
  return out
}
// 1) 产品数据表: 找一个颜色少的品名看结构
const prod=loadSheet("docs/真实数据/产品数据表1.0.xlsx")
const body=prod.slice(3)
const byName=new Map()
for(const r of body){ const name=(r[2]??"").trim(); if(!byName.has(name)) byName.set(name,[]); byName.get(name).push(r) }
const small=[...byName.entries()].filter(([n,rows])=>rows.length<=4).slice(0,3)
for(const [n,rows] of small){
  console.log("### 品名:", n, "rows:", rows.length)
  for(const r of rows) console.log("  A=",JSON.stringify(r[0]),"B=",JSON.stringify(r[1]),"C=",JSON.stringify(r[2]),"D=",JSON.stringify(r[3]),"单位=",JSON.stringify(r[8]),"系数=",JSON.stringify(r[9]),"条数=",JSON.stringify(r[10]),"库存=",JSON.stringify(r[11]))
}
console.log("品名总数:", byName.size, "总行数:", body.length)
const summaryRows=body.filter(r=>(r[1]??"").trim()!=="")
console.log("summary行数(B非空):", summaryRows.length)
console.log("summary示例:", summaryRows.slice(0,3).map(r=>[r[0],r[1],r[3],r[8],r[9]]))
