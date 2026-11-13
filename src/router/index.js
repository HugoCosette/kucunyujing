import { createRouter, createWebHistory } from 'vue-router'
import InventoryPanelView from '../views/InventoryPanelView.vue'
import SalesPanelView from '../views/SalesPanelView.vue'
import ConfigView from '../views/ConfigView.vue'
import PurchaseOrderView from '../views/PurchaseOrderView.vue'
import HiddenSkusView from '../views/HiddenSkusView.vue'
import { MAIN_PANEL } from '@/data/panels'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
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
