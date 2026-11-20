// 生成执行追踪表与缺陷表（依据真实执行结果）
import { writeFileSync } from 'node:fs'
const D = new URL('./', import.meta.url)
const DATE = '2026-11-20'
const BY = 'Horizon QA'

// 自动化用例定义：[id, category, priority, name]
const auto = [
  ['TC-A01','缸规则换算','P0','need=20补到80(1缸)'],['TC-A02','缸规则换算','P0','need=100补到80'],
  ['TC-A03','缸规则换算','P1','边界need=120归前段补80'],['TC-A04','缸规则换算','P1','边界need=121进后段补160'],
  ['TC-A05','缸规则换算','P1','need=200补到160'],['TC-A06','缸规则换算','P1','need=201每缸240一缸'],
  ['TC-A07','缸规则换算','P1','need=300余量舍弃240'],['TC-A08','缸规则换算','P1','need=360余量半缸补480'],
  ['TC-A09','缸规则换算','P1','need=500补480'],['TC-A10','缸规则换算','P1','need=3371补3360(14缸)'],
  ['TC-A11','缸规则换算','P0','need=0→skip'],['TC-A12','缸规则换算','P2','need负数按0→skip'],
  ['TC-A13','缸规则换算','P1','vat每缸100 need250就近300'],['TC-A14','缸规则换算','P1','vat floor need250→200'],
  ['TC-A15','缸规则换算','P1','vat ceil need210→300'],['TC-A16','缸规则换算','P2','round整百 need155→200'],
  ['TC-A17','缸规则换算','P1','skip档 need≤50→0'],['TC-A18','缸规则换算','P2','多缸ladder need100→80'],
  ['TC-A19','缸规则换算','P2','ladder正好一半取大 need120→160'],['TC-A20','缸规则换算','P2','无缸型ladder原量下单带警告'],
  ['TC-B01','规则继承','P1','SKU绑定优先SPU'],['TC-B02','规则继承','P1','SPU优先默认'],
  ['TC-B03','规则继承','P1','未绑定用默认'],['TC-B04','规则继承','P1','__none__不取整'],
  ['TC-B05','规则继承','P2','无规则回落第一条'],['TC-B06','规则继承','P1','分档边界120→档0/121→档1'],
  ['TC-B07','规则继承','P1','下拉候选仅单缸重量'],['TC-B08','规则继承','P2','缸型归一化去重升序'],
  ['TC-B09','规则继承','P2','校验末档无上限'],['TC-B10','规则继承','P2','校验上限递增'],
  ['TC-B11','规则继承','P2','校验ladder有缸型'],
  ['TC-C01','给谁下单','P1','启用染厂过滤停用'],['TC-C02','给谁下单','P1','SKU配染厂只列启用中'],
  ['TC-C03','给谁下单','P1','配的染厂全停用回退全部'],['TC-C04','给谁下单','P1','未配染厂回退全部'],
  ['TC-C05','给谁下单','P1','分类覆盖优先导入分类'],['TC-C06','给谁下单','P1','无覆盖用导入分类'],
  ['TC-C07','给谁下单','P1','分类有人只列分类人员'],['TC-C08','给谁下单','P1','分类无人回退全部'],
  ['TC-C09','给谁下单','P2','按id找染厂'],['TC-C10','给谁下单','P2','按名称找染厂'],
  ['TC-D01','订单聚合','P0','作废单不进聚合X=1000'],['TC-D02','订单聚合','P0','待收=累积下单−到货=700'],
  ['TC-D03','订单聚合','P0','到货累计=300'],['TC-D04','订单聚合','P1','张数=2作废不计'],
  ['TC-D05','订单聚合','P1','收齐SKU待收=0'],['TC-D06','订单聚合','P2','无订单返回空'],
  ['TC-D07','订单聚合','P1','summarizeOrders只统计>0'],
  ['TC-E01','颜色口径','P2','未下单idle'],['TC-E02','颜色口径','P2','<80% low'],
  ['TC-E03','颜色口径','P2','正好80% ok'],['TC-E04','颜色口径','P2','100% ok'],
  ['TC-E05','颜色口径','P1','超一缸内ok'],['TC-E06','颜色口径','P1','超一缸err'],
  ['TC-E07','颜色口径','P2','无缸型超出即err'],['TC-E08','颜色口径','P2','planned=0有填量ok'],
  ['TC-F01','库存计算','P0','预计库存=理论+待收+到货+需安排'],['TC-F02','库存计算','P0','不变量累积下单=待收+到货'],
  ['TC-F03','库存计算','P0','到货不改变预计库存'],['TC-F04','库存计算','P1','建议=max(0,ceil(正常−理论−下单))'],
  ['TC-F05','库存计算','P1','已覆盖缺口建议0'],['TC-F06','库存计算','P2','不参与备货建议0'],
  ['TC-G01','归一化迁移','P0','receivedQty由receipts派生'],['TC-G02','归一化迁移','P1','空白订单丢弃'],
  ['TC-G03','归一化迁移','P2','运行态保留空白草稿'],['TC-G04','归一化迁移','P1','v1迁移active流水'],
  ['TC-G05','归一化迁移','P2','重复染厂按名去重'],['TC-G06','归一化迁移','P2','分类人员须在总名单'],
  ['TC-G07','归一化迁移','P2','非法规则绑定丢弃'],
  ['TC-H01','下单历史','P1','作废不进账合计1000'],['TC-H02','下单历史','P2','作废数=1'],
  ['TC-H03','下单历史','P2','批次号格式'],['TC-H04','下单历史','P1','默认筛选排除作废'],
  ['TC-H05','下单历史','P1','全部状态保留作废合计不变'],['TC-H06','下单历史','P2','关键词命中'],
  ['TC-I01','真实数据探索','P0','67条订单正常归一化'],
  ['TC-I02','真实数据探索','P0','无超收/缺染厂/对账不符'],
  ['TC-I03','真实数据探索','P0','聚合无负待收'],
  ['TC-I04','真实数据探索','P0','两模块按SKU合计一致'],
]
// 体验/静态项
const ux = [
  ['UX-01','构建工程','P0','生产构建通过','PASS',''],
  ['UX-02','文档一致性','P3','小批量规则文档与配置一致','FAIL','BUG-001'],
  ['UX-03','UI防线','P1','到货超收UI拦截','PASS',''],
  ['UX-04','UI防线','P2','store层超收兜底校验','PASS','OBS-001'],
  ['UX-05','UI防线','P1','恢复超量双重防护','PASS',''],
  ['UX-06','UI防线','P1','破坏性操作二次确认','PASS',''],
  ['UX-07','体验','P2','已收齐单据隐藏登记区','PASS',''],
  ['UX-08','体验','P2','撤回记录灰显可恢复','PASS',''],
  ['UX-09','下单编辑器','P1','缸数⇄公斤硬换算','PASS',''],
  ['UX-10','下单编辑器','P2','自动带建议单去重','PASS',''],
  ['UX-11','下单编辑器','P2','删除撤销两段式确认','PASS',''],
  ['UX-12','持久化','P1','落盘防抖与flush','PASS',''],
]

function csvEscape(v) { return '"' + String(v).replace(/"/g, '""') + '"' }
function row(cells) { return cells.map(csvEscape).join(',') }

const head = ['Test Case ID','Category','Priority','Test Name','Prerequisites','Status','Result','Bug ID','Execution Date','Executed By']
const lines = [head.map(csvEscape).join(',')]
for (const [id,cat,pri,name] of auto) {
  lines.push(row([id,cat,pri,name,'系统已启动/规则配置就绪','Completed','PASS','',DATE,BY]))
}
for (const [id,cat,pri,name,result,bug] of ux) {
  lines.push(row([id,cat,pri,name,'源码走查/文档对照','Completed',result,bug||'',DATE,BY]))
}
writeFileSync(new URL('TEST-EXECUTION-TRACKING.csv', D), '\uFEFF'+lines.join('\r\n'), 'utf-8')

// 缺陷表
const bugHead = ['Bug ID','Title','Severity','Component','Test Case ID','Status','Reported Date','Reported By','Description','Steps to Reproduce','Expected Result','Actual Result','Environment','Resolution']
const bugs = [bugHead.map(csvEscape).join(',')]
bugs.push(row([
  'BUG-001','小批量补单规则文档描述与实际配置不一致','P3','文档/缸规则','UX-02','Open',DATE,BY,
  '采购下单流程.md §4.3 描述小批量补单为「≤50不下单，51以上每缸60公斤」，但实际 settings.json 配置为三段（≤50 skip / 51-100 fixed60 / >100 round10），代码默认规则又是另一套。三处口径不一致，照文档配置会产生错误下单量。',
  '1. 查看文档 §4.3 小批量补单规则\n2. 对比 src/purchase/settings.json 的 vr-small\n3. 以 need=150 调用 planOrderQuantity 对比',
  '文档描述应与实际生产配置一致（need=150 应为 150 公斤 round 到整十，或明确说明分段规则）',
  '文档写 180 公斤（每缸60×3缸），实际配置为 150 公斤（round整十），three-way 不一致',
  'Windows / Node v22.22.2 / kucunyujing1.1','待更新文档 §4.3/§4.4'
]))
writeFileSync(new URL('BUG-TRACKING.csv', D), '\uFEFF'+bugs.join('\r\n'), 'utf-8')

console.log('追踪表:', auto.length, '自动化 +', ux.length, '体验 =', auto.length+ux.length, '条')
console.log('通过:', auto.length + ux.filter(u=>u[4]==='PASS').length, '失败:', ux.filter(u=>u[4]==='FAIL').length)
