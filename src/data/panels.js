export const DEFAULT_PANEL_KEY = 'main'

// 主面板：业务主线。新的需求、数据结构和交互调整都在主面板与“配置信息”中完成。
export const MAIN_PANEL = {
  key: 'main',
  label: '主面板',
  path: '/',
  routeName: 'home',
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
  return [
    { key: panel.key, label: panel.label, path: panel.path },
    { key: `${panel.key}-config`, label: panel.configLabel, path: panel.configPath },
  ]
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
