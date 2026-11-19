// 主面板（导航上叫「需求表」）：业务主线。新的需求、数据结构和交互调整都在这里与「配置板块」中完成。
export const MAIN_PANEL = {
  key: 'main',
  label: '需求表',
  path: '/',
  routeName: 'home',
  // 销售表：只读展示主面板 SKU 的动销指标，并叠加本页“导入销售表”的 1-12 月条数与重量。
  allLabel: '销售表',
  allPath: '/sales',
  allRouteName: 'sales',
  // 采购下单：把主面板写下的需安排按染厂拆成分订单；设置页维护染厂、分单人员与 SKU 可选染厂。
  purchaseLabel: '采购下单',
  purchasePath: '/purchase',
  purchaseRouteName: 'purchase',
  // 采购下单页的两个子面板：下单面板（拆单 + 确认）/ 下单历史（只读流水）。
  purchaseOrderTabLabel: '下单面板',
  purchaseHistoryTabLabel: '下单历史',
  purchaseHistoryPath: '/purchase/history',
  purchaseHistoryRouteName: 'purchaseHistory',
  // 旧 `/orders` 深链保留为跳转，落到「采购下单 → 下单历史」。
  ordersLegacyPath: '/orders',
  // 下单设置已并入「配置板块」页（/config 的下单配置分组）；旧路径保留为跳转，深链不会 404。
  purchaseSettingsLabel: '下单设置',
  purchaseSettingsPath: '/purchase/settings',
  purchaseSettingsRouteName: 'purchaseSettings',
  configLabel: '配置板块',
  configPath: '/config',
  configRouteName: 'config',
  // 屏蔽列表：独立页面，入口固定在顶部导航右侧，与主面板业务入口分开。
  hiddenLabel: '屏蔽列表',
  hiddenPath: '/hidden',
  hiddenRouteName: 'hidden',
}

// 顶部导航入口：需求表 → 采购下单 → 销售表 → 配置板块（备货配置 + 下单配置）。
export const mainNavEntries = [
  { key: MAIN_PANEL.key, label: MAIN_PANEL.label, path: MAIN_PANEL.path },
  {
    key: `${MAIN_PANEL.key}-purchase`,
    label: MAIN_PANEL.purchaseLabel,
    path: MAIN_PANEL.purchasePath,
  },
  { key: `${MAIN_PANEL.key}-all`, label: MAIN_PANEL.allLabel, path: MAIN_PANEL.allPath },
  {
    key: `${MAIN_PANEL.key}-config`,
    label: MAIN_PANEL.configLabel,
    path: MAIN_PANEL.configPath,
  },
]

// 顶部导航右侧的辅助入口：屏蔽列表。
export const utilityNavEntries = [
  {
    key: `${MAIN_PANEL.key}-hidden`,
    label: MAIN_PANEL.hiddenLabel,
    path: MAIN_PANEL.hiddenPath,
  },
]
