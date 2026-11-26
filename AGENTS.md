# 协作说明（面向编程 Agent）

布料备货决策系统：Vue 3 + Vite + Element Plus + Pinia，纯 JavaScript（无 TS、无测试框架）。

本文件只写「必须遵守的硬约束 + 去哪找细节」。动手前按 §4 打开对应文档，不要凭这里的一行话推断实现。

## 0. 命令

| 目的 | 命令 |
| --- | --- |
| 开发服务器 | `npm run dev` |
| 构建（改完至少过这一步） | `npm run build` |
| 预览构建产物 | `npm run preview` |
| 备货口径自检（校验当前方案 + 跑样例断言，不符即非零退出） | `node tools/check-stocking.mjs` |
| 滚动导入回放（1000 SKU × 7 天，验在途口径） | `cd tools/cleaning; node simulate-rolling.mjs` |
| 真实体量演示数据（2 万 SKU × 7 天，读 `tools/cleaning/data`） | `cd tools/cleaning; node --max-old-space-size=6144 simulate-real-rolling.mjs --skus 20000 --days 7` |
| 离线跑清洗（读 `tools/cleaning/data/`，写 `output/`） | `cd tools/cleaning; npm install; npm run clean` |
| 桌面开发（Electron + HMR） | `npm run desktop:dev` |
| 打 Windows 离线包（dir 免安装 / nsis 安装包） | `npm run pack:win:dir` / `npm run pack:win`（详见 [离线打包说明.md](./docs/功能说明/离线打包说明.md)） |

仓库没有 lint / 单元测试 / 格式化配置，`npm run build` 是唯一的自动校验；其余按 §4 的「手验」逐条走。

## 1. 硬约束（改了会出事，别改回去）

1. **面板范围**：只有主面板 `/`（导航名「需求表」）、采购下单 `/purchase`、销售表 `/sales`、设置 `/config`（导航名「配置板块」）+ 辅助页屏蔽列表 `/hidden`，顶部导航就按 需求表 → 采购下单 → 销售表 → 配置板块 排；「采购下单」页内分两个子面板——`/purchase` 下单面板、`/purchase/history` 下单历史（只读），共用 `PurchaseOrderView.vue` 靠 `.purchase-tabs` 与 `route.name` 切换。导航入口只认 `src/data/panels.js`（`mainNavEntries` + `utilityNavEntries`，显示名取 `MAIN_PANEL.label` / `configLabel`），代码标识与路由不跟着改名；旧 `/purchase/settings`、旧 `/orders` 只保留跳转。
2. **一类口径只有一份实现**，改口径只改这一份，别在页面里再算一遍：

   | 口径 | 唯一实现 | 文档 |
   | --- | --- | --- |
   | 分表清洗 / 单位换算 / 汇总 | `tools/cleaning/engine.mjs` | [数据清洗规则.md](./docs/功能说明/数据清洗规则.md) |
   | 模式判定 / 系数 / 加权月销量 | `src/stocking/engine.js` | [模式与系数设置.md](./docs/功能说明/模式与系数设置.md) |
   | 健康度评分（含按量 2 项判定） | `src/stocking/scoring.js`；输入因子 `src/utils/skuHealth.js` | 同上，第 12 节 |
   | 本次补货风险（净偏离合计） | `src/stocking/replenishRisk.js` | 同上，12.5 节 |
   | SPU 分级 | `src/stocking/spuGrades.js` | 同上 |
   | 缸规则 | `src/purchase/vat.js` | [采购下单流程.md](./docs/功能说明/采购下单流程.md) |
   | 下单填量颜色（不足八成黄 / 八成~100% 绿 / 超一缸内绿 / 超过一缸红） | `src/purchase/fillTone.js` | 同上，3.7 节 |
   | 分单选项（染厂 / 分类 / 人员） | `src/purchase/resolve.js` | 同上 |
   | 品名父行聚合 | `src/utils/productGroups.js` | [前端视图与交互.md](./docs/功能说明/前端视图与交互.md) |
  | 在途对账（已安排 / 生产中 / 到仓） | `src/purchase/inTransit.js` | [采购下单流程.md](./docs/功能说明/采购下单流程.md) 3.11 |
  | 导入后「SKU 数据变动」（抓旧值 / 比对 / 落盘） | `src/data/importDiff.js` | [前端视图与交互.md](./docs/功能说明/前端视图与交互.md) 6.1 |

3. **主面板只有「需安排」可编辑**（另有采购下单页的分订单数量、紧急补货弹窗的数量）。品名 / 颜色 / 库存 / 销量这类导入值一律纯文本只读，不要改回 `ElInput` / `ElInputNumber`；要改数据就重新导入或改源表。
4. **缸只在采购下单生效**：主面板「需安排」与批量 / 紧急补货的默认量始终是 `getSuggestedPlanned()` 的精准公斤数，不做缸取整；一张分订单只用一种缸型，不拼缸。分订单一律按缸规则**先带值再让人改**：进 SKU 面板（`/purchase` 选中行，含主面板采纳 / 确认补货跳转后自动选中的那条）若还没有分订单，自动带出一张按缸规则换算的建议单（同一 SKU 只自动带一次，删掉不再补；只有人点选的行才自动带，筛选导致的自动回落不预填，否则一开「未下单」筛选会把整张清单连锁填满），点「添加分订单」也带默认值。破坏性动作不在弹窗里问：左列表每行的「撤销」与分订单末列的「删除」都是**就地两段确认**（首点变「确认撤销」/「确认删除」，再点才执行，点别处自动取消），`⋯` 菜单里的入口才用 `ElMessageBox`。
5. **同一批货只能算一次**：预计库存的「在途」只来自 `src/purchase/inTransit.js`（`在途 = max(0, max(下单累计, 排单累计) − 生产入库累计 − 手工补登累计)`），不要再把 `producing` / `ordered` 单独加进预计库存；主面板「下过单」只作留痕，不参与任何计算。
6. **「删除」是屏蔽**：写 `src/stocking/hiddenSkus.json`，源表与销售数据不动，解除在 `/hidden`。
7. **跨导入一律按 `skuId` 关联**：需安排 / 撤销快照存 `meta.workspace`，分订单以唯一标识为键；不要用行 `id`（导入后会重排）。
8. **业务数据只经 `src/data/` 一层**：页面与 store 不直连 IndexedDB；设置类（下单设置 / 备货方案 / 手动清单 / 屏蔽清单）仍走 localStorage + 开发态写回 JSON，不要挪进 IndexedDB。
9. **不重复造第二份**：列表页不新增第二套表头（下单历史是单表头 + 批次分组带）；待下单列表直接由需安排（`planned > 0`）派生、采购状态组「已下单 / 已到仓」由在途判据得出；SKU 弹窗主面板与销售表共用；新页面导出用 `src/utils/xlsxWrite.js` 的 `saveWorkbook()`。
10. **改口径必须同步文档**：改清洗字段 / 单位 → 数据清洗规则.md；改模式 / 系数 / 评分 → 模式与系数设置.md；改下单 / 缸 / 到货 → 采购下单流程.md；改导入 / 持久化 / 种子 → 数据持久化方案.md；改面板交互 → 前端视图与交互.md。改清洗或模式口径时**提醒用户核对模式区间、系数与预警**。

## 2. 目录地图

| 路径 | 管什么 |
| --- | --- |
| `src/views/` | 页面：`InventoryPanelView` 主面板、`SalesPanelView` 销售表、`PurchaseOrderView` 采购下单（含「下单面板 / 下单历史」两个子面板）、`ConfigView` 设置壳、`HiddenSkusView` 屏蔽列表 |
| `src/components/` | 弹窗与设置块：导入（`ImportSplitTablesDialog`）、`SkuDetailDialog` + `SkuDetailTrigger`、补货与订单（`SkuOrderEditor` / `PurchaseOrderRecordsDialog`）、`OrderHistoryPanel`（下单历史子面板）、设置页各块（`PurchaseSettingsPanel` / `ScoringSettings` / `SpuGradeSettings` / `VatRuleSettings` / `HiddenSkusPanel` / `DataStoragePanel`） |
| `src/stores/` | `inventory`（四页共用的库存与销售表状态）、`inventoryView`（主面板视图状态，只留内存）、`stocking`（方案配置）、`purchase`（设置、草稿与分订单） |
| `src/data/` | 持久化唯一层：`repo.js` 契约、`indexedDbRepo.js` 实现、`db.js` 封装、`serialize.js` 序列化、`persistence.js` 快照与计划层、`importDiff.js` 导入变动报表、`bootstrap.js` 启动编排、`transfer.js` 全量导出导入、`panels.js` 导航、`inventoryItems.js` 种子 |
| `src/stocking/` | 备货自包含模块，`config.json` 是唯一配置来源（v4 多方案） |
| `src/purchase/` | 下单自包含模块：`settings.json` / `orders.json` / `validate.js` / `resolve.js` / `vat.js` / `history.js` |
| `src/cleaning/engine.js` | 一行转发到 `tools/cleaning/engine.mjs`（网页与命令行共用同一份清洗口径） |
| `src/utils/` | 解析与计算适配：导入（`inventoryImport` / `salesImport` / `splitTableImport` / `inventoryApply` / `applySourceImport`）、`inventory.js`、`productGroups.js`、`skuHealth.js`、`skuCreate.js`、`xlsx*` |
| `src/composables/` | 导入流程：`useSplitImport`（选表 → 清洗 → 解析）、`useSourceImport`（确认后写 store） |
| `src/workers/` | `cleanMergeWorker`（清洗）、`persistWorker`（快照 gzip） |
| `tools/cleaning/` | 清洗引擎 + 命令行 `clean-merge.js` + 造数脚本 `simulate-customers.js`；自包含目录，不参与网页构建但**不要删除或改名** |
| `tools/check-stocking.mjs` | 备货口径自检脚本 |
| `electron/` | 桌面外壳：`main.cjs`（`app://` 固定 origin + 窗口）、`dev.mjs`（开发态起 Vite 再拉 Electron）、`make-update.mjs`（生成前端热更新包），配置在 `electron-builder.json` |
| `docs/` | `功能说明/` 是各域口径（以它为准）；`需求文档/` 是需求原文；`prototype/` 是视觉原型；`测试数据/滚动导入演示/` 是 128 SKU 的 7 天演示数据，`测试数据/滚动导入演示-2w/` 是基于 2026-10-21 真实导出的 2 万 SKU × 7 天（约 407 MB，见各自 README） |

## 3. 最容易被改错的几件事

- 四个面板共用同一个 `inventory` store；销售表是独立视图，行为以主面板为准。
- 导入只有一个流程、一个入口：主面板「导入分表」→ 5 张分表 → Worker 清洗出总表 + 销售表 → 直接写入（无预览确认弹窗）。销售表页**没有**自己的导入入口，空态也指向主面板。
- 客户CR5率只在销售表展示，是比例列（父行按累积条数加权平均，不求和），不写回主面板、不进备货配置。
- 设置页是一个壳两个域：备货配置（模式与系数 / 销量加权 / 评分 / SPU 分级 / 筛选显示规则）与下单配置（缸规则 / 染厂清单 / 分单人员表 / 树形分类与分单 / SKU 可选染厂）。草稿只在点「确定」时落盘，未确定前切页要提示。
- `SkuDetailDialog` 只传 `:item` + `v-model:visible`；行内入口是 24px 方形按钮 `SkuDetailTrigger`，别改回小圆点。
- 「添加SKU」是唯一手动录入入口：唯一标识按 `MANUAL-0001` 递增并跳过屏蔽清单用过的标识，库存与销量按公斤录入（公斤系数 = 1）。
- 计划层的写入口（批量补货 / 行内采纳 / 撤销 / 下单页撤销）统一调 `schedulePlanPersist()`；到货只经订单弹窗「补登记到货」落账（正常到仓以导入的生产入库为准），`receivedQty` 由 receipts 求和派生，不要直接写。

## 4. 文档索引与手验清单

| 域 | 文档 | 改完手验 |
| --- | --- | --- |
| **滚动备货总纲（先读这一篇）** | [滚动备货策略.md](./docs/功能说明/滚动备货策略.md) | 从 `docs/测试数据/滚动导入演示` 连续导入 day-01 → day-02 → day-03：同一批货按「已安排 → 生产中 → 在仓」迁移时预计库存不跳；每次导入后自动弹出「SKU 数据变动」 |
| 面板 / 表格 / 导入 / 弹窗 | [前端视图与交互.md](./docs/功能说明/前端视图与交互.md) | 主面板 ↔ 采购下单 / 销售表来回切，筛选、展开、勾选与「需安排」草稿都在；导入一次 5 张分表能预览并确认 |
| 分表清洗与单位换算 | [数据清洗规则.md](./docs/功能说明/数据清洗规则.md) | 导出的总表 / 销售表行数与列名对得上；缺出码率的码单位 SKU 被剔除 |
| 模式 / 系数 / 评分 / 分级 | [模式与系数设置.md](./docs/功能说明/模式与系数设置.md) | 设置页改系数点「确定」后主面板模式、系数、预警随之变化；SKU 弹窗评分与「评分」列一致 |
| 采购下单 / 缸规则 / 到货 | [采购下单流程.md](./docs/功能说明/采购下单流程.md) | 需安排（= 待下单列表）→ 拆单 → 确认下单 → 到货；缸数与公斤单向换算；下单历史能看到批次；导入 `docs/测试数据/滚动导入演示` 的 day-01→03，看 `已安排 → 生产中 → 在仓` 迁移时预计库存不跳 |
| 持久化 / 种子 / 快照 | [数据持久化方案.md](./docs/功能说明/数据持久化方案.md) | 刷新页面数据还在；「设置 → 数据 → 本机数据存储」有快照与占用；清空后回到种子 |
| 主面板大表性能 | [主面板性能优化.md](./docs/功能说明/主面板性能优化.md) | 3 万行级筛选与滚动不卡；虚拟列表滚动位置切页回来不变 |
| Windows 离线桌面版 | [离线打包说明.md](./docs/功能说明/离线打包说明.md) | `npm run build` 产物仍是 `/kucunyujing/` 前缀；`npm run pack:win:dir` 启动后 origin 为 `app://kucunyujing`，切页与刷新数据都在；覆盖 `resources/web` 后数据仍在 |
| 改了什么 | [开发迭代记录.md](./docs/功能说明/开发迭代记录.md) | 每次功能改动追加一节，写明需求编号与验证方式 |

`需求文档/需求文档1.X.md` 是需求原文，与实现冲突时**以实现和 `功能说明/` 为准**。

## 5. 维护本文件

- 新增约束先判断归属：能落进 §4 某个域的文档就写文档，本文件只留跨域、容易被反复改错的硬约束。
- 单条约 1–2 行；写长了说明细节该进文档。目标 ≤ 150 行。
