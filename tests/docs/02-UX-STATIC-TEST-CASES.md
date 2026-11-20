# 采购下单系统 · 体验与静态走查用例

**范围**：无法用纯函数单元测试覆盖的部分——UI 交互防线、文档一致性、边界防御、持久化、构建。
**方式**：源码走查 + 文档对照 + 构建验证。执行日期 2026-11-20。
**结论口径**：PASS=符合设计/文档；OBSERVE=设计取舍或低风险观察，不算缺陷；FAIL=真实缺陷。

---

## 1. 构建与工程健康

### UX-01 · 生产构建通过 [P0] — PASS
- **执行**：`npm run build`
- **结果**：✓ built in 7.22s，无报错
- **观察**：存在 chunk >500KB 警告（index 761KB / echarts 相关），为性能提示非功能缺陷 → OBSERVE(P3)

## 2. 文档与实现一致性

### UX-02 · 小批量补单规则：文档 vs 代码默认 vs 实际配置 [P3] — **FAIL（文档缺陷）**
- **对照**：
  - 文档 §4.3：`小批量补单 = ≤50 不下单 · 51 公斤以上每缸 60 公斤`
  - 代码默认 `createDefaultVatRules()`：`≤50 skip / 51+ 每缸60(ladder60)`
  - 实际 `settings.json`：`≤50 skip / 51–100 fixed 60 / >100 round 10`
- **影响**：同一 need=150，代码默认算 180 公斤、实际配置算 150 公斤。文档描述与实际配置口径不符，照文档配置会与生产数据不一致。
- **建议**：更新文档 §4.3 与 §4.4，说明实际配置为三段（skip/fixed/round），或统一代码默认与实际配置。
- **证据**：`node` 对照脚本输出（见执行记录）。

## 3. UI 交互防线（订单弹窗 PurchaseOrderRecordsDialog.vue）

### UX-03 · 到货超收防护 [P1] — PASS（UI 层）
- **走查**：`confirmReceive()` 校验 `amount > pending + 1e-9` 时警告并拦截；输入框 `:title` 显示上限，"待收"数字可点整单到齐。
- **断言**：界面路径下无法超收。

### UX-04 · store 层超收防护缺失 [P2] — OBSERVE
- **走查**：`stores/purchase.js receiveOrder()` 仅校验 `amount>0`，未校验 `amount <= 该单待收`；超收防护完全依赖 UI 弹窗。
- **影响**：当前仅弹窗一处调用，实际不可触发；但属"防线单一"，若未来增加调用入口（批量到货/API/快捷键）可写入超收数据，破坏"累积下单=待收+到货"不变量。
- **建议**：在 store 层补一道 `amount <= quantity - receivedQty` 校验作为兜底。
- **判定**：非当前功能缺陷（现网不可触发），记为防御性改进建议 P2。

### UX-05 · 恢复到货超量防护 [P1] — PASS
- **走查**：UI `handleRestoreReceipt()` 与 store `restoreReceipt()` 双重校验 `received + qty <= quantity`，防止改小下单量后恢复导致超收。

### UX-06 · 二次确认覆盖 [P1] — PASS
- **走查**：撤回到货、删除到货、删除待收、改单、撤销整单（已有到货时）均有 `ElMessageBox.confirm`；改单用 `inputValidator` 校验不小于已到货；撤销整单保留流水不物理删除。

### UX-07 · 已收齐单据登记区隐藏 [P2] — PASS
- **走查**：`isSettled()`（待收≤0）为真时隐藏输入框与登记按钮，显示"已收齐"绿签，符合文档 §3.4。

### UX-08 · 撤回记录灰显可恢复 [P2] — PASS
- **走查**：撤回记录 `.is-voided` 划线灰显，按钮切"恢复"，`voidedAt/restoredAt` 留痕；hover/键盘聚焦才浮现操作按钮，触屏常显。

## 4. 下单页编辑器（SkuOrderEditor.vue）

### UX-09 · 缸数⇄公斤硬换算 [P1] — PASS
- **走查**：`handleVatCountChange()` 公斤=缸数×缸型；`handleQuantityChange()` 仅整缸回填缸数，非整缸留空并给相邻档提示（面板版按文档不显示行内提示，由 `variant` 控制）。

### UX-10 · 进面板自动带建议单去重 [P2] — PASS
- **走查**：`seededSkus` 每 SKU 只带一次；`deletedSkus` 记录用户清空，避免删完立刻又长出新单；`autoSeed=false` 供筛选回落关闭预填。符合文档 §3.7。

### UX-11 · 删除/撤销两段式确认 [P2] — PASS
- **走查**：分订单删除、下单列表撤销均"点一次变确认、再点执行"，点别处取消，符合文档手感。

## 5. 持久化

### UX-12 · 落盘与 flush [P1] — PASS
- **走查**：`commitOrders` 防抖 400ms 落盘、`pagehide` flush；`saveOrders` 返回 `persisted:false` 时 `ElMessage.error` 提示，不再静默丢单。需安排/锁态/撤销快照存 IndexedDB，刷新保留。符合文档 §7。

---

## 缺陷清单（本次走查）

| ID | 级别 | 类型 | 标题 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-001 | P3 | 文档 | 小批量补单规则文档描述与实际配置不一致（need=150 时 180 vs 150 公斤） | Open |

## 观察项（非缺陷）

| ID | 级别 | 标题 |
| --- | --- | --- |
| OBS-001 | P2 | store 层 receiveOrder 缺超收兜底校验（当前 UI 已拦，防线单一） |
| OBS-002 | P3 | 构建产物 chunk >500KB 警告（性能提示） |
