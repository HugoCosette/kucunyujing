// 32 位 FNV-1a：只用来判断「导入的是不是同一份数据」，不做安全用途。
// 快照体积大，哈希在 Worker 里一起算，不阻塞主线程。
export function hashText(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
