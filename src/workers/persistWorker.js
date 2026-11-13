import { gzipSync, strToU8 } from 'fflate'
import { hashText } from '../data/textHash.js'

// 快照压缩放在 Worker 里：3 万行总表 + 销售表约 40 MB JSON，
// gzip 要一两秒，放主线程会把「导入成功」的提示卡住。
self.onmessage = (event) => {
  const { id, text } = event.data ?? {}
  try {
    const hash = hashText(text)
    const bytes = gzipSync(strToU8(text), { level: 6 })
    self.postMessage({ id, ok: true, hash, buffer: bytes.buffer }, [bytes.buffer])
  } catch (error) {
    self.postMessage({ id, ok: false, message: String(error?.message ?? error) })
  }
}
