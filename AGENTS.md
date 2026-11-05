# 协作说明（面向编程 Agent）

## 只在主面板开发

- 需求迭代目标只有 **主面板** `/`、**销售表** `/sales` 与 **配置信息** `/config`。新的功能、数据结构、交互和样式调整都在这三处进行。
- 销售表是主面板动销指标（月均条数 / 订单总数 / 动销月份 / 动销客户）的来源：主面板与销售表的两个导入入口都支持一次选择总表 + 销售表，销售表自带的 4 个指标会写回主面板并重算热度，本页再按“品名 + 颜色”叠加 1-12 月条数与重量。整表按“品名汇总父行 + 颜色子行”展示并支持全部列关键词搜索。
- 顶部导航左侧为主面板组，右侧为示例数据组。
- 主面板与示例面板共用 `src/views/InventoryPanelView.vue`，配置页与示例配置共用 `src/views/ConfigView.vue`；销售表是独立视图 `src/views/SalesPanelView.vue`，改动时以主面板行为为准。
- 导入只有一个流程，且入口只在主面板：`src/composables/useSourceImport.js`（读文件、识别角色、写 store）+ `src/components/ImportSourcesDialog.vue`（预览/确认），必须同时选中总表 + 销售表；文件角色识别在 `src/utils/sourceImport.js`，总表解析 `inventoryImport.js`，销售表解析 `salesImport.js`，写回主面板行在 `inventoryApply.js`、`applySourceImport.js`。总表与销售表按「唯一标识」关联。
- 「导入分表」是同一流程的另一个入口：`src/components/ImportSplitTablesDialog.vue` + `src/composables/useSplitImport.js` 选 5 张分表（产品资料 / 出入库明细 / 库存结存表 / 欠货 / 生产排单），`src/utils/cleanMerge.js` 在 Worker（`src/workers/cleanMergeWorker.js`）里按 `数据清洗/clean-merge.js` 的口径清洗出总表 + 销售表，再由 `src/utils/splitTableImport.js` 复用 `inventoryImport.js` / `salesImport.js` 解析，最后进入同一个 `ImportSourcesDialog` 确认。改清洗口径时两处脚本要一起改。
- 备货模式（模式 / 热度档 / 系数）全部在自包含模块 `src/stocking/`：`config.json` 是唯一配置来源，`engine.js` 负责判定，`validate.js` 负责校验，`persistence.js` 负责读写（开发态由 `vite.config.js` 的 `stockingConfigFilePlugin` 写回源文件）。「配置信息」与「示例配置」共用同一份配置。
- SKU 配置信息弹窗为 `src/components/SkuDetailDialog.vue`，主面板与销售表共用：它同时渲染颜色单元格里的 ⓘ 按钮和弹窗，展示模式 / 热度 / 系数、逐因子等级方块（`evaluateItem` 返回的 `gradeDetails`）以及用 ECharts 画的 1-12 月条数与重量图。两处只需传 `:item` 与 `:panel-key`，不要再各写一份。

## 示例数据区：请勿修改

以下内容属于示例数据区，仅用于对照演示，**不要改动**：

- `src/data/panels.js` 中的 `EXAMPLE_PANEL`（示例面板 `/example`、示例配置 `/example/config` 的名称、路径与路由名）。
- `src/components/PanelNavigation.vue` 右侧示例数据组及其“示例数据，请勿修改”提示。
- Pinia 的 `inventory-example` store 及其初始数据；不要改 `src/data/inventoryItems.js` 的种子数据来“修”示例。
- `src/views/ConfigView.vue` 中示例配置的标题与说明文案。

要求：

- 不要删除、改名、隐藏或重排示例面板 / 示例配置入口。
- 不要为对齐新功能去修改示例数据、示例 store 或示例路由。
- 校验功能时以主面板、销售表与配置信息为测试对象；示例数据只用于人工对照，不作为验收或自动测试目标。
