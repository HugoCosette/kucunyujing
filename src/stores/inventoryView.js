import { ref } from 'vue'
import { defineStore } from 'pinia'

// 主面板的「查看状态」：筛选条件、展开的品名、批量勾选、当前行与表格滚动位置。
// App.vue 的 RouterView 带 :key，路由一变就重建视图组件；这些只跟「人怎么看这张表」有关的
// 状态放进 store，切到采购下单页再回来才能停在离开前的位置。
// 有意只留内存（刷新页面恢复默认视图），与事实层 / 计划层的持久化互不影响。
function createInventoryViewState() {
  return {
    productFilter: ref(''),
    colorFilter: ref(''),
    selectedWarningTones: ref([]),
    selectedModeLabels: ref([]),
    // null = 还没进过主面板（默认全部展开）；[] = 用户主动把品名都收起了。
    expandedProductKeys: ref(null),
    // 批量补货勾选：只记 SKU 标识集合。行会随虚拟滚动装卸，选择状态不能挂在行上。
    selectedSkuIds: ref(new Set()),
    selectedRowId: ref(null),
    tableScrollTop: ref(0),
    // 需安排草稿（手填但还没采纳的公斤数）：切页回来还要能接着填。
    plannedDrafts: ref({}),
  }
}

export const useInventoryViewStore = defineStore('inventory-view', createInventoryViewState)
