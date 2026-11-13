import { ref, shallowRef } from 'vue'
import { ElMessage } from 'element-plus'
import { useInventoryStore } from '@/stores/inventory'
import { applySourceImport } from '@/utils/applySourceImport'

// 导入确认：分表清洗（useSplitImport）得到总表 + 销售表后，从这里打开预览并确认写入。
export function useSourceImport({ onApplied }) {
  const inventoryStore = useInventoryStore()
  const dialogVisible = ref(false)
  // 导入结果含上万条 SKU 的映射表，用 shallowRef 避免深响应式包装。
  const summary = shallowRef(null)

  function cancel() {
    dialogVisible.value = false
    summary.value = null
  }

  // 由分表清洗导入调用：清洗结果已是总表 + 销售表，直接进入同一个确认弹窗。
  function openSummary(nextSummary) {
    summary.value = nextSummary
    dialogVisible.value = true
  }

  function confirm() {
    const current = summary.value
    if (!current?.inventory || !current?.sales) {
      ElMessage.error('需要同时导入总表与销售表')
      return
    }

    const persisted = applySourceImport(inventoryStore, current)

    onApplied?.(current)
    cancel()

    // 快照压缩落库要一两秒，不阻塞弹窗关闭；失败时明确提示，避免「界面说导入成功、刷新后没了」。
    void persisted.then((snapshotId) => {
      if (!snapshotId) {
        ElMessage.error('导入的数据没能存到本机（浏览器禁用了存储或空间不足），刷新后会丢失，请先导出留底')
      }
    })
  }

  return {
    dialogVisible,
    summary,
    openSummary,
    cancel,
    confirm,
  }
}
