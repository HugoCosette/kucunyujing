// 生成「只换前端」的更新包：把 dist-desktop 打成 web-update.zip，
// 使用者解压覆盖到安装目录 resources/web/ 即完成更新，不重装、不丢数据。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { zipSync } from 'fflate'

const ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE = path.join(ROOT, 'dist-desktop')
const OUTPUT_DIR = path.join(ROOT, 'release')
const OUTPUT = path.join(OUTPUT_DIR, 'web-update.zip')

async function collect(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = {}
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(files, await collect(absolute, name))
    else files[name] = new Uint8Array(await readFile(absolute))
  }
  return files
}

const files = await collect(SOURCE)
const zipped = zipSync(files, { level: 9 })
await mkdir(OUTPUT_DIR, { recursive: true })
await writeFile(OUTPUT, zipped)

const sizeMb = zipped.byteLength / 1024 / 1024
console.log(`已生成 ${path.relative(ROOT, OUTPUT)}（${Object.keys(files).length} 个文件，${sizeMb.toFixed(2)} MB）`)
console.log('用法：关闭程序 → 解压覆盖到 <安装目录>\\resources\\web\\ → 重新打开')
