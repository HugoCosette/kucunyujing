# 协作说明（面向编程 Agent）

## 只在主面板开发

- 需求迭代目标只有 **主面板** `/`、**销售表** `/sales` 与 **配置信息** `/config`。新的功能、数据结构、交互和样式调整都在这三处进行。
- 销售表是主面板动销指标（月均条数 / 订单总数 / 动销月份 / 动销客户 / 累积条数）的来源：主面板与销售表的两个导入入口都支持一次选择总表 + 销售表，销售表自带的 5 个指标会写回主面板并重算评分，本页再按“品名 + 颜色”叠加 1-12 月的条数、重量与订单数（每月三列：条数 / 重量 / 订单数）。整表按“品名汇总父行 + 颜色子行”展示并支持全部列关键词搜索。
- 清洗口径里 `月均条数 = 累积条数 ÷ 动销月份`、`周消耗 = 月均条数 ÷ 4`；改这两个口径会直接改变备货红线/正常/峰值，改完要提醒用户重新校准系数。
- 顶部导航左侧为主面板组，右侧为示例数据组。
- 主面板与示例面板共用 `src/views/InventoryPanelView.vue`，配置页与示例配置共用 `src/views/ConfigView.vue`；销售表是独立视图 `src/views/SalesPanelView.vue`，改动时以主面板行为为准。
- 导入只有一个流程，且入口只在主面板：`src/composables/useSourceImport.js`（读文件、识别角色、写 store）+ `src/components/ImportSourcesDialog.vue`（预览/确认），必须同时选中总表 + 销售表；文件角色识别在 `src/utils/sourceImport.js`，总表解析 `inventoryImport.js`，销售表解析 `salesImport.js`，写回主面板行在 `inventoryApply.js`、`applySourceImport.js`。总表与销售表按「唯一标识」关联。
- 「导入分表」是同一流程的另一个入口：`src/components/ImportSplitTablesDialog.vue` + `src/composables/useSplitImport.js` 选 5 张分表（产品资料 / 出入库明细 / 库存结存表 / 欠货 / 生产排单），`src/utils/cleanMerge.js` 在 Worker（`src/workers/cleanMergeWorker.js`）里调用共享引擎 `src/cleaning/engine.js` 清洗出总表 + 销售表，再由 `src/utils/splitTableImport.js` 复用 `inventoryImport.js` / `salesImport.js` 解析，最后进入同一个 `ImportSourcesDialog` 确认。
- 清洗口径只有一份：`tools/cleaning/engine.mjs`（配置 / 唯一标识 / 汇总 / 关联 / 宽松合并）。网页经 `src/cleaning/engine.js` 一行转发引用它（`export * from '../../tools/cleaning/engine.mjs'`），`src/utils/cleanMerge.js` 是浏览器适配器（fflate 流式读表）；命令行脚本 `tools/cleaning/clean-merge.js` 直接 `import('./engine.mjs')`（SheetJS 读表 → 写 `output/*.xlsx`）。**改清洗逻辑只改 `engine.mjs`**。该目录是网页构建的一部分，不要删除或改名；真要挪位置，同步改 `src/cleaning/engine.js` 那一行。
- 测试数据缺「客户」列时用 `tools/cleaning/simulate-customers.js` 补（按单号模拟客户、加工出库填加工厂、固定种子可复现，只新增列不改其它单元格）；它是造数工具，不属于清洗口径，也不参与网页构建。
- 备货模式（模式 / 评分档 / 系数）全部在自包含模块 `src/stocking/`：`config.json` 是唯一配置来源，v3 起为「多方案文件」（`profiles[]` + `activeProfileId`，每个方案内部仍是 v2 的 `strategies[]`，含自动策略与手动策略）；`engine.js` 负责判定，`validate.js` 负责校验与 v1→v2→v3 迁移，`persistence.js` 负责读写（开发态由 `vite.config.js` 的 `stockingConfigFilePlugin` 写回源文件），`calibrate.js` 提供「按当前数据校准」的分位阈值计算。「配置信息」与「示例配置」共用同一份方案文件，切换方案对两页同时生效；生产数据与演示数据各用一个方案，互不覆盖。切换 / 复制 / 重命名 / 删除方案与导入导出整份方案文件都在配置页顶部与底部完成。
- 「按当前数据校准」只用当前模式的评分因子，取当前已导入行的非零值分位（S≈p90 / A≈p70 / B≈p40，C 固定 0，且不超过样本最大值），整列为 0/空的因子会提示「无有效数据」并跳过；勾选「同时按 S 个数重建评分档」会重排为 `3S / 2S / 1S / 默认档`（条件 `S ≥ 3 / 2 / 1`，同名档留系数，缺失档按默认档 ×1.5 / ×1.25 / ×1 生成）；校准只改草稿，点「确定」才落盘。
- 评分档命名约定：按命中的 S 个数命名（`1S` / `2S` / `3S`），条件依次为 `S ≥ 3`、`S ≥ 2`、`S ≥ 1`，默认档固定末位兜底。
- 手动策略的 SKU 归属单独存 `src/stocking/manualSkus.json`（唯一标识 → `{ modeId, coefficients }`，`src/stocking/manual.js` 负责读写），**不写进 config.json，也不写进 SKU 行**：它是"人对商品的长期决定"，跨导入与刷新保留。评估器 `createEvaluator(config, { manualOverrides })` 命中即短路，不跑模式匹配。新增行为（behavior）才需要改代码，模式实例由生产人员自配。
- SKU 配置信息弹窗为 `src/components/SkuDetailDialog.vue`，主面板与销售表共用：它同时渲染颜色单元格里的 ⓘ 按钮和弹窗，展示模式 / 评分档 / 系数、逐因子等级方块（`evaluateItem` 返回的 `gradeDetails`）以及用 ECharts 画的 1-12 月条数与重量图。两处只需传 `:item` 与 `:panel-key`，不要再各写一份。
- 批量补货在主面板一屏内完成：表格首列复选框（`selectedSkuIds` 只存 SKU 标识，品名父行按子行全选 / 半选推导，表头全选作用于当前筛选结果；点击整行等同于点该行复选框，父行点整行 = 全选 / 全不选其下 SKU）→ 底部浮动条 → 确认弹窗（默认数量取 `getSuggestedPlanned`，即补至正常库存 80% 下限）→ 统一经 `applyRestockPlans` **覆盖**写入「需安排」并进「本次采购清单」（同一 SKU 一条）。紧急补货弹窗也走这条写入路径，它先在调用处把「追加」换算成绝对需安排量。
- 主面板表格里**只有「需安排」可编辑**（另有采购清单的「实际计划」与两个补货弹窗的数量）。品名、颜色、生产中、欠货、周消耗、周转入、在途库存、在仓库存都是导入值，一律以纯文本只读展示，不要再改回 `ElInput` / `ElInputNumber`；导入后要改数据请重新导入或去源表修正。

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
