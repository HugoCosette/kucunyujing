import { createRouter, createWebHistory } from 'vue-router'
import InventoryPanelView from '../views/InventoryPanelView.vue'
import SalesPanelView from '../views/SalesPanelView.vue'
import ConfigView from '../views/ConfigView.vue'
import PurchaseOrderView from '../views/PurchaseOrderView.vue'
import PurchaseSettingsView from '../views/PurchaseSettingsView.vue'
import { inventoryPanels } from '@/data/panels'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // 主面板 + 销售表 + 配置信息 是需求迭代目标；示例面板 + 示例配置 仅作对照示例，勿改。
    ...inventoryPanels.flatMap((panel) => [
      {
        path: panel.path,
        name: panel.routeName,
        component: InventoryPanelView,
        props: { panelKey: panel.key },
      },
      ...(panel.allPath
        ? [
            {
              path: panel.allPath,
              name: panel.allRouteName,
              component: SalesPanelView,
              props: { panelKey: panel.key },
            },
          ]
        : []),
      ...(panel.purchasePath
        ? [
            {
              path: panel.purchasePath,
              name: panel.purchaseRouteName,
              component: PurchaseOrderView,
              props: { panelKey: panel.key },
            },
            {
              path: panel.purchaseSettingsPath,
              name: panel.purchaseSettingsRouteName,
              component: PurchaseSettingsView,
              props: { panelKey: panel.key },
            },
          ]
        : []),
      {
        path: panel.configPath,
        name: panel.configRouteName,
        component: ConfigView,
        props: { panelKey: panel.key },
      },
    ]),
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
