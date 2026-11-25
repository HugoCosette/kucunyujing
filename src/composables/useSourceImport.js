import { ElMessage } from 'element-plus'
import { useInventoryStore } from '@/stores/inventory'
import { applySourceImport } from '@/utils/applySourceImport'

// 导入写入：分表清洗（useSplitImport）拿到总表 + 销售表后直接写库，不再弹预览确认框。
export function useSourceImport({ onApplied }) {
  const inventoryStore = useInventoryStore()

  function applySummary(summary) {
    if (!summary?.inventory || !summary?.sales) {
      ElMessage.error('需要同时导入总表与销售表')
      return
    }

    const persisted = applySourceImport(inventoryStore, summary)

    onApplied?.(summary)

    // 快照压缩落库要一两秒，不阻塞界面；失败时明确提示，避免「界面说导入成功、刷新后没了」。
    void persisted.then((snapshotId) => {
      if (!snapshotId) {
        ElMessage.error('导入的数据没能存到本机（浏览器禁用了存储或空间不足），刷新后会丢失，请先导出留底')
      }
    })
  }

  return { applySummary }
}
