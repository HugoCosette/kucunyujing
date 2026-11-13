# 前端功能清单（改造验收基准）

这份表是把 `src/views/*.vue`、`src/components/*.vue` 里**已有**的功能逐条列出来，作为界面改造后的验收清单。
改造完成后逐条对照，标记 ✅ 才算没丢功能。

图例：✅ 原型已还原 ｜ 🔧 原型只有视觉/交互演示，真实逻辑在 Vue 层 ｜ ❌ 原型缺失，需补

---

## 一、主面板 `InventoryPanelView.vue`

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 1 | 品名 / 颜色关键字筛选 | `productFilter` / `colorFilter` | ✅ | 保留防抖 |
| 2 | 模式多选筛选（折叠标签） | `ElSelect multiple collapse-tags` | 🔧 | 多选 + 折叠 |
| 3 | 预警状态筛选 chip（含计数） | `warningFilters` + `warningCounts` | ✅ | 计数随数据实时变 |
| 4 | 重置筛选 | `resetFilters` | ✅ | — |
| 5 | 全部展开 / 收起 | `toggleAllProductGroups` | ✅ | 文案随状态切换 |
| 6 | ~~保存 Excel~~（已移除） | — | — | 主面板不再提供导出 |
| 7 | 导入分表（5 张 → 清洗 → 导入） | `triggerSplitImport` | 🔧 | 选多文件 |
| 8 | ~~导入 Excel（总表 + 销售表）~~（已移除） | — | — | 导入只保留「导入分表」入口 |
| 9 | 导入模板下载 | `downloadImportTemplate` | 🔧 | 示例行提示 |
| 10 | 导入进度提示条 | `importToast`（进度条） | ❌ | 顶部浮层 + 进度 |
| 11 | 紧急补货 N → 弹窗（追加量、一键按建议填、提交叠加） | `openUrgentPlanDialog` / `applyAllRecommendedPlans` / `submitUrgentPlans` | 🔧 | 追加而非覆盖 |
| 12 | 本次采购清单 N → 弹窗（生成采购单） | `purchaseList` / `openPurchaseOrder` | 🔧 | 同一 SKU 覆盖 |
| 13 | 行 / 分组 / 全选勾选（全选作用于当前筛选结果） | `toggleSkuSelection` / `toggleGroupSelection` / `toggleSelectAllFiltered` | ✅ | 父行半选态 |
| 14 | 批量补货条 → 确认补货弹窗（覆盖写入） | `batch-restock-bar` / `openRestockDialog` | 🔧 | 覆盖语义 |
| 15 | **需安排占位 = 建议值**（补到正常库存的差额） | `getPlannedPlaceholder` | ✅ | `formatQuantity` 同上限 |
| 16 | **采纳 → 锁定（锁图标）→ 撤销** | `acceptPlannedDraft` / `undoPlannedAcceptance` | ✅ | 锁定后禁编辑 |
| 17 | **填草稿时实时预演该行预警色** | `plannedPreviewTones` | ✅ | 只重算该行 |
| 18 | 需安排写入采购清单 | `applyRestockPlans` | ✅（计数联动） | 真实写入清单 |
| 19 | 预警 5 档（紧急 / 常规 / 正常 / 超库存 / 不参与） | `getUrgency` | ✅ | 色值 + 尺寸梯度 |
| 20 | 分组行显示组内最低档 | — | ✅ | 保留 |
| 21 | 理论库存 / 预计库存 / 日库销比 / 缺口量 / 缺口率 | `calculateInventoryRow` | ✅（近似） | 换成真实计算函数 |
| 22 | 虚拟滚动 + 粘性表头 + 分组表头 | `tableVirtualRows` | ❌ | 千行级必须保留 |
| 23 | 分组展开动画 | `animateProductExpansion` | ❌ | 可保留可去掉 |
| 24 | 空状态 | `inventory-vtable__empty` | ✅ | — |
| 25 | 点击品名行展开/收起 | `handleProductCellClick` | ✅ | — |
| 26 | 点击颜色 → SKU 详情弹窗 | `openSkuDetail` | ✅ | — |
| 81 | **添加 SKU**（基础信息 / 数量 / 动销指标 三组，品名+颜色查重） | `AddSkuDialog.vue` | ✅（新增） | 唯一标识自动生成；月均条数留空按「累积 ÷ 月份」算 |
| 82 | **屏蔽选中**（右下角悬浮按钮，勾选后才亮） | `inventory-hide-fab` | ✅（新增） | 勾品名父行 = 整组屏蔽；屏蔽后行从主面板消失、进入屏蔽列表 |

## 二、销售表 `SalesPanelView.vue`

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 27 | 全列搜索 | `ElInput` 搜索全部列 | 🔧 | 跨列匹配 |
| 28 | 全部展开 / 收起 | `toggleAllProductGroups` | ✅ | — |
| 29 | 两级表头：商品 / 12 个月分组 | `tableColumns` | ✅ | — |
| 30 | 品名 + 颜色固定列（横向滚动不丢上下文） | — | ✅ | `position: sticky` |
| 31 | 月销量 / 累计 / 客户数 / CR5 等数据列 | 见列定义 | ✅（示例值） | 用真实字段 |
| 32 | 分组行汇总（含 CR5 加权而非平均值） | — | ✅ | 口径按原实现 |

## 三、设置 · 备货域 `ConfigView.vue` + `ScoringSettings` / `SpuGradeSettings`

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 33 | 方案切换 | `switchProfile` | 🔧 | 未保存先确认 |
| 34 | 复制为新方案 | `duplicateProfile` | 🔧 | 命名输入框 |
| 35 | 重命名 | `renameProfile` | 🔧 | 同上 |
| 36 | 删除方案（仅剩 1 个时禁用） | `deleteProfile` | 🔧 | 禁用条件必须保留 |
| 37 | 导出方案 JSON / 导入 JSON | `exportConfig` / `importConfig` | 🔧 | 解析失败提示 |
| 38 | 恢复默认 | `restoreDefaults` | 🔧 | 二次确认 |
| 39 | 撤销 / 重做 / 放弃 / 保存 | `undo` / `redo` / `discardChanges` / `confirmConfig` | ✅ | 无改动时禁用 |
| 40 | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 快捷键（输入框内不劫持） | `handleHistoryShortcut` | ✅ | 弹窗打开时不触发 |
| 41 | 自动 / 手动策略切换 | `activeStrategy` | ✅ | — |
| 42 | 模式列表（区间 + 命中数） | `activeModeKey` / `modeOptions` | ✅ | 命中数实时算 |
| 43 | 模式名称 / 阈值编辑 | `mode.min` 等 | ✅（弹窗） | 红线 < 正常 < 峰值 校验 |
| 44 | 系数表（黑白 / 彩色 × 红 / 正 / 峰） | `stockingCoefficients` | ✅ | 单位进表头 |
| 45 | 手动模式增删改 + 手动 SKU 清单 | `manualModes` / 手动清单 | ✅ | 内置项不可删；勾选后批量恢复自动；行为**只有**「自定系数 / 订单货」两种（#76 已删「排除」） |
| 46 | 销量加权 3 项 + 合计校验 | `weights` | ✅ | 不等于 100 时禁用保存 |
| 47 | 健康度评分 5 维 × 三档区间 + 编辑弹窗 | `ScoringSettings` | ✅ | 三档排成一条轴，只填 2 个共用分界值；落 Vue 时写回 from/to，不重叠校验由分界值从左到右递增保证 |
| 48 | SPU 分级 6 档 + 编辑弹窗 | `SpuGradeSettings` | ✅ | 末档兜底、阈值递减；与评分共用同一套「阈值 + 单位」录入 |
| 49 | 保存前整体校验（错误逐条提示） | `validation` | ✅ | 状态标签显示待修正项数 |
| 50 | 离开未保存提示 | `ElMessageBox.confirm` | ❌ | 必须保留 |

## 四、SKU 详情弹窗 `SkuDetailDialog.vue`

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 51 | 基本信息条（模式 / 加权月销量 / 系数 / 累积条数） | `meta-strip` | ✅ | — |
| 52 | 5 维健康度评分 + 总分档位 | `DIM_SCORES` | ✅ | — |
| 53 | 月度销量图（条数柱 + 重量折线，双 Y 轴） | `buildChartOption` | ✅ ECharts | 保留 ECharts |
| 54 | 月度订单数图（默认折叠） | `buildOrderChartOption` | ✅ ECharts | 折叠状态按原实现 |
| 55 | 自动 / 手动策略切换 + 手动系数 + 保存策略 | `skuStrategy` | ✅ | 仅手动可保存 |
| 56 | 无重量数据时隐藏右轴 | `hasWeightData` | ❌ | 必须保留 |
| 57 | 弹窗销毁时 ECharts dispose | `disposeChart` | ✅ | 防内存泄漏 |

## 五、设置 · 下单域 `PurchaseSettingsView.vue`

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 61 | 染厂清单增删改 + 启用开关 | `factories` | ✅（弹窗） | 停用不影响历史订单 |
| 62 | 从 Excel 导入染厂 / 分类 | `pickImportFile` | 🔧 | 只补名单，不动启用状态 |
| 63 | 树形分类 + 分单人员多选 | `categories` | ✅（弹窗） | 人员来自员工名录 |
| 64 | SKU 可选染厂约束 + 搜索 | `skuConfigs` | ✅（弹窗 + 搜索） | 未列出的走全部启用染厂 |
| 65 | 单套设置：放弃 / 确定（独立于备货方案） | `discard` / `confirm` | ✅ | 两个域各自保存 |
| 66 | 导入 / 导出设置文件 | `pickSettingsFile` / `exportSettings` | 🔧 | 解析失败提示 |
| 67 | 删除二次确认（含影响提示） | `ElMessageBox.confirm` | ✅ | 染厂需提示受影响订单数 |
| 68 | 分区级未保存标记 | — | ✅ | 左栏打点，标出改动来源 |
| 83 | **缸规则表**（规则名 / 区间与动作 / 生效品名 / 操作） | `VatRuleSettings.vue` | ✅（新增） | 一档一行「≤ 200 每缸 60 公斤」，同档多段用 wrap 排开 |
| 84 | **默认规则 + 品名绑定**（搜索、批量套用、清空筛选、每行下拉、不取整） | `defaultRuleId` / `spuVatRules` | ✅（新增） | 未绑定的品名走默认；`__none__` = 不取整 |
| 85 | **缸规则编辑弹窗**（判定依据 / 零头处理 / 补缸阈值 / 至少几缸 / 多档阈值可增删 / 试算） | `validateVatRules` | ✅（新增） | 上限必须递增、末档无上限；试算结果要即时 |
| 86 | **分单人员表**（独立于树形分类的扁平名单） | `people` | ✅（新增） | 移除人员不影响历史分订单里的姓名 |

## 六、采购下单 `PurchaseOrderView.vue` + `SkuOrderEditor.vue`

改版目标：**一屏两张表**，不再是「卡片列表 + 表单堆」。

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 69 | 待下单 SKU 清单（品名·颜色 / 需安排 / 已下单） | `purchaseList` | ✅（表格） | 原为 64px 卡片，改 31px 行；`VirtualList` 的 `item-height` 要同步改，虚拟滚动**不能丢** |
| 70 | 清单搜索 + 只看未下单 | `keyword` / `onlyUnordered` | ✅ | 筛选后选中项被过滤掉要自动落到第一条 |
| 71 | 分订单表：染厂（可手输）/ 分单人员 / 缸数 / 数量 / 备注 | `SkuOrderEditor` | ✅ | 控件静止时无边框，hover / focus 才显框 |
| 72 | 缸数 ↔ 公斤双向联动 | `handleVatCountChange` / `handleQuantityChange` | ✅ | 改一个只回写另一个，不整体重渲染（会丢焦点） |
| 73 | 缸规则建议 + 「按建议添加」 | `planOrderQuantity` | ✅ | 只在分订单为空时出现；点击替换成一张建议单 |
| 74 | 合计行与差额状态（一致 / 超出 / 还差） | `totalTone` / `totalHint` | ✅ | 三色：绿 / 红 / 补货黄 |
| 75 | 清空分订单（二次确认） | `clearCurrentOrders` | ✅ | 无分订单时按钮禁用 |
| 76 | 顶部 5 项统计（SKU / 需安排 / 已下单 / 缸数 / 待下单） | `stats` | ✅ | 数字随分订单实时变 |
| 77 | 空状态（采购清单为空） | `purchase-empty` | 🔧 | 回主面板的入口要保留 |
| 78 | 左右连接件（选中行 → 右侧明细的扇形） | — | ✅（新增） | 高度 = 右侧面板高度 25%；窄口固定 31px 行高、垂直居中于选中行（开口中心由 clip-path 像素值保证，贴顶/贴底时整体夹回）；配色左（标签端）深 → 右（面板端）浅至透明；**left/width 由实测缝隙计算（不写死）**，右端只多 1px，用面板背景色覆盖面板左边框那 1px，边框断开且不溢进面板；跟随滚动/切行/搜索/resize 重算；`pointer-events: none` |
| 79 | 顶部「未下单」可点 = 只看未下单 | — | ✅（新增） | 与勾选框同一状态，两个入口互相同步 |
| 80 | 未填数量的分订单行压灰 | — | ✅（新增） | 只选了厂、数量还是 0 的行，文字降到 #96a2a9 |

> `SkuOrderEditor` 是**主面板「采购清单」弹窗与 `/purchase` 共用**的组件。改它的表格样式会同时影响主面板，两处都要回归。

## 七、屏蔽列表 `HiddenSkusView.vue` + `HiddenSkusPanel.vue`

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 87 | 按品名分组的屏蔽记录（可折叠、整组屏蔽打标、子行显示颜色 + SKU） | `hidden` / `countHiddenSkus` | ✅（新增） | 分组头勾选 = 整组选中；整组屏蔽时子行不可单独选 |
| 88 | 搜索 / 全选 / 选中计数 | — | ✅（新增） | 搜索后全选只作用于筛选结果 |
| 89 | 解除（单个 SKU / 单个品名 / 选中批量 / 全部） | `restoreSku` / `restoreGroup` / `restoreSelected` / `restoreAll` | ✅（新增） | 全部解除要二次确认 |
| 90 | 导航角标 = 被屏蔽 SKU 数 | `page-navigation-badge` | ✅（新增） | 整组屏蔽按当前数据里该品名的 SKU 数展开 |

## 八、全局

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 58 | 顶部导航：主面板 / 销售表 / 采购下单 / 设置 | `PanelNavigation` | ✅ | 主组 4 项；「下单设置」与「配置信息」合并为**一个**「设置」页（一个壳、两个域） |
| 92 | 设置壳：左栏两组（备货配置 / 下单配置），工具条随所点分区切换 | `ConfigView` + `PurchaseSettingsView` | ✅（合并） | 备货域 = 方案下拉 + 撤销/重做 + 放弃/保存；下单域 = 导入/导出 + 放弃/确定；两域各有独立「未保存」状态与分区脏点 |
| 93 | 右列宽度随域变化（备货 860 / 下单 1040） | — | ✅（合并） | 缸规则表列多，切到下单域才放宽 |
| 91 | 导航右侧辅助入口「屏蔽列表」+ 红色角标 | `utilityNavEntries` | ✅（新增） | 角标为 0 时隐藏 |
| 59 | ~~示例数据提示 / 示例面板 / 示例配置~~（已移除） | — | — | 项目 #74 删除 `/example`，导航只留主面板一组；原型同步删除，不要再加回 |
| 60 | 设计令牌（industrial 变量） | `base.css` | ✅ | 不要覆盖成第三方蓝 |

---

## 这次实测掉的功能（已修）

1. 需安排占位写成「待填」，应是**建议值**（正常库存 − 预计库存）。
2. 采纳后没有**锁定**状态，也就没有**撤销**。
3. 填草稿时行内预警色不预演，只在采纳后才变。
4. 顶部「紧急补货 / 采购清单」是写死的 36 / 12，不跟数据走。
5. 缺口量出现小数（`-1,742.571`），原实现是整数。
6. 采纳按钮只有 hover 才出现，截图看像被删掉了。

## 验收方法

改造完在 Vue 里逐条走查本表：任一条从 ✅ 变 ❌ 就是回归，必须补回或说明原因。
计算口径一律调用 `src/stocking` / `src/utils/inventory.js`，原型里的近似算法只用于摆演示数据。
