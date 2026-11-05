import { runSplitTableImport } from '@/utils/splitTableImport'

// 分表清洗放在 Worker 里：出入库明细解压后近 150MB，主线程解析会把页面卡住。
self.onmessage = async (event) => {
  const { files } = event.data ?? {}
  try {
    const summary = await runSplitTableImport(files ?? {}, {
      onProgress: (progress) => self.postMessage({ type: 'progress', ...progress }),
    })
    self.postMessage({ type: 'done', summary })
  } catch (error) {
    console.error('Failed to clean split tables', error)
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : '分表清洗失败',
    })
  }
}
