export const DEFAULT_PANEL_KEY = 'main'

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
  configLabel: '配置信息',
  configPath: '/config',
  configRouteName: 'config',
}

// ⚠️ 示例数据区：示例面板与示例配置只用于对照演示。
// 新增或调整功能时只改主面板，不要修改这里的示例入口、示例数据或示例配置。
export const EXAMPLE_PANEL = {
  key: 'example',
  label: '示例面板',
  path: '/example',
  routeName: 'example',
  configLabel: '示例配置',
  configPath: '/example/config',
  configRouteName: 'exampleConfig',
}

export const inventoryPanels = [MAIN_PANEL, EXAMPLE_PANEL]

function toNavEntries(panel) {
  const entries = [{ key: panel.key, label: panel.label, path: panel.path }]
  // 只有声明了 allPath 的面板才提供“销售表”入口（目前仅主面板）。
  if (panel.allPath) {
    entries.push({ key: `${panel.key}-all`, label: panel.allLabel, path: panel.allPath })
  }
  entries.push({
    key: `${panel.key}-config`,
    label: panel.configLabel,
    path: panel.configPath,
  })
  return entries
}

// 顶部导航的左右两组入口：主面板组在左，示例数据组在右。
export const mainNavEntries = toNavEntries(MAIN_PANEL)
export const exampleNavEntries = toNavEntries(EXAMPLE_PANEL)

export function isExamplePanel(panelKey) {
  return panelKey === EXAMPLE_PANEL.key
}

export function getPanelConfigLabel(panelKey) {
  const panel = inventoryPanels.find((entry) => entry.key === panelKey) ?? MAIN_PANEL
  return panel.configLabel
}
