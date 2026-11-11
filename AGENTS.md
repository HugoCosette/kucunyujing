# 协作说明（面向编程 Agent）

## 只在主面板开发

- 需求迭代目标只有 **主面板** `/`、**销售表** `/sales`、**采购下单** `/purchase`、**下单设置** `/purchase/settings` 与 **配置信息** `/config`。新的功能、数据结构、交互和样式调整都在这几处进行。
- 销售表是主面板动销指标（月均条数 / 订单总数 / 动销月份 / 累计客户 / 累积条数）的来源：主面板与销售表的两个导入入口都支持一次选择总表 + 销售表，销售表自带的 5 个指标与 1-12 月条数会写回主面板并参与备货计算（月均条数决定模式、1-12 月条数决定加权月销量），本页再按“品名 + 颜色”叠加 1-12 月的条数、重量与订单数（每月三列：条数 / 重量 / 订单数）。整表按“品名汇总父行 + 颜色子行”展示并支持全部列关键词搜索。
- 「客户CR5率」只展示在销售表：清洗引擎按「销量前 5 客户 ÷ 该 SKU 总销量」输出 0~1 的比例，页面按百分比显示；它**不是**动销指标，不写回主面板、不进备货配置。品名父行按「累积条数」加权平均，不做求和（`SALES_RATIO_COLUMNS` + `groupTableRowsByProduct` 的 `ratioColumns`）。
- 清洗口径里 `月均条数 = 累积条数 ÷ 动销月份`、`周消耗 = 月均条数 ÷ 4`（清洗直接按公斤输出「周销量」，单位公斤/周）；月均条数直接决定模式归属（热销 30~不限 / 常规 10~30 / 按量 3~10 / 尾货 0.01~3 / 滞销 0~0.01），改这个口径要提醒用户核对模式区间与系数。清洗按品名的「出码率」输出 `公斤系数`（码 = 1 ÷ 出码率，公斤 = 1），销量与库存统一换算成公斤；无法换算成公斤的 SKU（缺出码率的码单位、条/件/米）在基准表阶段直接剔除，详见 `docs/功能说明/数据清洗规则.md`。
- 顶部导航左侧为主面板组，右侧为示例数据组。
- 主面板与示例面板共用 `src/views/InventoryPanelView.vue`，配置页与示例配置共用 `src/views/ConfigView.vue`；销售表是独立视图 `src/views/SalesPanelView.vue`，改动时以主面板行为为准。
- 导入只有一个流程，且入口只在主面板：`src/composables/useSourceImport.js`（读文件、识别角色、写 store）+ `src/components/ImportSourcesDialog.vue`（预览/确认），必须同时选中总表 + 销售表；文件角色识别在 `src/utils/sourceImport.js`，总表解析 `inventoryImport.js`，销售表解析 `salesImport.js`，写回主面板行在 `inventoryApply.js`、`applySourceImport.js`。总表与销售表按「唯一标识」关联。
- 「导入分表」是同一流程的另一个入口：`src/components/ImportSplitTablesDialog.vue` + `src/composables/useSplitImport.js` 选 5 张分表（产品资料 / 出入库明细 / 库存结存表 / 欠货 / 生产排单），`src/utils/cleanMerge.js` 在 Worker（`src/workers/cleanMergeWorker.js`）里调用共享引擎 `src/cleaning/engine.js` 清洗出总表 + 销售表，再由 `src/utils/splitTableImport.js` 复用 `inventoryImport.js` / `salesImport.js` 解析，最后进入同一个 `ImportSourcesDialog` 确认。
- 清洗口径只有一份：`tools/cleaning/engine.mjs`（配置 / 唯一标识 / 汇总 / 关联 / 宽松合并）。网页经 `src/cleaning/engine.js` 一行转发引用它（`export * from '../../tools/cleaning/engine.mjs'`），`src/utils/cleanMerge.js` 是浏览器适配器（fflate 流式读表）；命令行脚本 `tools/cleaning/clean-merge.js` 直接 `import('./engine.mjs')`（SheetJS 读表 → 写 `output/*.xlsx`）。**改清洗逻辑只改 `engine.mjs`**。该目录是网页构建的一部分，不要删除或改名；真要挪位置，同步改 `src/cleaning/engine.js` 那一行。
- 测试数据缺「客户」列时用 `tools/cleaning/simulate-customers.js` 补（按单号模拟客户、加工出库填加工厂、固定种子可复现，只新增列不改其它单元格）；它是造数工具，不属于清洗口径，也不参与网页构建。
- 备货模式全部在自包含模块 `src/stocking/`：`config.json` 是唯一配置来源，v4 起为「多方案文件」（`profiles[]` + `activeProfileId`），每个方案内部是 `salesWindow.weights` + `scoring` + `strategies[]`（自动策略 5 个固定模式 / 手动策略）。`constants.js` 放色彩、系数三键与条换算表，`engine.js` 负责判定，`scoring.js` 负责 SKU 健康度评分，`validate.js` 负责归一化与校验（旧版本配置整份抛弃、直接回到默认），`persistence.js` 负责读写（开发态由 `vite.config.js` 的 `stockingConfigFilePlugin` 写回源文件）。模式判定不用评分档：模式由「月均条数」区间直接判定（每个模式一段 `range`，端点留空=不限，按模式顺序取第一条命中的区间），系数按「客户类别 × 色彩」直接给三档。「配置信息」与「示例配置」共用同一份方案文件；演示方案已封禁（`src/stocking/demoProfile.js` 保留逻辑占位），方案下拉里不会再出现。
- 计算口径：热销 / 常规按「日库销比 = 预计库存条数 ÷ 日销量」比较系数（单位：天）；按量按「库存公斤数」直接比系数（单位：公斤）；热销 / 常规 / 按量里的专属品（累计客户 = 1）与尾货 / 滞销只在模式列标注、不参与计算。预警灯仍是 20% 绿区：低于红线红、高于峰值紫、正常 ±20% 绿、其余黄。
- 加权月销量 = 近 1 个月 ×w1 + 近 3 个月月均 ×w3 + 近 12 个月月均 ×w12（默认 50/30/20，配置页可改且必须合计 100%），基准月取数据里最后一个有销量的月份；它只影响「天数」，不影响模式判定。
- 数据来源、清洗口径、主面板每一列的公式与单位速查见 `docs/功能说明/数据清洗规则.md`；改分表字段、单位换算或计算字段时，必须同步更新该文档。
- 手动策略的 SKU 归属单独存 `src/stocking/manualSkus.json`（唯一标识 → `{ modeId, coefficients }`，`src/stocking/manual.js` 负责读写），**不写进 config.json，也不写进 SKU 行**：它是"人对商品的长期决定"，跨导入与刷新保留。评估器 `createEvaluator(config, { manualOverrides, baselineMonth })` 命中即短路，不跑模式匹配；自定系数按「公斤」比较。手动策略的另外两种内置行为：「排除模式」（`behavior: exclude`，旧版内部名为 `slow` / 模式 id `manual-slow`，`validate.js` 与 `manual.js` 自动迁移）与「订单货模式」（`behavior: order`、模式 id `manual-order`，条目额外带 `orders: [{ name, factory, quantity, note }]`，一个 SKU 可挂多张订单）都不参与备货策略（不计预警、不进紧急补货、无建议值，仍可人工填需安排）；订单货的订单明细只在记录与展示层使用，不参与任何计算。
- SKU 配置信息弹窗为 `src/components/SkuDetailDialog.vue`，主面板与销售表共用：它同时渲染颜色单元格里的 ⓘ 按钮和弹窗，展示模式 / 加权月销量（公斤）/ 系数、健康度评分（默认 5 张维度小卡 + 1 条综合评分，红 / 黄 / 绿；按量模式改为 2 张判定卡、不显示综合评分），以及用 ECharts 画的 1-12 月条数与重量图。两处只需传 `:item` 与 `:panel-key`，不要再各写一份。
- 健康度评分（需求 1.5.1）只在 SKU 弹窗展示，不进主面板表格：5 个维度（客户数 CR5 / 累计客户数 / 销售环比率 / 本次进销比 / 预估月消耗）各配「低 / 中 / 高三条风险区间 + 权重」（展示顺序也是低 → 中 → 高），命中哪条区间就取对应档位的得分（区间两端都含，端点重叠时按 中 → 高 → 低 取第一条），综合分 = Σ(得分 × 权重) ÷ 参与维度权重合计。口径唯一一份在 `src/stocking/scoring.js`（`evaluateScoring`），区间 / 权重 / 三档得分 / 综合分区间都存在方案里的 `scoring` 段，改参数走「配置页 → 评分设置 → 编辑评分规则」（整块设置由 `src/components/ScoringSettings.vue` 一个组件承载：摘要 + 编辑弹窗），SKU 弹窗只读。本次进销比是「越大越危险」：< 20% 低风险、20% ~ 30% 中风险、> 30% 高风险。销售环比率严格按**打开系统时的日期**取月份：≥26 号取「本月 vs 上月」，≤25 号取「上月 vs 前月」，与销售表基准月无关（基准月只用于加权月销量）；1 月跨年时缺去年 12 月 / 11 月数据按无数据，卡片悬停提示写明比的是哪两个月（含两边月份销量）或缺哪个月、哪个月销量为 0。上期为 0、本期有销量记 +100%；本期为 0、上期有销量记 0%；两期都为 0 按无数据。进销比 = 建议补货（公斤）÷ 累积销量（公斤，清洗输出的全历史累积销量），预估月消耗 = 加权月销量（公斤）−（理论库存 + 建议补货数量，均为公斤）；缺失的维度显示「无数据」且不参与加权。
- 按量模式（`modeKey === 'bulk'`）的弹窗走专属判定 `evaluateBulkScoring`（同在 `src/stocking/scoring.js`）：只判 2 项、不做综合评分 —— 本次进销比（口径同 5 维评分，默认低于 40% 低风险 / 40% ~ 60% 正常 / 高于 60% 高风险）与累计客户数（默认 5 ~ 10 个中风险 / 少于 5 个高风险 / 多于 10 个低风险）。两项阈值存在方案的「按量」模式 `healthScoring` 段（`ratio` / `customers` 各一组 `normalFrom` / `normalTo`），在「配置页 → 按量模式 → 系数表下方 → 健康度判定」里改；改动只影响弹窗展示，不参与备货计算。
- SPU 分级（S+ / S / A / B / C / Z）只在主面板**品名汇总行的模式列**展示：等级 = 该品名下全部 SKU 的 `monthlyAvgCount` 之和按六档阈值判定（默认 2500 / 300 / 100 / 30 / 1，Z 兜底 < 1），与筛选无关；口径唯一一份在 `src/stocking/spuGrades.js`，阈值存在方案的 `spuGrades.tiers[]`，配置页「SPU 分级 → 编辑分级规则」可改（配置页组件 `src/components/SpuGradeSettings.vue`，只改草稿、页面「确定」才落盘）。它不参与模式 / 系数 / 预警计算，新增该配置段不升版本号（v4 老配置自动补默认）。
- 批量补货在主面板一屏内完成：表格首列复选框（`selectedSkuIds` 只存 SKU 标识，品名父行按子行全选 / 半选推导，表头全选作用于当前筛选结果；点击整行等同于点该行复选框，父行点整行 = 全选 / 全不选其下 SKU）→ 底部浮动条 → 确认弹窗（默认数量取 `getSuggestedPlanned`，即补到正常库存，也就是绿色带中位）→ 统一经 `applyRestockPlans` **覆盖**写入「需安排」并进「本次采购清单」（同一 SKU 一条）。紧急补货弹窗也走这条写入路径，它先在调用处把「追加」换算成绝对需安排量。
- 主面板表格里**只有「需安排」可编辑**（另有采购清单里的分订单数量与两个补货弹窗的数量）。品名、颜色、生产中、欠货、周消耗、周转入、在途库存、在仓库存都是导入值，一律以纯文本只读展示，不要再改回 `ElInput` / `ElInputNumber`；导入后要改数据请重新导入或去源表修正。
- 采购下单模块是自包含目录 `src/purchase/`：`settings.json` 存染厂清单、树形分类与分单人员、SKU 可选染厂、SKU 分类覆盖；`orders.json` 存分订单。两者都由 `vite.config.js` 的写盘中间件在开发态回写源文件，构建产物退化为 localStorage（键 `purchase-settings:v1` / `purchase-orders:v1`）。`validate.js` 负责归一化，`resolve.js` 是唯一的选项口径（`factoriesForSku` / `categoryForSku` / `assigneesForSku`），页面不要各写一份回退规则。
- 分订单以**唯一标识**为键（不是 `purchaseList.id`，导入后会重排），一张分订单 = `{ factoryId, factoryName, assignee, quantity, note }`，一个 SKU 可挂多张。采购清单的「已下单」由分订单数量合计得出，不再手填「实际计划」；主面板弹窗里的「去下单」与 `/purchase` 页面共用 `src/components/SkuOrderEditor.vue`（弹窗包装是 `SkuOrderDialog.vue`）。
- 一个 SKU 只属于一个树形分类：清洗引擎从产品资料带出 `树形分类` 列（`BASE.columns` 里标记 `optional`，源表缺列时为空），`inventoryImport.js` 解析成 `treeCategory`，`inventoryApply.js` 透传到库存行；下单设置里的 `skuCategoryOverrides` 可人工覆盖。分单人员下拉取该分类的名单，分类没维护人员时回退为全部人员。

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
