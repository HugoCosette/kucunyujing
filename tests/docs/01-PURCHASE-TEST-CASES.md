# 采购下单系统 · AAA 测试用例（核心业务逻辑）

**项目**：kucunyujing1.1（布料库存与采购预警系统）
**权威来源**：本文档是测试用例的唯一真实来源；`TEST-EXECUTION-TRACKING.csv` 只记状态。
**执行方式**：`node tests/unit/core-logic.test.mjs`（81 条自动化用例）；体验/静态项人工走查。
**AAA 规范**：每条用例含 准备(Arrange) → 执行(Act) → 断言(Assert)，任何工程师可直接复现。
**版本**：1.0 / 2026-11-20

---

## 测试范围与两大核心问题

系统核心价值（据 `采购下单流程.md`）：把主面板「需安排」定准后，采购下单页解决两件事：

- **Q1 给谁下单**：按 SKU 解析可选染厂、分单人员、树形分类（选项口径）
- **Q2 下多少**：按品名缸规则把精准公斤折算成整缸数量（缸规则引擎）

围绕这两点 + 支撑链路（订单聚合、颜色口径、库存计算、数据归一化、下单历史、真实数据完整性）设计用例。

**优先级定义**：P0=阻断/资金或数据错误；P1=核心功能错误；P2=重要体验；P3=文档/边界体验；P4=锦上添花。

---

## A. 下多少 —— 缸规则换算（src/purchase/vat.js）

规则基准「标准大货补单 vr-standard」：0–120→补80 / 121–200→补160 / 201以上→每缸240就近取整。

### TC-A01 · need=20 补到 80 [P0]
- **Arrange**：载入 vr-standard 规则，need=20
- **Act**：`planOrderQuantity(20, STANDARD)`
- **Assert**：`rounded=80`、`vatCount=1`、`action='fixed'`

### TC-A02 · need=100 补到 80 [P0]
- **Arrange**：vr-standard，need=100 → **Act**：换算 → **Assert**：`rounded=80`

### TC-A03 · 边界 need=120 归前段补 80 [P1]
- **Arrange**：need=120（档上限，两端都算）→ **Act**：换算 → **Assert**：`rounded=80`

### TC-A04 · 边界 need=121 进后段补 160 [P1]
- **Arrange**：need=121 → **Act**：换算 → **Assert**：`rounded=160`

### TC-A05 · need=200 补到 160 [P1] · TC-A06 · need=201 每缸240一缸 [P1]
- **Assert**：A05 `rounded=160`；A06 `rounded=240,vatCount=1,kgPerVat=240`

### TC-A07 · need=300 余量舍弃 [P1] · TC-A08 · need=360 余量=半缸补一缸 [P1] · TC-A09 · need=500 [P1]
- **Assert**：A07 `240`；A08 `480,vatCount=2`；A09 `480`

### TC-A10 · need=3371 大数取整 [P1]
- **Assert**：`rounded=3360`、`vatCount=14`（余 11 公斤舍弃）

### TC-A11 · need=0 → skip [P0] · TC-A12 · need 负数按 0 [P2]
- **Assert**：`rounded=0`、`action='skip'`

### TC-A13 · vat 动作每缸100 need=250 就近→300 [P1] · TC-A14 floor→200 [P1] · TC-A15 ceil need=210→300 [P1]
### TC-A16 · round 整百 need=155→200 [P2] · TC-A17 · skip 档 need≤50→0 [P1]
### TC-A18 · 多缸型 ladder need=100→80 [P2] · TC-A19 · 正好一半取大 need=120→160 [P2]
### TC-A20 · 无缸型 ladder 原量下单带警告 [P2]
- **Assert**：`rounded=300` 且 `warnings` 非空

---

## B. 下多少 —— 规则解析与继承（vat.js）

### TC-B01 · SKU 绑定优先 SPU [P1] · TC-B02 · SPU 优先默认 [P1] · TC-B03 · 未绑定用默认 [P1]
### TC-B04 · 显式 __none__ 不取整 [P1] · TC-B05 · 无规则回落第一条 [P2]
- **Assert**：返回对应规则 id / null

### TC-B06 · 分档边界 120→档0、121→档1 [P1]
### TC-B07 · 下拉候选仅单缸重量 [P1]
- **Assert**：`[80,160,240]`

### TC-B08 · 缸型归一化去重升序去非正 [P2] · TC-B09/B10/B11 · 规则校验（末档无上限/上限递增/ladder有缸型）[P2]
- **Assert**：非法配置返回对应 error 消息

---

## C. 给谁下单 —— 染厂/人员/分类（src/purchase/resolve.js）

### TC-C01 · 启用染厂过滤停用项 [P1] · TC-C02 · SKU 配染厂只列启用中 [P1]
### TC-C03 · SKU 配的染厂全停用→回退全部启用 [P1] · TC-C04 · 未配染厂回退全部 [P1]
### TC-C05 · 分类覆盖优先导入分类 [P1] · TC-C06 · 无覆盖用导入分类 [P1]
### TC-C07 · 分类有人员只列分类人员 [P1] · TC-C08 · 分类无人员回退全部 [P1]
### TC-C09 · 按 id 找染厂 [P2] · TC-C10 · 按名称找染厂 [P2]

---

## D. 订单聚合 —— 累积下单/待收/到货（resolve.js）

基准订单：X 有 active(800,到300)+active(200,到0)+cancelled(500)；Y active(100,到100)。

### TC-D01 · 作废单不进聚合：X 累积下单=1000 [P0]
### TC-D02 · 待收=累积下单−到货=700 [P0] · TC-D03 · 到货累计=300 [P0]
### TC-D04 · 张数=2（作废不计）[P1] · TC-D05 · 收齐 SKU 待收=0 [P1] · TC-D06 · 无订单返回空 [P2]
### TC-D07 · summarizeOrders 只统计 quantity>0 [P1]

---

## E. 下单数量颜色口径（src/purchase/fillTone.js）

### TC-E01 未下单 idle [P2] · TC-E02 <80% low [P2] · TC-E03 正好80% ok [P2] · TC-E04 100% ok [P2]
### TC-E05 超一缸内 ok [P1] · TC-E06 超一缸 err [P1] · TC-E07 无缸型超出即 err [P2] · TC-E08 planned=0 有填量 ok [P2]

---

## F. 库存计算与建议（src/utils/inventory.js）

### TC-F01 · 预计库存=理论+待收+到货+锁定需安排 [P0]
- **Arrange**：warehouse100, ordered800, received300, planned100 → **Act**：计算 → **Assert**：`projectedStock=1000`

### TC-F02 · 不变量 累积下单=待收+到货 [P0]
### TC-F03 · 到货不改变预计库存（只挪 received）[P0]
- **Assert**：received 300→500（planned 不变），`projectedStock` 恒为 1000

### TC-F04 · 建议需安排=max(0,ceil(正常−理论−累积下单)) [P1] · TC-F05 已覆盖→0 [P1] · TC-F06 不参与备货→0 [P2]

---

## G. 数据归一化与迁移（src/purchase/validate.js）

### TC-G01 · receivedQty 由 receipts 派生不信任外部值 [P0]
- **Arrange**：外部 receivedQty=999，receipts=300(+撤回100) → **Assert**：`receivedQty=300`

### TC-G02 · 空白订单丢弃 [P1] · TC-G03 · 运行态保留空白草稿 [P2]
### TC-G04 · v1 map 迁移为 active 流水 [P1]
### TC-G05 · 重复染厂按名去重 [P2] · TC-G06 · 分类人员须在总名单 [P2] · TC-G07 · 非法规则绑定丢弃 [P2]

---

## H. 下单历史（src/purchase/history.js）

### TC-H01 · 作废单不进账，批次合计=1000 [P1] · TC-H02 · 作废数=1 [P2]
### TC-H03 · 批次号 PO-YYYYMMDD-01 [P2] · TC-H04 · 默认筛选排除作废 [P1]
### TC-H05 · 全部状态保留作废行但合计不变 [P1] · TC-H06 · 关键词命中 [P2]

---

## I. 真实数据完整性探索（tests/unit/explore-real-data.mjs）

### TC-I01 · 67 条真实订单可正常归一化 [P0]
### TC-I02 · 无超收/缺染厂/receivedQty 不符 [P0]
### TC-I03 · 聚合无负待收 [P0] · TC-I04 · orderIndex 与 history 按 SKU 合计一致 [P0]
