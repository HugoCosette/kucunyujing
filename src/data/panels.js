// 主面板：业务主线。新的需求、数据结构和交互调整都在主面板与“配置信息”中完成。
export const MAIN_PANEL = {
  key: 'main',
  label: '主面板',
  path: '/',
  routeName: 'home',
  // 销售表：只读展示主面板 SKU 的动销指标，并叠加本页“导入销售表”的 1-12 月条数与重量。
  allLabel: '销售表',
  allPath: '/sales',
  allRouteName: 'sales',
  // 采购下单：在本次采购清单的基础上按染厂拆分订单；下单设置维护染厂、分单人员与 SKU 可选染厂。
  purchaseLabel: '采购下单',
  purchasePath: '/purchase',
  purchaseRouteName: 'purchase',
  purchaseSettingsLabel: '下单设置',
  purchaseSettingsPath: '/purchase/settings',
  purchaseSettingsRouteName: 'purchaseSettings',
  configLabel: '配置信息',
  configPath: '/config',
  configRouteName: 'config',
  // 屏蔽列表：独立页面，入口固定在顶部导航右侧，与主面板业务入口分开。
  hiddenLabel: '屏蔽列表',
  hiddenPath: '/hidden',
  hiddenRouteName: 'hidden',
}

// 顶部导航入口：主面板 → 销售表 → 采购下单 → 下单设置 → 配置信息。
export const mainNavEntries = [
  { key: MAIN_PANEL.key, label: MAIN_PANEL.label, path: MAIN_PANEL.path },
  { key: `${MAIN_PANEL.key}-all`, label: MAIN_PANEL.allLabel, path: MAIN_PANEL.allPath },
  {
    key: `${MAIN_PANEL.key}-purchase`,
    label: MAIN_PANEL.purchaseLabel,
    path: MAIN_PANEL.purchasePath,
  },
  {
    key: `${MAIN_PANEL.key}-purchase-settings`,
    label: MAIN_PANEL.purchaseSettingsLabel,
    path: MAIN_PANEL.purchaseSettingsPath,
  },
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
