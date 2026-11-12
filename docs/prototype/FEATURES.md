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
| 6 | 保存 Excel | `exportInventoryToExcel` | 🔧 | 导出当前视图（含父行） |
| 7 | 导入分表（5 张 → 清洗 → 导入） | `triggerSplitImport` | 🔧 | 选多文件 |
| 8 | 导入 Excel（总表 + 销售表） | `triggerImportExcel` | 🔧 | 选多文件 |
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

## 二、销售表 `SalesPanelView.vue`

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 27 | 全列搜索 | `ElInput` 搜索全部列 | 🔧 | 跨列匹配 |
| 28 | 全部展开 / 收起 | `toggleAllProductGroups` | ✅ | — |
| 29 | 两级表头：商品 / 12 个月分组 | `tableColumns` | ✅ | — |
| 30 | 品名 + 颜色固定列（横向滚动不丢上下文） | — | ✅ | `position: sticky` |
| 31 | 月销量 / 累计 / 客户数 / CR5 等数据列 | 见列定义 | ✅（示例值） | 用真实字段 |
| 32 | 分组行汇总（含 CR5 加权而非平均值） | — | ✅ | 口径按原实现 |

## 三、配置页 `ConfigView.vue` + `ScoringSettings` / `SpuGradeSettings`

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
| 45 | 手动模式增删改 + 手动 SKU 清单 | `manualModes` / 手动清单 | ✅ | 内置项不可删；勾选后批量恢复自动 |
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

## 五、下单设置 `PurchaseSettingsView.vue`

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

## 六、全局

| # | 功能 | 原实现 | 原型 | 落 Vue 要求 |
|---|---|---|---|---|
| 58 | 顶部导航（主面板 / 销售表 / 采购下单 / 设置） | `PanelNavigation` | ✅ | 设置内含备货与下单两个域 |
| 59 | 示例数据提示「请勿修改」 | `.example-hint` | ✅ | 保留 |
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
