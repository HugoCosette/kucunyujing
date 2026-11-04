# 协作说明（面向编程 Agent）

## 只在主面板开发

- 需求迭代目标只有 **主面板** `/`、**全面板** `/all` 与 **配置信息** `/config`。新的功能、数据结构、交互和样式调整都在这三处进行。
- 全面板是主面板数据的只读全量视图（同源 store，不写入）：按“品名汇总父行 + 颜色子行”只读展示并支持全部列关键词搜索，不要再往里加编辑、导入导出等交互。
- 顶部导航左侧为主面板组，右侧为示例数据组。
- 主面板与示例面板共用 `src/views/InventoryPanelView.vue`，配置页与示例配置共用 `src/views/ConfigView.vue`；全面板是独立的只读视图 `src/views/AllDataPanelView.vue`，改动时以主面板行为为准。

## 示例数据区：请勿修改

以下内容属于示例数据区，仅用于对照演示，**不要改动**：

- `src/data/panels.js` 中的 `EXAMPLE_PANEL`（示例面板 `/example`、示例配置 `/example/config` 的名称、路径与路由名）。
- `src/components/PanelNavigation.vue` 右侧示例数据组及其“示例数据，请勿修改”提示。
- Pinia 的 `inventory-example` store 及其初始数据；不要改 `src/data/inventoryItems.js` 的种子数据来“修”示例。
- `src/views/ConfigView.vue` 中示例配置的标题与说明文案。

要求：

- 不要删除、改名、隐藏或重排示例面板 / 示例配置入口。
- 不要为对齐新功能去修改示例数据、示例 store 或示例路由。
- 校验功能时以主面板、全面板与配置信息为测试对象；示例数据只用于人工对照，不作为验收或自动测试目标。
