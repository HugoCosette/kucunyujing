import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import InventoryPanelView from '../views/InventoryPanelView.vue'
import SalesPanelView from '../views/SalesPanelView.vue'
import ConfigView from '../views/ConfigView.vue'
import PurchaseOrderView from '../views/PurchaseOrderView.vue'
import HiddenSkusView from '../views/HiddenSkusView.vue'
import { MAIN_PANEL } from '@/data/panels'

const router = createRouter({
  // 桌面离线版跑在 app:// 自定义协议下：hash 路由不依赖服务端回退；
  // 线上构建仍是 history 模式，深链刷新靠 dist/404.html，两者互不影响。
  history:
    import.meta.env.MODE === 'desktop'
      ? createWebHashHistory()
      : createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: MAIN_PANEL.path,
      name: MAIN_PANEL.routeName,
      component: InventoryPanelView,
    },
    {
      path: MAIN_PANEL.allPath,
      name: MAIN_PANEL.allRouteName,
      component: SalesPanelView,
    },
    {
      path: MAIN_PANEL.purchasePath,
      name: MAIN_PANEL.purchaseRouteName,
      component: PurchaseOrderView,
    },
    {
      // 采购下单的子面板：下单历史（查询 / 删除流水），与下单面板共用同一个视图，靠标签页切换。
      path: MAIN_PANEL.purchaseHistoryPath,
      name: MAIN_PANEL.purchaseHistoryRouteName,
      component: PurchaseOrderView,
    },
    {
      // 旧 `/orders` 深链：已并入「采购下单 → 下单历史」。
      path: MAIN_PANEL.ordersLegacyPath,
      redirect: () => ({ path: MAIN_PANEL.purchaseHistoryPath }),
    },
    {
      // 旧「下单设置」入口：并入 /config 的「下单配置」分组，保留深链兼容并自动落到缸规则。
      path: MAIN_PANEL.purchaseSettingsPath,
      redirect: () => ({ path: MAIN_PANEL.configPath, query: { panel: 'vat' } }),
    },
    {
      path: MAIN_PANEL.configPath,
      name: MAIN_PANEL.configRouteName,
      component: ConfigView,
    },
    {
      path: MAIN_PANEL.hiddenPath,
      name: MAIN_PANEL.hiddenRouteName,
      component: HiddenSkusView,
    },
    {
      path: '/about',
      name: 'about',
      // route level code-splitting
      // this generates a separate chunk (About.[hash].js) for this route
      // which is lazy-loaded when the route is visited.
      component: () => import('../views/AboutView.vue'),
    },
  ],
})

export default router
