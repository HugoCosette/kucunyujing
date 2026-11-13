# 配置页展示层改造 · 交接说明

> 交给编程 Agent 前请连同本目录的 `shots/` 一起给。**先读第 5 节「禁止改动」，再动手。**

## 0. 一句话

把 `/config`（`src/views/ConfigView.vue` + `ScoringSettings.vue` + `SpuGradeSettings.vue`）的**外观**改成截图的样子；
计算逻辑、配置结构、数据流一律不动。

---

## 1. 目标态在哪

原型一共三个文件，**三个都要给，但用法不同**：

| 文件 | 用途 | 怎么用 |
|---|---|---|
| `../../index.html`（原型根目录） | 页面结构 | **可以读**：DOM 层级、class 命名、哪些元素成组。抄结构，不抄标签细节 |
| `../../styles.css` | 视觉规格 | **可以抄**：尺寸、间距、字号、颜色、圆角。搬进 SFC 的 `<style scoped>` 时加前缀防污染 |
| `../../app.js` | 交互时序 | **只读逻辑，不要抄写法**。它是 `innerHTML` 拼串 + 全局函数，不是 Vue |
| 本目录 `shots/*.png` | 验收基准 | 15 张（9 个分区 + 5 个弹窗 + 1 张未保存态），改完一张一张对 |

深链（本地直接打开，比看截图信息量大）：

```
index.html?screen=config&panel=strategy
index.html?screen=config&panel=weights
index.html?screen=config&panel=scoring&dialog=scoring
index.html?screen=config&panel=spu&dialog=spu
index.html?screen=config&panel=vat
index.html?screen=config&panel=factories
index.html?screen=config&panel=people
index.html?screen=config&panel=categories
index.html?screen=config&panel=sku-factories

> 设置页已合并为一个壳：左栏「备货配置」4 项 + 「下单配置」5 项，工具条随所点分区切换。
> 旧的 `?screen=purchase-settings` 深链仍可打开（自动落到缸规则）。
```

### 抄什么、不抄什么（照抄会坏在哪）

| 原型里的写法 | 不要照搬 | Vue 里应该 |
|---|---|---|
| `el.innerHTML = rows.map(...).join('')` | `v-html` 拼串 | `v-for` + 模板，事件用 `@click` |
| 全局单例 `openForm({...})` + `formSpec` 闭包 | 一个全局弹窗函数 | `ElDialog` + `ref` 草稿对象 + computed 校验 |
| `SCORING_ROWS[i].low/mid/high` 扁平数组 | 自建一份区间数据结构 | 读 `config.scoring.dimensions[key].ranges`，提交写回同一结构 |
| `MODES` 一维数组 | 在组件里 `const MODES = [...]` | `config.strategies[0].modes`（自动）/ `[1].modes`（手动，SKU 归属在 `manualSkus.json`） |
| `NB-193#KC-0021`、`hits: 5` 等写死值 | 留在组件里当默认值 | 全部来自 store / `evaluate*` 的返回值 |

> 一句话：**原型的 HTML 和 CSS 是资产，原型的 JS 只是一份「交互说明书」。**

---

## 2. 截图里「看起来只是排版」但其实有行为的部分

这 6 处是上一轮改造里最容易在移植时丢掉的，逐条对照：

| 位置 | 现象 | 真实行为 | 原型实现位置 |
|---|---|---|---|
| 顶部状态标签 | `已保存` / `未保存` / `待修正 N 项` 三种文字与配色 | 由草稿是否脏、整体校验结果驱动，不是固定文案 | `refreshConfigState()` |
| 左栏分区 | 标题后一个黄点（`state-dirty.png` 里「销量加权 ●」） | 只标**本次改过**的分区，保存后清除 | `markDirty(section)` / `.rail__item.is-dirty` |
| 撤销 / 重做 | 两个图标按钮 | 无历史时**禁用**，不是隐藏；上限 50 步 | `pushHistory()` / `undo()` / `redo()` |
| 「编辑」按钮 | 每个表格右下角一个 | 全页唯一编辑入口，表内**不允许**出现输入框 | `data-edit` 事件委托 |
| 弹窗打开瞬间 | 不显示红字 | 首次打开**不拦截**；输入后才即时校验并禁用「确定」 | `validateForm(false)` |
| 评分弹窗 | 一条轴、两个分界框 | 相邻两档**共用**同一个分界值，提交时再展开成 `from/to` | `bandBar()` / `bandOrder()` |

---

## 3. 视觉规格（照这个抄，别自己发挥）

**令牌**：全部用 `src/assets/base.css` 里已有的 `--industrial-*`，不要新造颜色。
主色 `#3f718d`、危险 `#b84f48`、补货 `#c49a52`、正常 `#829a85`、超库存 `#8e7a91`、网格 `#aab6be`、圆角 3px。

**布局**

| 项 | 值 |
|---|---|
| 左栏宽度 | `196px`，**固定不折叠**，页面 `min-width: 900px`（不要加媒体查询改成一栏） |
| 右列滚动 | 只有右列滚动，页面本身不滚（`#screen-config .page` 撑满高度） |
| 内容限宽 | `.config-panels { max-width: 860px }`，表格**不铺满**全屏（截图右侧留白是有意的） |
| 左栏分组 | 两组：备货配置（4 项）/ 下单配置（3 项），每组带小标题与 `meta` 数字 |

**表格**

| 项 | 值 |
|---|---|
| 表头 | 高 `27px`，背景 `--industrial-header`，`11.5px / 600`，左对齐 |
| 单元格 | 高 `36px`，`12px`，数字列右对齐、等宽数字 |
| 边框 | 外框 `--industrial-grid`，内部 `--line-soft` |
| 表尾 | 表格下方同一行：左侧说明文字（`11px` 灰），右侧一个 `btn btn--sm`，**右缘与表格右缘对齐** |

**按钮**

| 项 | 值 |
|---|---|
| 表格编辑 | `btn btn--sm`，文案「编辑」或「新增」 |
| 行内操作 | 24px 方形图标，固定最后一列，顺序：铅笔 → 垃圾桶；内置项垃圾桶置灰 |
| 顶部 | 左：方案下拉 + 状态标签；右：撤销 / 重做 / 放弃（文字按钮）/ 保存（主色） |

**输入**

| 项 | 值 |
|---|---|
| 数字 | `.num-field`：高 `28px`，右对齐、等宽数字，单位在**灰底后缀**里（`#eef2f4`），隐藏原生 spinner |
| 阈值 | 同 `.num-field`；单位提到列头或行名后，**行内不重复写单位** |
| 弹窗宽度 | 常规 `560px`；宽表 `780px`；两级表单 `480px`；确认框 `430px` |

**分档刻度条**（评分弹窗核心，别退回成 6 个输入框）

```
grid-template-columns: 1fr 64px 1fr 64px 1fr;
段高 28px，文字 11px 居中
低 #edf2ee / #4b6650      中 #f7f2e7 / #7d6330      高 #f8ecea / #8f4a44
分界框 64px 宽、白底、数字居中
零宽档位用淡斜纹 + title「该档区间为空，不会命中」
```

---

## 4. 配置页必须保留的行为（逐条验收）

| # | 行为 | 验收动作 |
|---|---|---|
| 1 | 方案切换 | 切方案时若有未保存改动，先弹确认 |
| 2 | 复制 / 重命名 / 删除方案 | 仅剩 1 个方案时删除按钮禁用 |
| 3 | 导出 / 导入方案 JSON | 解析失败要有提示 |
| 4 | 恢复默认 | 二次确认 |
| 5 | 撤销 / 重做 / 放弃 / 保存 | 无改动时三者禁用 |
| 6 | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | 光标在输入框内、弹窗打开时不触发 |
| 7 | 自动 / 手动策略切换 | 切回自动时手动改动不丢 |
| 8 | 模式列表 | 显示区间 + **实时命中数** |
| 9 | 模式编辑 | 红线 < 正常 < 峰值 校验 |
| 10 | 系数表 | 单位进表头，不在每个格子里写 |
| 11 | 手动模式增删改 + 手动 SKU | 内置项不可删；勾选后批量恢复自动 |
| 12 | 销量加权 | 合计 ≠ 100 时禁用「确定」（见 `dialog-weights-error.png`） |
| 13 | 健康度评分 | 5 维 × 3 档 + 权重合计 100 |
| 14 | SPU 分级 | 6 档严格递减，末档兜底 |
| 15 | 染厂清单 | 启用开关；删除二次确认；停用不影响历史订单 |
| 16 | 分类与分单人员 | 标签式增删、去重、非空校验 |
| 17 | SKU 可选染厂 | 搜索；未维护 = 全部染厂可选 |
| 18 | 保存前整体校验 | 错误逐条列出，状态标签显示「待修正 N 项」 |
| 19 | 离开未保存提示 | 路由离开前拦截 |
| 20 | 弹窗键盘 | Esc 关闭、Enter 提交、打开时不报错 |

---

## 5. 禁止改动

**文件**

- `src/stocking/**`（`engine.js` / `scoring.js` / `spuGrades.js` / `validate.js` / `config.json`）
- `src/cleaning/**`、`tools/cleaning/engine.mjs`
- `src/purchase/resolve.js`、`src/purchase/validate.js`
- 文件清单以 `git status` 为准。示例面板 / 示例配置已于迭代记录 #74 删除（`/example`、`EXAMPLE_PANEL` 都不在了），
  导航右侧现在只有「屏蔽列表」，没有「示例数据，请勿修改」分组——**不要再把这些加回来**

**写法**

- 不许在组件里另写一份区间判定 / 系数回退 / 方案解析——口径只在上面那几个文件里。
- 不许把假数据写进组件（原型里的 `NB-193#KC-0021` 之类是演示数据）。
- 不许把表格改成 `ElTable` 内联编辑；配置页**全部只读展示 + 弹窗编辑**。
- 不许给 `base.css` 的令牌改名或删变量（其他页面在用）。

---

## 6. 分步实施（每步都能独立回滚）

先做前置（**必须**，当前工作区有 20+ 个未提交改动，不能混进去）：

```bash
git add -A && git commit -m "wip: 业务改动存档"
git checkout -b feature/config-ui
npm run build
```

| Step | 改哪里 | 内容 | 完成标志 |
|---|---|---|---|
| 1 | `ConfigView.vue` 的 `<style>` | 左栏固定 196px、内容限宽 860、表格/按钮/表尾样式 | 4 个分区（策略与模式 / 销量加权 / 健康度评分 / SPU 分级）外观与截图一致 |
| 2 | `ConfigView.vue` 模板 | 一个壳两组（备货 4 + 下单 5）、只读表格、表尾单一按钮、两条工具条按域切换 | 点击左栏能切，工具条跟着换，脏点能亮 |
| 3 | `ScoringSettings.vue` | 分档刻度条（`bandBar`）、得分/分档行 | 5 行 × 2 框，权重合计实时变色 |
| 4 | `SpuGradeSettings.vue` | 三列阈值表，单位进列头 | 6 行对齐，递减校验生效 |
| 5 | 回归 | 逐条走第 4 节 20 项 | 全部通过再提交 |

每步结束：`npm run build` → 浏览器点一遍 → `git commit`。不要把 5 步并成一个提交。

---

## 7. 三个需要人拍板的差异（**先问，别自己决定**）

1. **评分区间口径变了**
   原实现：三档区间两端都含，重叠时按 中 → 高 → 低 取第一条（`AGENTS.md` 有记录）。
   新原型：三档排成一条连续轴，相邻两档共用分界值，分界值归中风险。
   若采用，需同步改 `AGENTS.md`、`docs/功能说明/模式与系数设置.md`，并迁移存量 `config.json`。

2. **「预估月消耗」默认值有空档**
   现为 `low[null,0] / mid[0,0] / high[0,null]`，中档宽度 0，永远不命中（截图里 `= 0 条`、斜纹标注）。
   属 `config.json` 业务默认值问题，需业务给一个真实区间。

3. **控件用 Element Plus 还是原生**
   原型是原生 `input`（像素可控）；项目现有代码用 `ElInputNumber`。
   建议保留 El 组件、只覆盖样式，避免丢无障碍与校验。

---

## 8. 提交前自检

- [ ] 左栏在 1280 / 1440 宽都不折叠，右列独立滚动
- [ ] 任何表格里都点不出输入框
- [ ] 未改动任何 `src/stocking/**`（`git status` 自查）
- [ ] 关掉浏览器重进，配置仍能读回（持久化没被破坏）
- [ ] 顶部导航仍是 5 主 + 右侧「屏蔽列表」，没有冒出示例入口
