# 给 VSCode 编程 Agent 的施工说明（UI 移植专用）

> 用法：在 VSCode 里把这份文件 `@` 给 Agent，然后只贴下面「开场三句话」。
> 这份文件本身是约束，不要让它改这份文件。

---

## 开场三句话（复制这段发给 Agent）

```
读 docs/prototype/handoff/vscode-prompt.md，按里面的规则做。
这次只改「界面长什么样」，不改「算什么、存什么」。
第 1 批做完先停，把 diff 和截图给我看，我确认后再继续下一批。
```

---

## 0. 一句话原则

**只改 template 结构与 CSS；`<script setup>` 里的计算、写入、持久化一行都不许动。**

不是「尽量不动」，是「动了就停下来说明理由」。

---

## 1. 先读，别猜

按顺序读完再动手：

| 文件 | 你要从里面拿什么 |
|---|---|
| `AGENTS.md` | 项目硬约束，尤其「只有需安排可编辑」「口径只有一份」「不该改的目录」 |
| `docs/prototype/handoff/config/README.md` | 尺寸数值、行为验收清单、禁止清单 |
| `docs/prototype/index.html` | DOM 层级、class 命名、分组方式（**只参考结构**） |
| `docs/prototype/styles.css` | 尺寸 / 间距 / 字号 / 颜色（**可以照抄数值**） |
| `docs/prototype/app.js` | 交互时序（**只读逻辑，禁止照抄写法**） |
| `docs/prototype/FEATURES.md` | 逐条验收清单（93 条） |

**原型不是目标架构，是设计稿。** 它用 `innerHTML` 拼串、全局函数、写死的假数据，这些都不许进 `.vue`。

---

## 2. 边界：什么算「只改界面」

### 允许（不需要问）

- 改 `<template>` 的标签层级、包裹元素、class 名
- 改 `<style scoped>`、`src/assets/*.css` 里的样式；新增只用于展示的 CSS 类
- 把一串重复的展示结构抽成子组件（纯展示、props 进、不写 store）
- 用已有的 store getters / computed 组装展示内容（**只读**）
- 用 `v-if` / `v-show` / `:class` 表达状态（状态本身来自现有数据）
- 用 `ElButton` / `ElDialog` 等已有组件的 `type` / `size` / 插槽调整外观

### 禁止（碰了就算翻车）

| 目录 / 文件 | 为什么 |
|---|---|
| `src/stocking/**`（含 `config.json`、`engine.js`、`scoring.js`、`spuGrades.js`、`validate.js`、`defaults.js`） | 备货口径唯一一份 |
| `src/cleaning/**`、`tools/cleaning/engine.mjs` | 清洗口径唯一一份 |
| `src/purchase/{resolve,validate,vat}.js` | 下单口径 / 缸规则 / 选项回退唯一一份 |
| `src/utils/inventory.js`、`src/utils/skuHealth.js` | 行计算与评分因子 |
| `src/stores/**` 的数据形状 | 改字段会连带炸导入 / 导出 / 持久化 |
| `vite.config.js` 的写盘中间件 | 开发态靠它回写 `config.json` / `settings.json` |
| `tools/**` | 构建依赖与校验脚本 |
| 任何 `npm install` / 升级依赖 | ECharts 5 → 6、Element Plus 版本差异会连锁 |

### 灰区（必须先停下来问，不许自己决定）

1. **要新增一个有状态的交互**（例如「未保存」脏点、需安排草稿预演、撤销/重做）——这需要动 script。
2. **要删掉或改名项目里的按钮**（例如把「配置信息」+「下单设置」合并成「设置」）——这要改路由与 `src/data/panels.js`，还和 `AGENTS.md` 写死的 5 个入口冲突。
3. **要换组件**（例如 `ElTable` → 手写 `div` 表格，或 `ElInputNumber` → 原生 `input`）。
4. **要改 ECharts option**（原型是 5.5.1，项目是 6.x，option 结构有差异）。
5. **原型里有的东西项目里没有**（或反过来）——不要凭原型补功能，先问。

提问格式固定为：

```
【需确认】<一句话说清要改什么>
- 为什么界面不改它就出不来：
- 涉及文件：
- 只改样式能不能绕过去：能 / 不能（不能的话，最小改动是什么）
```

---

## 3. 分四批，一批一停

每批**最多 2 个文件**，做完停下等确认。禁止「顺手把下一批也改了」。

### 第 1 批：底座 + 导航

- 文件：`src/assets/base.css`、`src/components/PanelNavigation.vue`
- 做什么：补齐设计令牌（`--industrial-*` 不要改名）、导航项间距/下划线/右侧辅助入口的对齐
- 不许：改 `src/data/panels.js` 的入口数量（合并导航属灰区，先问）
- 验收：5 个路由都能点，标题不换行，1280 宽不挤；`npm run build` 通过

### 第 2 批：主面板

- 文件：`src/views/InventoryPanelView.vue`
- 做什么：预警图标尺寸梯度、需安排输入区、列宽、工具栏按钮顺序、右下角「屏蔽选中」按钮外观
- 重点：`AGENTS.md` 写明**只有「需安排」可编辑**，其余列必须是纯文本；`SkuDetailTrigger` 是 24px 方形卡片，不许改回 ⓘ
- 危险点：虚拟滚动用 `VirtualList`，改行高必须同步 `item-height`，否则滚动错位
- 验收：FEATURES 1–30 + 81–82；表格能滚到底、粘性表头不飘

### 第 3 批：设置页

- 文件：`src/views/ConfigView.vue`（主）、`src/components/ScoringSettings.vue`、`src/components/SpuGradeSettings.vue`
- 做什么：左栏固定宽度不折叠、只读表格 + 表格右下角单一「编辑」、弹窗表单、分档阈值链（`≥ 阈值` 那套）
- **开工前必须先问**：设置页是否合并成一个（原型已合并成「一个壳、两个域」）？回复「不合并」就只统一两页各自的外观。
- 验收：FEATURES 31–50 + 83–86 + 92–93

### 第 4 批：弹窗与下单页

- 文件：`src/components/SkuOrderEditor.vue`、`src/views/PurchaseOrderView.vue`、`src/components/SkuDetailDialog.vue`
- 做什么：分订单表去边框、缸数/公斤列对齐、合计行、双 ECharts 图
- 危险点：`SkuOrderEditor.vue` 是主面板弹窗与 `/purchase` **共用**，改完两处都要看；缸数换算只能调 `planOrderQuantity`，页面不许重算
- 验收：FEATURES 51–80

---

## 4. 每批的自检命令（跑完把输出贴出来）

```bash
git diff --stat                      # 只应出现本批允许的文件
npm run build                        # 必须通过
node tools/check-stocking.mjs        # 输出必须与改动前逐字一致
```

`check-stocking.mjs` 输出任何一行变化 = 你动了计算，立即回滚并说明。

---

## 5. 视觉验收

每批至少给两张截图（1280 / 1440 宽），并对着 `docs/prototype/handoff/config/shots/` 里的图逐项说「一致 / 不一致（差在哪）」。

不要只说「已完成」，要给出可核对的东西。

---

## 6. 汇报格式（每批固定）

```
第 N 批完成
改动文件：<路径>（+xx / -yy 行）
做了什么：<3 条以内，说人话>
没做什么：<明确列出跳过的项与原因>
需确认：<灰区问题，没有就写「无」>
自检：build 通过 / check-stocking 输出未变 / 截图 2 张
```

---

## 7. 六个最容易翻车的地方（逐条自查）

1. **用 `v-html` 复刻原型**：原型是 `innerHTML` 拼串，Vue 里必须 `v-for` + 事件绑定，否则丢响应式。
2. **把原型的假数据搬进来**：`SCORING_ROWS` / `MODES` / `SEED` 这些是演示数据，项目数据来自 store + `config.json`。
3. **照抄 `app.js` 的全局函数**：原型一个 `openForm()` 管所有弹窗，项目每个弹窗有自己的 props / emit。
4. **结构层级搞错**：原型 `MODES` 是一维数组，项目是 `strategies[0].modes`（自动）/ `strategies[1].modes`（手动），手动 SKU 归属还在 `manualSkus.json`。
5. **改样式时顺手动 script**：最常见。改完 `git diff` 自己看一遍，`<script setup>` 里只要多一行就要解释。
6. **动 Element Plus 的默认行为**：`ElDialog` 的 `v-model:visible`、`ElTable` 的插槽、`VirtualList` 的 `item-height`，改样式不要去改它们的工作方式。

---

## 8. 开工前必须先做（否则不许动手）

```bash
git add -A && git commit -m "wip: 当前业务改动"   # 现在有 15 个未提交文件
git checkout -b feature/ui-prototype
npm run build && node tools/check-stocking.mjs > /tmp/baseline.txt   # 存基线
```

理由：现在工作区混着业务改动和配置改动，样式改动一叠上去，出问题分不清是谁的。
