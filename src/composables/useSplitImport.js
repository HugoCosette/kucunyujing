import { computed, onBeforeUnmount, reactive, ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import { SPLIT_TABLE_ROLES, matchSplitTableFiles } from '@/utils/splitTableImport'

// 导入分表：先选 5 张分表做清洗（得到总表 + 销售表），再走已有的导入流程确认写入。
// sourceImport 由主面板传入同一个实例，清洗结果直接进它的预览弹窗与确认逻辑。
export function useSplitImport({ sourceImport }) {
  const dialogVisible = ref(false)
  const pickedFiles = shallowRef([])
  // rows 记录每张分表自己的清洗进度（0-100），用于对话列表里的逐行进度条
  const progress = reactive({ running: false, percent: 0, message: '', activeId: '', rows: {} })
  let worker = null

  const matching = computed(() => matchSplitTableFiles(pickedFiles.value))
  const roles = computed(() =>
    SPLIT_TABLE_ROLES.map((role) => ({
      ...role,
      fileName: matching.value.assigned[role.id]?.name ?? '',
    })),
  )

  function resetProgress() {
    progress.percent = 0
    progress.message = ''
    progress.activeId = ''
    progress.rows = {}
  }

  function open() {
    if (progress.running) return
    resetProgress()
    dialogVisible.value = true
  }

  function cancel() {
    if (progress.running) return
    dialogVisible.value = false
    pickedFiles.value = []
    resetProgress()
  }

  function select(files) {
    if (progress.running) return
    pickedFiles.value = Array.from(files ?? []).filter((file) => /\.xlsx$/i.test(file.name))
    resetProgress()
  }

  function clear() {
    if (progress.running) return
    pickedFiles.value = []
  }

  function disposeWorker() {
    worker?.terminate()
    worker = null
  }

  // 切换页面或面板时释放 Worker，避免大文件解析还在后台跑。
  onBeforeUnmount(disposeWorker)

  function finish() {
    disposeWorker()
    progress.running = false
  }

  function start() {
    if (progress.running) return

    const { assigned, missing, unmatched } = matching.value
    if (missing.length) {
      ElMessage.error(`还需要选择：${missing.map((role) => role.label).join('、')}`)
      return
    }
    if (unmatched.length) {
      ElMessage.error(`无法识别的文件：${unmatched.map((file) => file.name).join('、')}`)
      return
    }

    progress.running = true
    resetProgress()
    progress.message = '准备清洗…'

    worker = new Worker(new URL('../workers/cleanMergeWorker.js', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event) => {
      const data = event.data ?? {}
      if (data.type === 'progress') {
        progress.percent = data.percent ?? 0
        progress.message = data.message ?? ''
        if (data.sourceId) {
          progress.activeId = data.sourceId
          progress.rows[data.sourceId] = data.sourcePercent ?? 0
        }
        return
      }
      if (data.type === 'error') {
        finish()
        ElMessage.error(`分表清洗失败：${data.message}`)
        return
      }
      if (data.type === 'done') {
        finish()
        dialogVisible.value = false
        sourceImport.openSummary(data.summary)
      }
    }
    worker.onerror = (event) => {
      finish()
      ElMessage.error(`分表清洗失败：${event.message || '未知错误'}`)
    }
    worker.postMessage({ files: assigned })
  }

  return {
    dialogVisible,
    roles,
    matching,
    progress,
    open,
    cancel,
    select,
    clear,
    start,
  }
}
