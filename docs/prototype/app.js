/* ============================================================
   库存储备看板 · 界面调整原型
   纯静态演示：不改动 src/stocking、src/cleaning 的任何计算逻辑
   ============================================================ */

/* ---------------- 演示数据 ---------------- */
const INVENTORY = [
  {
    product: '挪威网',
    grade: 'S+',
    children: [
      { mode: '热销', color: '1#黑色', tone: 'urgent', planned: 1200, producing: 3443, backorder: 280, weekly: 940, warehouse: 3217, inTransit: 3443 },
      { mode: '热销', color: '2#本白', tone: 'normal', planned: 0, producing: 2612, backorder: 130, weekly: 1220, warehouse: 4366, inTransit: 2612 },
      { mode: '常规', color: '193#浅咖', tone: 'replenish', planned: 600, producing: 1735, backorder: 260, weekly: 1160, warehouse: 2871, inTransit: 1735 },
      { mode: '常规', color: '88#玉米色', tone: 'overstock', planned: 0, producing: 2253, backorder: 0, weekly: 1220, warehouse: 1758, inTransit: 2253 },
      { mode: '常规', color: '4#浅杏', tone: 'normal', planned: 0, producing: 1124, backorder: 0, weekly: 650, warehouse: 1607, inTransit: 1124 },
    ],
  },
  {
    product: '40D涤安',
    grade: 'S',
    children: [
      { mode: '常规', color: '1001#黑色（固色）', tone: 'replenish', planned: 400, producing: 1150, backorder: 270, weekly: 650, warehouse: 750, inTransit: 1150 },
      { mode: '常规', color: '46#杏色', tone: 'normal', planned: 0, producing: 2403, backorder: 120, weekly: 1160, warehouse: 6829, inTransit: 2403 },
      { mode: '热销', color: '57#朱红（固色）', tone: 'urgent', planned: 900, producing: 1129, backorder: 200, weekly: 740, warehouse: 2099, inTransit: 1129 },
      { mode: '常规', color: '2#本白', tone: 'normal', planned: 0, producing: 141, backorder: 0, weekly: 540, warehouse: 483, inTransit: 141 },
    ],
  },
  {
    product: '40D锦安',
    grade: 'A',
    children: [
      { mode: '常规', color: '6001#黑色（固色）', tone: 'normal', planned: 0, producing: 771, backorder: 0, weekly: 860, warehouse: 1742, inTransit: 771 },
      { mode: '热销', color: '87#米黄S', tone: 'urgent', planned: 1500, producing: 4907, backorder: 0, weekly: 1280, warehouse: 5212, inTransit: 4907 },
      { mode: '常规', color: '25#酒红（固色）', tone: 'replenish', planned: 200, producing: 472, backorder: 30, weekly: 440, warehouse: 1371, inTransit: 472 },
      { mode: '按量', color: '6#浅兰', tone: 'normal', planned: 0, producing: 435, backorder: 0, weekly: 360, warehouse: 1096, inTransit: 435 },
      { mode: '按量', color: '49#浅兰', tone: 'overstock', planned: 0, producing: 354, backorder: 20, weekly: 780, warehouse: 825, inTransit: 354 },
    ],
  },
  {
    product: '涤复丝瑞士网',
    grade: 'B',
    children: [
      { mode: '常规', color: '1#黑色', tone: 'normal', planned: 0, producing: 1044, backorder: 0, weekly: 1350, warehouse: 3627, inTransit: 1044 },
      { mode: '热销', color: '163#浅米黄', tone: 'replenish', planned: 300, producing: 619, backorder: 200, weekly: 780, warehouse: 981, inTransit: 619 },
      { mode: '按量', color: '5#中灰', tone: 'overstock', planned: 0, producing: 510, backorder: 270, weekly: 900, warehouse: 713, inTransit: 510 },
      { mode: '尾货', color: '2#本白-大条', tone: 'none', planned: 0, producing: 40, backorder: 50, weekly: 440, warehouse: 155, inTransit: 40 },
    ],
  },
  {
    product: '9090网布',
    grade: 'C',
    children: [
      { mode: '按量', color: '1#黑色', tone: 'replenish', planned: 260, producing: 482, backorder: 290, weekly: 1020, warehouse: 628, inTransit: 482 },
      { mode: '尾货', color: '12#米白', tone: 'none', planned: 0, producing: 0, backorder: 0, weekly: 40, warehouse: 96, inTransit: 0 },
      { mode: '滞销', color: '33#深灰', tone: 'none', planned: 0, producing: 0, backorder: 0, weekly: 12, warehouse: 42, inTransit: 0 },
    ],
  },
]

const TONES = {
  urgent: { label: '紧急', dot: 'urgent' },
  replenish: { label: '需补货', dot: 'replenish' },
  normal: { label: '正常', dot: 'normal' },
  overstock: { label: '过剩', dot: 'overstock' },
  none: { label: '不参与', dot: 'none' },
}

function toneCounts() {
  const counts = { all: 0, urgent: 0, replenish: 0, normal: 0, overstock: 0, none: 0 }
  INVENTORY.forEach((group) =>
    group.children.forEach((child) => {
      const draft = child.draft === undefined ? undefined : Number(child.draft) || 0
      const tone = derive(child, draft).tone
      counts.all += 1
      if (tone in counts) counts[tone] += 1
    }),
  )
  return counts
}

// 顶部两个计数跟着表格走：紧急补货 = 红色行，采购清单 = 已采纳行
function syncCounts() {
  const counts = toneCounts()
  const urgent = $('#urgentCount')
  const purchase = $('#purchaseCount')
  if (urgent) urgent.textContent = String(counts.urgent)
  if (purchase) {
    const accepted = INVENTORY.reduce(
      (sum, group) => sum + group.children.filter((child) => Number(child.planned) > 0).length,
      0,
    )
    purchase.textContent = String(accepted)
  }
  renderToneFilters()
}

const MODES = [
  {
    key: 'hot',
    name: '热销',
    min: 30,
    metric: 'days',
    hits: 5,
    participates: true,
    split: true,
    rows: [
      { color: '黑白', redLine: 20, normal: 40, peak: 60 },
      { color: '彩色', redLine: 15, normal: 30, peak: 45 },
    ],
  },
  {
    key: 'normal',
    name: '常规',
    min: 10,
    metric: 'days',
    hits: 9,
    participates: true,
    split: true,
    rows: [
      { color: '黑白', redLine: 15, normal: 30, peak: 45 },
      { color: '彩色', redLine: 10, normal: 20, peak: 30 },
    ],
  },
  {
    key: 'bulk',
    name: '按量',
    min: 3,
    metric: 'stock',
    hits: 4,
    participates: true,
    split: false,
    rows: [
      { color: '黑白', redLine: 40, normal: 80, peak: 200 },
      { color: '彩色', redLine: 40, normal: 80, peak: 120 },
    ],
  },
  { key: 'tail', name: '尾货', min: 0.01, metric: 'none', hits: 2, participates: false, split: false, rows: [] },
  { key: 'slow', name: '滞销', min: 0, metric: 'none', hits: 1, participates: false, split: false, rows: [] },
]

// 评分区间用 from / to 存数，展示文案由 rangeText() 生成，避免显示串与数值两套数据。
// 三档在弹窗里按数值从小到大排成一条「分档刻度条」，只填两个分界值，相邻两档共用。
let SCORING_ROWS = [
  { key: 'cr5', label: '客户数 CR5', unit: '%', weight: 15, low: { from: 0, to: 40 }, mid: { from: 40, to: 60 }, high: { from: 60, to: null } },
  { key: 'customers', label: '累计客户数', unit: '个', weight: 10, low: { from: 21, to: null }, mid: { from: 11, to: 20 }, high: { from: 0, to: 10 } },
  { key: 'mom', label: '销售环比率', unit: '%', weight: 20, low: { from: 10, to: null }, mid: { from: -10, to: 10 }, high: { from: null, to: -10 } },
  { key: 'inout', label: '本次进销比', unit: '%', weight: 30, low: { from: 0, to: 20 }, mid: { from: 20, to: 30 }, high: { from: 30, to: null } },
  { key: 'consumption', label: '预估月消耗', unit: '条', weight: 25, low: { from: null, to: 0 }, mid: { from: 0, to: 0 }, high: { from: 0, to: null } },
]

// 三档得分与综合分档，评分弹窗与 SKU 弹窗共用
let SCORING_SCORES = { low: 80, mid: 60, high: 40 }
let SCORING_TOTAL = { midFrom: 50, midTo: 70 }

let SPU_GRADES = [
  { key: 'splus', label: 'S+', tone: 'splus', min: 2500, count: 1 },
  { key: 's', label: 'S', tone: 's', min: 300, count: 2 },
  { key: 'a', label: 'A', tone: 'a', min: 100, count: 0 },
  { key: 'b', label: 'B', tone: 'b', min: 30, count: 1 },
  { key: 'c', label: 'C', tone: 'c', min: 1, count: 1 },
  { key: 'z', label: 'Z', tone: 'z', min: null, count: 0 },
]

// 下单配置：主数据。原型里直接落数组，落到 Vue 时对应 src/purchase/settings.json
// 行为三选一：自定系数 / 排除 / 订单货（订单货按客户订单填量，不参与预警与评分）
const MANUAL_BEHAVIORS = [
  { value: 'custom', label: '自定系数', hint: '给每个 SKU 单独指定系数' },
  { value: 'exclude', label: '排除', hint: '不参与备货策略，不计预警' },
  { value: 'order', label: '订单货', hint: '按客户订单填量，不参与预警与评分' },
]

let MANUAL_MODES = [
  { id: 'mm-custom', name: '自定模式', behavior: 'custom', desc: '人工指定红线 / 正常 / 峰值', participates: true, builtin: true, redLine: 20, normal: 40, peak: 60 },
  { id: 'mm-slow', name: '滞销模式', behavior: 'exclude', desc: '不参与备货策略，不计预警', participates: false, builtin: true },
  { id: 'mm-order', name: '订单货模式', behavior: 'order', desc: '按客户订单填量，不参与预警与评分', participates: false, builtin: true },
]

let MANUAL_SKUS = [
  { id: 'NB-193#KC-0021', product: '挪威网', color: '193#浅咖', modeId: 'mm-custom', redLine: 20, normal: 40, peak: 60 },
  { id: '9090-33#SH-0014', product: '9090网布', color: '33#深灰', modeId: 'mm-slow' },
]

let FACTORIES = [
  { id: 'f1', name: '江苏恒泰染整', enabled: true, orders: 12 },
  { id: 'f2', name: '绍兴越新印染', enabled: true, orders: 8 },
  { id: 'f3', name: '福建华源纺织', enabled: true, orders: 5 },
  { id: 'f4', name: '广东锦丰染厂', enabled: false, orders: 0 },
]

const STAFF_POOL = ['张伟', '李四', '王芳', '赵敏', '陈立', '孙倩']

let PEOPLE = [
  { id: 'p1', category: '涤纶网布', people: ['张伟', '李四', '王芳'] },
  { id: 'p2', category: '锦纶网布', people: ['张伟', '赵敏'] },
  { id: 'p3', category: '交织网布', people: ['陈立'] },
  { id: 'p4', category: '瑞士网', people: ['王芳', '孙倩'] },
]

let SKU_FACTORIES = [
  { id: 'NB-193#KC-0021', product: '挪威网', color: '193#浅咖', category: '涤纶网布', factories: ['江苏恒泰染整', '绍兴越新印染'] },
  { id: '9090-33#SH-0014', product: '9090网布', color: '33#深灰', category: '锦纶网布', factories: ['福建华源纺织'] },
  { id: '40D-87#MH-0007', product: '40D锦安', color: '87#米黄S', category: '瑞士网', factories: ['绍兴越新印染', '福建华源纺织'] },
]

// —— 缸规则：一条规则 = 一组「上限 → 每缸公斤」档位，挂在品名（SPU）上 ——
// action: fixed 固定每缸公斤；skip 不取整（按原样下单）
let VAT_RULES = [
  {
    id: 'v1',
    name: '标准大货补单',
    bandKey: 'planned',
    remainder: 'nearest',
    threshold: 0.5,
    minVats: 1,
    bands: [
      { upTo: 200, action: 'fixed', value: 60 },
      { upTo: 600, action: 'fixed', value: 100 },
      { upTo: null, action: 'vat', value: 200 },
    ],
  },
  {
    id: 'v2',
    name: '小批量试单',
    bandKey: 'planned',
    remainder: 'ceil',
    threshold: 0.5,
    minVats: 1,
    bands: [
      { upTo: 300, action: 'fixed', value: 50 },
      { upTo: null, action: 'fixed', value: 100 },
    ],
  },
]
let VAT_DEFAULT_RULE = 'v1'
// 品名 → 规则 id；没写进这里的品名走默认规则
let VAT_SPU = { 挪威网: 'v1', 巴哈斯: 'v1', '9090网布': 'v2' }

// 分单人员表：扁平名单，与「树形分类」里的人员是同一批人
let PO_PEOPLE_LIST = ['阿婷', '刘玉红', '小凤', '钟秋兰', '刘燕', '小良']

// 屏蔽列表：整组屏蔽（whole）或按 SKU 屏蔽
let HIDDEN_GROUPS = [
  { product: '巴哈斯', whole: false, skus: [{ skuId: 'NB-102#MH-0001', color: '102#玫红' }, { skuId: 'NB-1773#MH-0002', color: '1773#米白' }] },
  { product: '9090网布', whole: true, skus: [{ skuId: '9090-33#SH-0014', color: '33#深灰' }, { skuId: '9090-41#SH-0015', color: '41#浅灰' }] },
  { product: '40D锦安', whole: false, skus: [{ skuId: '40D-25#MH-0006', color: '25#酒红（固色）' }] },
]

const DIM_SCORES = [
  { label: '客户数 CR5', weight: 15, value: '62.0%', score: 60, tier: '中风险', tone: 'mid' },
  { label: '累计客户数', weight: 10, value: '18 个', score: 60, tier: '中风险', tone: 'mid' },
  { label: '销售环比率', weight: 20, value: '+14.2%', score: 80, tier: '低风险', tone: 'low' },
  { label: '本次进销比', weight: 30, value: '26.4%', score: 60, tier: '中风险', tone: 'mid' },
  { label: '预估月消耗', weight: 25, value: '320 条', score: 80, tier: '低风险', tone: 'low' },
]

/* ---------------- 状态 ---------------- */
const state = {
  screen: 'inventory',
  tone: 'all',
  product: '',
  color: '',
  mode: 'all',
  expanded: new Set(['挪威网', '40D涤安', '40D锦安', '涤复丝瑞士网']),
  selected: new Set(),
  activeMode: 'hot',
  weights: { m1: 50, m3: 30, m12: 20 },
  salesExpanded: new Set(['挪威网', '40D涤安', '40D锦安', '涤复丝瑞士网', '9090网布']),
  salesKeyword: '',
  history: [],
  redo: [],
  dirty: false,
  dirtyPanels: new Set(),
  manualSelected: new Set(),
}

/* ---------------- 工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const fmt = (value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString('zh-CN'))
const skuKey = (product, color) => `${product}|${color}`

let toastTimer = 0
function toast(message) {
  const el = $('#toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.hidden = true
  }, 2000)
}

// 原型近似 calculateInventoryRow：理论库存是事实层，预计库存才叠加「需安排」。
function colorCategory(color) {
  return /黑白|黑|本白|米白|灰白/.test(color) ? '黑白' : '彩色'
}

function bandFor(sku) {
  const mode = MODES.find((item) => item.name === sku.mode)
  if (!mode || !mode.participates || !mode.rows.length) return null
  const row = mode.split ? mode.rows.find((item) => item.color === colorCategory(sku.color)) : mode.rows[0]
  if (!row) return null
  // 天数模式：系数（天）× 日销量；按量模式：系数本身就是数量
  const dailySales = sku.weekly / 7
  return mode.metric === 'days'
    ? { red: row.redLine * dailySales, normal: row.normal * dailySales, peak: row.peak * dailySales }
    : { red: row.redLine, normal: row.normal, peak: row.peak }
}

function derive(sku, plannedValue) {
  const planned = plannedValue ?? sku.planned ?? 0
  const theoretical = sku.warehouse + sku.inTransit + sku.producing - sku.backorder
  const projected = theoretical + planned
  const band = bandFor(sku)
  const dailySales = sku.weekly / 7
  const days = band && dailySales > 0 ? projected / dailySales : null
  const shortage = band ? Math.round(band.normal - projected) : null
  const rate = band && band.normal > 0 ? shortage / band.normal : null
  const tone = !band
    ? 'none'
    : projected < band.red
      ? 'urgent'
      : projected < band.normal
        ? 'replenish'
        : projected > band.peak
          ? 'overstock'
          : 'normal'
  // 建议需安排 = 补到正常库存（绿色带中位）的差额
  const suggest = band ? Math.max(0, Math.ceil(band.normal - projected)) : 0
  return { theoretical, projected, days, shortage, rate, tone, suggest, band, planned }
}

function childByKey(key) {
  const [product, color] = key.split('|')
  const group = INVENTORY.find((item) => item.product === product)
  return { group, child: group?.children.find((item) => item.color === color) }
}

// 种子数据按「期望的预警状态」反推库存：保证每个色带都有样本，且建议值与状态自洽
// 只留两行「已采纳」样本（补货后已回到正常带），其余清空需安排，让建议值占位可见
const SEED_ACCEPTED = new Set(['挪威网|193#浅咖', '40D锦安|25#酒红（固色）'])

function normalizeSeed() {
  INVENTORY.forEach((group) => {
    group.children.forEach((child) => {
      const key = `${group.product}|${child.color}`
      const accepted = SEED_ACCEPTED.has(key)
      child.planned = accepted ? child.planned ?? 0 : 0

      const band = bandFor(child)
      if (!band) return

      // 已采纳的行：按「补到正常水位」摆；其余按期望状态摆
      const target = accepted
        ? band.normal * 1.02
        : child.tone === 'urgent'
          ? band.red * 0.72
          : child.tone === 'replenish'
            ? band.red + (band.normal - band.red) * 0.45
            : child.tone === 'overstock'
              ? band.peak * 1.3
              : band.normal + (band.peak - band.normal) * 0.5

      // 由「预计库存 = 目标」反推在仓 / 在途 / 生产中，保证与预警带一致
      const theoretical = Math.max(0, Math.round(target) - child.planned)
      child.producing = Math.round(theoretical * 0.45)
      child.inTransit = Math.round(theoretical * 0.3)
      child.warehouse = Math.max(0, theoretical - child.producing - child.inTransit + child.backorder)
    })
  })
}

/* ---------------- 导航 ---------------- */
function switchScreen(screen) {
  state.screen = screen
  $$('.screen').forEach((el) => {
    el.hidden = el.id !== `screen-${screen}`
  })
  $$('.nav__item').forEach((el) => el.classList.toggle('is-active', el.dataset.screen === screen))
  $('#batchbar').hidden = !(screen === 'inventory' && state.selected.size > 0)
  window.scrollTo({ top: 0 })

  // 采购屏刚显示出来才量得到真实高度；hidden 已置 false，直接读尺寸即可（会强制回流）
  if (screen === 'purchase') syncPoLink()
  if (screen === 'hidden') renderHidden()
}

$$('.nav__item').forEach((btn) => btn.addEventListener('click', () => switchScreen(btn.dataset.screen)))

/* ---------------- 主面板 ---------------- */
const TONE_ITEMS = [
  { key: 'all', label: '全部', dot: '' },
  { key: 'urgent', label: '紧急', dot: 'urgent' },
  { key: 'replenish', label: '需补货', dot: 'replenish' },
  { key: 'normal', label: '正常', dot: 'normal' },
  { key: 'overstock', label: '过剩', dot: 'overstock' },
  { key: 'none', label: '不参与', dot: 'none' },
]

function renderToneFilters() {
  $('#toneFilters').innerHTML = TONE_ITEMS.map(
    (item) => `
    <button class="chip ${state.tone === item.key ? 'is-active' : ''}" data-tone="${item.key}">
      ${item.dot ? `<i class="chip__dot dot--${item.dot}"></i>` : ''}
      ${item.label}
      <span class="chip__count">${toneCounts()[item.key]}</span>
    </button>`,
  ).join('')
}

const INV_COLS = [
  { key: 'select', label: '', w: 38, group: '' },
  { key: 'mode', label: '模式', w: 78, group: '备货判定' },
  { key: 'product', label: '品名', w: 144, group: '商品', left: true },
  { key: 'color', label: '颜色', w: 132, group: '商品', left: true },
  { key: 'urgency', label: '预警', w: 52, group: '商品' },
  { key: 'planned', label: '需安排', w: 152, group: '补货计划' },
  { key: 'producing', label: '生产中', w: 72, group: '补货计划', num: true },
  { key: 'backorder', label: '欠货', w: 64, group: '出货需求', num: true },
  { key: 'weekly', label: '周销量', w: 72, group: '出货需求', num: true },
  { key: 'turnover', label: '周转入', w: 66, group: '库存（公斤）', num: true },
  { key: 'inTransit', label: '在途库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'warehouse', label: '在仓库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'theoretical', label: '理论库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'projected', label: '预计库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'days', label: '日库销比', w: 72, group: '数据反馈', num: true },
  { key: 'shortage', label: '缺口量', w: 76, group: '数据反馈', num: true },
  { key: 'rate', label: '缺口率', w: 72, group: '数据反馈', num: true },
]

function visibleGroups() {
  const product = state.product.toLowerCase()
  const color = state.color.toLowerCase()
  return INVENTORY.map((group) => {
    const children = group.children.filter((child) => {
      if (product && !group.product.toLowerCase().includes(product)) return false
      if (color && !child.color.toLowerCase().includes(color)) return false
      if (state.mode !== 'all' && child.mode !== state.mode) return false
      if (state.tone !== 'all' && child.tone !== state.tone) return false
      return true
    })
    return { ...group, children }
  }).filter((group) => group.children.length > 0)
}

function visibleSkuKeys() {
  return visibleGroups().flatMap((group) => group.children.map((child) => skuKey(group.product, child.color)))
}

function renderInvHead() {
  const groups = []
  INV_COLS.forEach((col) => {
    const last = groups[groups.length - 1]
    if (last && last.group === col.group) last.span += 1
    else groups.push({ group: col.group, span: 1 })
  })

  const band = groups
    .map(
      (group) =>
        `<div class="gt-band__cell ${group.group ? '' : 'gt-band__cell--empty'}" style="grid-column: span ${group.span}">${
          group.group || ''
        }</div>`,
    )
    .join('')

  const cols = INV_COLS.map((col) => {
    if (col.key === 'select') {
      return `<div class="gt-col"><span class="cbx"><input type="checkbox" id="selectAll" aria-label="全选" /><span></span></span></div>`
    }
    return `<div class="gt-col ${col.left ? 'gt-col--left' : ''}">${col.label}</div>`
  }).join('')

  return `<div class="gt-head"><div class="gt-band">${band}</div><div class="gt-cols">${cols}</div></div>`
}

function renderGroupRow(group) {
  const total = group.children.reduce((sum, child) => sum + child.planned, 0)
  const derived = group.children.map((child) => derive(child))
  const sum = (pick) => group.children.reduce((acc, child) => acc + (pick(child) || 0), 0)
  const allSelected = group.children.every((child) => state.selected.has(skuKey(group.product, child.color)))
  const someSelected = group.children.some((child) => state.selected.has(skuKey(group.product, child.color)))
  const open = state.expanded.has(group.product)

  const cells = INV_COLS.map((col) => {
    let content = ''
    if (col.key === 'select') {
      content = `<span class="cbx"><input type="checkbox" data-group-check="${group.product}" ${
        allSelected ? 'checked' : ''
      } ${!allSelected && someSelected ? 'data-indeterminate="1"' : ''} /><span></span></span>`
    } else if (col.key === 'mode') {
      content = `<span class="grade grade--${group.grade.toLowerCase().replace('+', 'plus')}">${group.grade}</span>`
    } else if (col.key === 'product') {
      content = `<span class="name-cell"><span class="caret ${open ? 'is-open' : ''}"><svg viewBox="0 0 12 12" fill="none"><path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="name-cell__text">${group.product}</span></span>`
    } else if (col.key === 'color') {
      content = `<span class="name-cell__text" style="color: var(--industrial-muted); font-weight: 400">${group.children.length} 个颜色</span>`
    } else if (col.key === 'planned') {
      content = total > 0 ? fmt(total) : '—'
    } else if (col.key === 'urgency') {
      const tones = derived.map((item) => item.tone)
      const worst = ['urgent', 'replenish', 'overstock', 'normal', 'none'].find((key) => tones.includes(key)) || 'none'
      content = `<span class="urgency urgency--${worst}" title="组内最低状态：${TONES[worst].label}"><i class="urgency__dot"></i></span>`
    } else if (col.key === 'weekly') {
      content = fmt(sum((child) => child.weekly))
    } else if (['producing', 'backorder', 'inTransit', 'warehouse'].includes(col.key)) {
      content = fmt(sum((child) => child[col.key]))
    } else if (col.key === 'turnover') {
      content = '0'
    } else if (col.key === 'theoretical') {
      content = fmt(derived.reduce((acc, item) => acc + item.theoretical, 0))
    } else if (col.key === 'projected') {
      content = fmt(derived.reduce((acc, item) => acc + item.projected, 0))
    } else {
      content = '—'
    }

    return `<div class="gt-cell ${col.left ? 'gt-cell--left' : ''} ${col.num ? 'gt-cell--num' : ''} ${
      content === '—' && col.num ? 'gt-cell--muted' : ''
    }">${content}</div>`
  }).join('')

  return `<div class="gt-row gt-row--group" data-product="${group.product}">${cells}</div>`
}

function renderChildRow(group, child) {
  const key = skuKey(group.product, child.color)
  // 草稿值参与预演：填了数字就按「填完之后」算预计库存与预警色
  const draft = child.draft === undefined ? undefined : Number(child.draft) || 0
  const d = derive(child, draft)
  const selected = state.selected.has(key)
  const tone = TONES[d.tone]
  const inactive = child.mode === '尾货' || child.mode === '滞销'
  const accepted = Number(child.planned) > 0

  const cells = INV_COLS.map((col) => {
    let content = ''
    if (col.key === 'select') {
      content = `<span class="cbx"><input type="checkbox" data-sku-check="${key}" ${selected ? 'checked' : ''} /><span></span></span>`
    } else if (col.key === 'mode') {
      content = `<span class="mode-text ${inactive ? 'mode-text--manual' : ''}">${child.mode}</span>`
    } else if (col.key === 'product') {
      content = `<span class="name-cell child-name"><span class="name-cell__text" title="${group.product}">${group.product}</span></span>`
    } else if (col.key === 'color') {
      content = `<span class="name-cell" style="justify-content: space-between"><span class="name-cell__text" title="${child.color}">${child.color}</span><button class="info-btn" data-sku="${key}" title="配置信息">i</button></span>`
    } else if (col.key === 'urgency') {
      content = `<span class="urgency urgency--${tone.dot}" title="${tone.label}" aria-label="${tone.label}"><i class="urgency__dot"></i></span>`
    } else if (col.key === 'planned') {
      const suggested = d.suggest > 0 ? d.suggest : ''
      const title = accepted
        ? '已采纳，点击「撤销」后可修改'
        : suggested
          ? `建议填写 ${fmt(suggested)}：补到正常库存（绿色带中位）后的差额，不会自动采纳`
          : '预计库存已达正常水位，无需安排'
      content = `<div class="planned ${accepted ? 'planned--locked' : ''}">
        <input class="planned__input" data-planned="${key}" inputmode="numeric"
          value="${accepted ? fmt(child.planned) : child.draft ?? ''}"
          placeholder="${suggested ? fmt(suggested) : ''}"
          title="${title}" ${accepted ? 'disabled' : ''} />
        ${
          accepted
            ? `<svg class="planned__lock" viewBox="0 0 16 16" fill="none" title="已采纳并锁定">
                 <path d="M4.5 6V4.75a3.5 3.5 0 0 1 7 0V6m-8 0h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm4.5 3v2"
                   stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
               </svg>`
            : ''
        }
        <span class="planned__unit">公斤</span>
        <button class="planned__accept ${accepted ? 'planned__accept--undo' : ''}" data-accept="${key}" ${
          accepted || Number(child.draft) > 0 ? '' : 'disabled'
        }>${accepted ? '撤销' : '采纳'}</button>
      </div>`
    } else if (col.key === 'days') {
      content = inactive || d.days === null ? '—' : d.days.toFixed(1)
    } else if (col.key === 'rate') {
      content = inactive || d.rate === null ? '—' : `${(d.rate * 100).toFixed(0)}%`
    } else if (col.key === 'theoretical') {
      content = fmt(d.theoretical)
    } else if (col.key === 'projected') {
      content = fmt(d.projected)
    } else if (col.key === 'shortage') {
      content = inactive || d.shortage === null ? '—' : fmt(d.shortage)
    } else if (col.key === 'turnover') {
      content = '0'
    } else {
      content = fmt(child[col.key])
    }

    return `<div class="gt-cell ${col.left ? 'gt-cell--left' : ''} ${col.num ? 'gt-cell--num' : ''} ${
      content === '—' ? 'gt-cell--muted' : ''
    }">${content}</div>`
  }).join('')

  return `<div class="gt-row ${selected ? 'is-selected' : ''} ${accepted ? 'gt-row--accepted' : ''}" data-sku-row="${key}" data-tone="${d.tone}">${cells}</div>`
}

// 只重画一行：输入时保留焦点，不整表重建
function refreshRow(key) {
  const rowEl = $(`[data-sku-row="${key}"]`, $('#invTable'))
  const { group, child } = childByKey(key)
  if (!rowEl || !child) return
  rowEl.outerHTML = renderChildRow(group, child)
}

function renderInventory() {
  const groups = visibleGroups()
  const totalSku = groups.reduce((sum, group) => sum + group.children.length, 0)

  $('#invTable').style.setProperty('--cols', INV_COLS.map((col) => `minmax(${col.w}px, ${col.w}fr)`).join(' '))
  $('#invTable').style.width = `max(100%, ${INV_COLS.reduce((sum, col) => sum + col.w, 0)}px)`

  const rows = groups
    .map((group) => {
      const parent = renderGroupRow(group)
      const children = state.expanded.has(group.product)
        ? group.children.map((child) => renderChildRow(group, child)).join('')
        : ''
      return parent + children
    })
    .join('')

  $('#invTable').innerHTML = `${renderInvHead()}<div class="gt-body">${
    groups.length ? rows : '<div class="table-empty">没有匹配的数据</div>'
  }</div>`

  $$('[data-indeterminate="1"]', $('#invTable')).forEach((input) => {
    input.indeterminate = true
  })

  const keys = groups.flatMap((group) => group.children.map((child) => skuKey(group.product, child.color)))
  const selectedCount = keys.filter((key) => state.selected.has(key)).length
  const selectAll = $('#selectAll')
  if (selectAll) {
    selectAll.checked = keys.length > 0 && selectedCount === keys.length
    selectAll.indeterminate = selectedCount > 0 && selectedCount < keys.length
  }

  $('#rowCount').textContent = `${fmt(totalSku)} 行 · ${groups.length} 个品名`
  const allExpanded = groups.length > 0 && groups.every((group) => state.expanded.has(group.product))
  $('#toggleAll').textContent = allExpanded ? '全部收起' : '全部展开'
  syncBatchBar()
  syncCounts()
}

$('#invTable').addEventListener('click', (event) => {
  const info = event.target.closest('.info-btn')
  if (info) {
    event.stopPropagation()
    openSku(info.dataset.sku)
    return
  }

  const accept = event.target.closest('[data-accept]')
  if (accept) {
    event.stopPropagation()
    const key = accept.dataset.accept
    const { child } = childByKey(key)
    if (!child) return

    // 已采纳 = 锁定状态，按钮变「撤销」：回退到采纳前的值
    if (Number(child.planned) > 0) {
      child.planned = child.prevPlanned ?? 0
      delete child.prevPlanned
      toast(`已撤销 ${key.replace('|', ' · ')} 的需安排`)
    } else {
      const raw = String(child.draft ?? '').replace(/[^\d.]/g, '')
      const value = Math.round(Number(raw))
      if (!Number.isFinite(value) || value <= 0) {
        toast('请先填写需安排数量')
        return
      }
      child.prevPlanned = 0
      child.planned = value
      delete child.draft
      toast(`已采纳 ${fmt(value)} 公斤，加入本次采购清单`)
    }

    refreshRow(key)
    syncCounts()
    return
  }

  if (event.target.closest('.planned') || event.target.closest('.cbx')) return

  const skuRow = event.target.closest('[data-sku-row]')
  if (skuRow) {
    toggleSku(skuRow.dataset.skuRow)
    return
  }

  const productRow = event.target.closest('[data-product]')
  if (productRow) {
    const product = productRow.dataset.product
    if (state.expanded.has(product)) state.expanded.delete(product)
    else state.expanded.add(product)
    renderInventory()
  }
})

// 需安排草稿：边填边预演该行的预计库存与预警色（与原组件 plannedPreviewTones 同义）
$('#invTable').addEventListener('input', (event) => {
  const input = event.target.closest('[data-planned]')
  if (!input) return
  const key = input.dataset.planned
  const { child } = childByKey(key)
  if (!child) return

  child.draft = input.value
  refreshRow(key)

  const next = $(`[data-planned="${key}"]`, $('#invTable'))
  if (next) {
    next.focus()
    const end = next.value.length
    next.setSelectionRange?.(end, end)
  }
  syncCounts()
})

$('#invTable').addEventListener('change', (event) => {
  if (event.target.id === 'selectAll') {
    const all = event.target.checked
    visibleSkuKeys().forEach((key) => {
      if (all) state.selected.add(key)
      else state.selected.delete(key)
    })
    renderInventory()
    return
  }

  const skuCheck = event.target.closest('[data-sku-check]')
  if (skuCheck) {
    toggleSku(skuCheck.dataset.skuCheck, skuCheck.checked)
    return
  }

  const groupCheck = event.target.closest('[data-group-check]')
  if (groupCheck) {
    const group = INVENTORY.find((item) => item.product === groupCheck.dataset.groupCheck)
    if (!group) return
    group.children.forEach((child) => {
      const key = skuKey(group.product, child.color)
      if (groupCheck.checked) state.selected.add(key)
      else state.selected.delete(key)
    })
    renderInventory()
  }
})

function toggleSku(key, next) {
  const selected = next ?? !state.selected.has(key)
  if (selected) state.selected.add(key)
  else state.selected.delete(key)
  renderInventory()
}

function syncBatchBar() {
  const count = state.selected.size
  $('#batchCount').textContent = String(count)
  $('#batchbar').hidden = !(state.screen === 'inventory' && count > 0)

  // 右下角「屏蔽选中」：有勾选才点亮
  $('#hideCount').textContent = String(count)
  const hideBtn = $('#hideSelected')
  hideBtn.disabled = count === 0
  hideBtn.title = count
    ? `屏蔽选中的 ${count} 个 SKU，可在「屏蔽列表」解除`
    : '先在表格里勾选要屏蔽的 SKU（勾选品名父行可整组选择）'
}

$('#toneFilters').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-tone]')
  if (!chip) return
  state.tone = chip.dataset.tone
  renderToneFilters()
  renderInventory()
})

$('#filterProduct').addEventListener('input', (event) => {
  state.product = event.target.value.trim()
  renderInventory()
})
$('#filterColor').addEventListener('input', (event) => {
  state.color = event.target.value.trim()
  renderInventory()
})
$('#filterMode').addEventListener('change', (event) => {
  state.mode = event.target.value
  renderInventory()
})
$('#resetFilters').addEventListener('click', () => {
  state.tone = 'all'
  state.product = ''
  state.color = ''
  state.mode = 'all'
  $('#filterProduct').value = ''
  $('#filterColor').value = ''
  $('#filterMode').value = 'all'
  renderToneFilters()
  renderInventory()
})
$('#toggleAll').addEventListener('click', () => {
  const allExpanded = INVENTORY.every((group) => state.expanded.has(group.product))
  state.expanded = allExpanded ? new Set() : new Set(INVENTORY.map((group) => group.product))
  renderInventory()
})
$('#batchClear').addEventListener('click', () => {
  state.selected.clear()
  renderInventory()
})

/* ---------------- SKU 弹窗 ---------------- */
function findSku(key) {
  const [product, color] = key.split('|')
  const group = INVENTORY.find((item) => item.product === product)
  const child = group?.children.find((item) => item.color === color)
  return { group, child }
}

function openSku(key) {
  const { group, child } = findSku(key)
  if (!group || !child) return
  const d = derive(child)
  const total = Math.round(
    DIM_SCORES.reduce((sum, dim) => sum + dim.score * dim.weight, 0) /
      DIM_SCORES.reduce((sum, dim) => sum + dim.weight, 0),
  )
  const tone = total >= 70 ? 'normal' : total >= 50 ? 'replenish' : 'urgent'
  const toneText = total >= 70 ? '健康' : total >= 50 ? '中等风险' : '高风险'
  const toneColor = `var(--industrial-${tone})`
  const category = /黑白|黑|本白|米白|灰白/.test(child.color) ? '黑白' : '彩色'

  $('#skuHead').innerHTML = `
    <span class="modal__title">${group.product}</span>
    <span class="meta">${child.color}</span>
    <span class="meta">${category}</span>
    <div style="display: flex; gap: 4px; margin-left: auto">
      <button class="chip is-active" data-sku-strategy="auto">自动</button>
      <button class="chip" data-sku-strategy="manual">手动</button>
    </div>
    <button class="modal__close" id="skuCloseX" aria-label="关闭">×</button>`

  const bars = Array.from({ length: 12 }, (_, index) => {
    const factor = 0.72 + ((index * 37) % 53) / 100
    return Math.round(child.weekly * 4.2 * factor)
  })

  $('#skuBody').innerHTML = `
    <div class="meta-strip">
      <div class="meta-strip__item">
        <div class="meta-strip__label">模式</div>
        <div class="meta-strip__value">${child.mode}</div>
      </div>
      <div class="meta-strip__item">
        <div class="meta-strip__label">加权月销量</div>
        <div class="meta-strip__value">${fmt(Math.round(child.weekly * 4.3))} 条</div>
      </div>
      <div class="meta-strip__item">
        <div class="meta-strip__label">系数（红 / 正 / 峰）</div>
        <div class="meta-strip__value">20 / 40 / 60 <span style="font-size: 11px; font-weight: 400">天</span></div>
      </div>
      <div class="meta-strip__item">
        <div class="meta-strip__label">累积条数</div>
        <div class="meta-strip__value">${fmt(Math.round(child.weekly * 51))}</div>
      </div>
    </div>

    <h4 class="section-label">健康度评分 <span>5 维加权</span></h4>
    <div class="score-block">
      <div class="score-total">
        <div class="score-total__label">综合评分</div>
        <div class="score-total__value">${total}</div>
        <div class="score-total__tier risk--${tone === 'normal' ? 'low' : tone === 'replenish' ? 'mid' : 'high'}">${toneText}</div>
        <div class="score-bar"><i style="width: ${total}%; background: ${toneColor}"></i></div>
        <div class="score-total__weight">权重合计 100%</div>
      </div>
      <table class="score-table dim-table">
        <thead>
          <tr>
            <th>维度</th>
            <th style="width: 92px">数值</th>
            <th style="width: 52px">权重</th>
            <th style="width: 46px">得分</th>
            <th style="width: 62px">档位</th>
          </tr>
        </thead>
        <tbody>
          ${DIM_SCORES.map(
            (dim) => `
            <tr>
              <td>${dim.label}</td>
              <td class="is-num">${dim.value}</td>
              <td class="is-num">${dim.weight}%</td>
              <td class="is-num">${dim.score}</td>
              <td class="risk--${dim.tone}">${dim.tier}</td>
            </tr>`,
          ).join('')}
        </tbody>
      </table>
    </div>

    <div class="section-row">
      <h4 class="section-label">月度销量 <span>1–12 月</span></h4>
    </div>
    <div class="chart" id="skuChartSales"></div>

    <div class="section-row">
      <h4 class="section-label">月度订单数 <span>1–12 月</span></h4>
      <button class="chart-toggle" id="skuOrderToggle" aria-expanded="true">
        <span>收起</span>
        <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 7.5 6 4.5l3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <div class="chart" id="skuChartOrders"></div>

    <div class="manual-box" id="skuManual" hidden>
      <div class="manual-box__row">
        <span>模式</span>
        <select class="input" style="width: 130px" aria-label="手动模式">
          <option>自定模式</option>
          <option>滞销模式</option>
        </select>
        <span>预计库存 ${fmt(d.projected)} 公斤，日库销比 ${d.days.toFixed(1)} 天</span>
      </div>
      <div class="manual-box__row">
        <span>系数</span>
        <input class="input input--num" value="20" aria-label="红线" />
        <input class="input input--num" value="40" aria-label="正常" />
        <input class="input input--num" value="60" aria-label="峰值" />
        <span class="num-field__unit">条</span>
      </div>
    </div>`

  $('#skuOverlay').hidden = false
  $('#skuSave').disabled = true

  renderSkuCharts(bars)

  $('#skuHead').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-sku-strategy]')
    if (!btn) return
    $$('[data-sku-strategy]', $('#skuHead')).forEach((el) => el.classList.toggle('is-active', el === btn))
    const manual = btn.dataset.skuStrategy === 'manual'
    $('#skuManual').hidden = !manual
    $('#skuSave').disabled = !manual
  })
  $('#skuCloseX').addEventListener('click', closeSku)
}

function closeSku() {
  disposeSkuCharts()
  $('#skuOverlay').hidden = true
}

/* ---------------- SKU 弹窗：两张 ECharts 图 ---------------- */
// 与 SkuDetailDialog.vue 对齐：月度销量（柱 + 双轴折线）与月度订单数（柱），配色沿用 industrial 变量。
const CHART_MONTHS = Array.from({ length: 12 }, (_, index) => `${index + 1}月`)
const CHART_FONT = 'Arial, "Microsoft YaHei", sans-serif'
let skuCharts = []

function disposeSkuCharts() {
  skuCharts.forEach((chart) => chart.dispose())
  skuCharts = []
}

// 两张图共用同一套坐标轴与提示样式，只换 series 与右轴
function chartBase(extra = {}) {
  return {
    animationDuration: 420,
    animationEasing: 'cubicOut',
    textStyle: { color: '#65737c', fontSize: 12, fontFamily: CHART_FONT },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#f5f7f8',
      borderColor: '#aab6be',
      borderWidth: 1,
      padding: [6, 9],
      textStyle: { color: '#2f3b43', fontSize: 12, fontFamily: CHART_FONT },
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(63, 113, 141, 0.07)' } },
    },
    grid: { left: 2, right: 4, top: 38, bottom: 0, containLabel: true },
    xAxis: {
      type: 'category',
      data: CHART_MONTHS,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#aab6be' } },
      axisLabel: { color: '#65737c', fontSize: 11, margin: 8 },
    },
    ...extra,
  }
}

function axisStyle(color) {
  return {
    type: 'value',
    splitLine: { lineStyle: { color: '#e4eaee', type: [3, 3] } },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color, fontSize: 11, margin: 6 },
    nameTextStyle: { color, fontSize: 11, padding: [0, 0, 4, 0] },
  }
}

function renderSkuCharts(counts) {
  disposeSkuCharts()

  // 重量按条数折算（1 条 ≈ 0.3 公斤上下浮动），订单数按每单 260–350 条反推
  const weights = counts.map((value, index) => Math.round(value * (0.28 + ((index * 17) % 11) / 100) * 10) / 10)
  const orders = counts.map((value, index) => Math.max(1, Math.round(value / (260 + ((index * 23) % 90)))))

  const salesEl = $('#skuChartSales')
  const ordersEl = $('#skuChartOrders')
  if (!salesEl || !ordersEl) return

  const sales = echarts.init(salesEl)
  sales.setOption(
    chartBase({
      legend: {
        top: 0,
        left: 'center',
        itemWidth: 10,
        itemHeight: 8,
        itemGap: 18,
        icon: 'roundRect',
        textStyle: { color: '#65737c', fontSize: 12 },
      },
      yAxis: [
        { ...axisStyle('#65737c'), name: '条' },
        { ...axisStyle('#c49a52'), name: '公斤', splitLine: { show: false } },
      ],
      series: [
        {
          name: '条数',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#3f718d', borderRadius: [2, 2, 0, 0] },
          emphasis: { itemStyle: { color: '#315e77' } },
          data: counts,
        },
        {
          name: '重量',
          type: 'line',
          yAxisIndex: 1,
          smooth: 0.35,
          symbol: 'circle',
          symbolSize: 6,
          showSymbol: false,
          lineStyle: { width: 2, color: '#c49a52' },
          itemStyle: { color: '#c49a52', borderColor: '#f8fafb', borderWidth: 1.5 },
          data: weights,
        },
      ],
    }),
  )

  const ordersChart = echarts.init(ordersEl)
  ordersChart.setOption(
    chartBase({
      grid: { left: 2, right: 4, top: 28, bottom: 0, containLabel: true },
      yAxis: [{ ...axisStyle('#65737c'), name: '单', minInterval: 1 }],
      series: [
        {
          name: '订单数',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#829a85', borderRadius: [2, 2, 0, 0] },
          emphasis: { itemStyle: { color: '#6b8570' } },
          data: orders,
        },
      ],
    }),
  )

  skuCharts = [sales, ordersChart]

  const toggle = $('#skuOrderToggle')
  if (toggle) {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true'
      toggle.setAttribute('aria-expanded', String(!expanded))
      toggle.classList.toggle('is-collapsed', expanded)
      toggle.querySelector('span').textContent = expanded ? '展开' : '收起'
      ordersEl.hidden = expanded
      // 重新显示后容器才有尺寸，需要按新宽度重绘
      if (!expanded) requestAnimationFrame(() => ordersChart.resize())
    })
  }
}

$('#skuClose').addEventListener('click', closeSku)
$('#skuOverlay').addEventListener('click', (event) => {
  if (event.target === $('#skuOverlay')) closeSku()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#skuOverlay').hidden) closeSku()
})

/* ---------------- 销售表 ---------------- */
const SALES_COLS = [
  { key: 'product', label: '品名', w: 150, group: '商品', left: true },
  { key: 'color', label: '颜色', w: 132, group: '商品', left: true },
  { key: 'monthlyAvg', label: '月均条数', w: 84, group: '动销指标', num: true },
  { key: 'totalOrders', label: '订单总数', w: 82, group: '动销指标', num: true },
  { key: 'activeMonths', label: '动销月份', w: 82, group: '动销指标', num: true },
  { key: 'activeCustomers', label: '累计客户', w: 82, group: '动销指标', num: true },
  { key: 'cumulative', label: '累积条数', w: 88, group: '动销指标', num: true },
  { key: 'cr5', label: '客户CR5率', w: 88, group: '动销指标', num: true },
]

for (let month = 1; month <= 12; month += 1) {
  SALES_COLS.push({ key: `m${month}s`, label: '条数', w: 62, group: `${month} 月`, month, num: true })
  SALES_COLS.push({ key: `m${month}w`, label: '重量', w: 62, group: `${month} 月`, month, num: true })
  SALES_COLS.push({ key: `m${month}o`, label: '订单', w: 62, group: `${month} 月`, month, num: true })
}

function salesRowsFor(group, child) {
  const months = Array.from({ length: 12 }, (_, index) => {
    const factor = 0.68 + ((index * 29 + child.color.length * 7) % 61) / 100
    const amount = Math.round(child.weekly * 4.3 * factor)
    return { amount, orders: Math.max(1, Math.round(amount / 62)) }
  })
  return {
    monthlyAvg: Math.round(child.weekly * 4.3),
    totalOrders: months.reduce((sum, item) => sum + item.orders, 0),
    activeMonths: 12,
    activeCustomers: 8 + (child.color.length % 14),
    cumulative: months.reduce((sum, item) => sum + item.amount, 0),
    cr5: 0.42 + ((child.color.length % 5) * 0.09),
    months,
  }
}

function renderSalesHead() {
  const groups = []
  SALES_COLS.forEach((col) => {
    const last = groups[groups.length - 1]
    if (last && last.group === col.group) last.span += 1
    else groups.push({ group: col.group, span: 1 })
  })

  const band = groups
    .map((group) => {
      const pin = group.group === '商品' ? 'is-pin' : ''
      return `<div class="gt-band__cell ${pin}" style="grid-column: span ${group.span}">${group.group}</div>`
    })
    .join('')

  const cols = SALES_COLS.map((col, index) => {
    const pin = index < 2 ? 'is-pin' : ''
    const pinLast = index === 1 ? 'is-pin--last' : ''
    const left = index === 0 ? 0 : SALES_COLS[0].w
    const monthStart = col.month && SALES_COLS[index - 1]?.month !== col.month ? 'gt-col--month-start' : ''
    return `<div class="gt-col ${col.left ? 'gt-col--left' : ''} ${pin} ${pinLast} ${monthStart}" style="left: ${left}px">${col.label}</div>`
  }).join('')

  return `<div class="gt-head"><div class="gt-band">${band}</div><div class="gt-cols">${cols}</div></div>`
}

function renderSales() {
  const keyword = state.salesKeyword.toLowerCase()
  const groups = INVENTORY.map((group) => {
    const children = group.children
      .map((child) => ({ child, row: salesRowsFor(group, child) }))
      .filter(({ child, row }) => {
        if (!keyword) return true
        return [group.product, child.color, String(row.monthlyAvg), String(row.cumulative)].some((text) =>
          text.toLowerCase().includes(keyword),
        )
      })
    return { group, children }
  }).filter((item) => item.children.length > 0)

  $('#salesTable').style.setProperty('--cols', SALES_COLS.map((col) => `minmax(${col.w}px, ${col.w}fr)`).join(' '))
  $('#salesTable').style.width = `max(100%, ${SALES_COLS.reduce((sum, col) => sum + col.w, 0)}px)`

  const rows = groups
    .map(({ group, children }) => {
      const open = state.salesExpanded.has(group.product)
      const totals = children.reduce(
        (acc, { row }) => {
          acc.monthlyAvg += row.monthlyAvg
          acc.totalOrders += row.totalOrders
          acc.activeCustomers += row.activeCustomers
          acc.cumulative += row.cumulative
          acc.cr5Weighted += row.cr5 * row.cumulative
          row.months.forEach((month, index) => {
            acc.months[index].amount += month.amount
            acc.months[index].orders += month.orders
          })
          return acc
        },
        {
          monthlyAvg: 0,
          totalOrders: 0,
          activeCustomers: 0,
          cumulative: 0,
          cr5Weighted: 0,
          months: Array.from({ length: 12 }, () => ({ amount: 0, orders: 0 })),
        },
      )

      const parentCells = SALES_COLS.map((col, index) => {
        const pin = index < 2 ? 'is-pin' : ''
        const pinLast = index === 1 ? 'is-pin--last' : ''
        const left = index === 0 ? 0 : SALES_COLS[0].w
        const monthStart = col.month && SALES_COLS[index - 1]?.month !== col.month ? 'gt-cell--month-start' : ''
        let content = ''
        if (col.key === 'product') {
          content = `<span class="name-cell"><span class="caret ${open ? 'is-open' : ''}"><svg viewBox="0 0 12 12" fill="none"><path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="name-cell__text">${group.product}</span></span>`
        } else if (col.key === 'color') {
          content = `<span class="name-cell__text" style="color: var(--industrial-muted); font-weight: 400">${children.length} 个颜色</span>`
        } else if (col.key === 'monthlyAvg') {
          content = fmt(totals.monthlyAvg)
        } else if (col.key === 'totalOrders') {
          content = fmt(totals.totalOrders)
        } else if (col.key === 'activeMonths') {
          content = '12'
        } else if (col.key === 'activeCustomers') {
          content = fmt(totals.activeCustomers)
        } else if (col.key === 'cumulative') {
          content = fmt(totals.cumulative)
        } else if (col.key === 'cr5') {
          content = `${((totals.cr5Weighted / (totals.cumulative || 1)) * 100).toFixed(1)}%`
        } else if (col.month) {
          const month = totals.months[col.month - 1]
          content = fmt(col.key.endsWith('s') ? month.amount : col.key.endsWith('w') ? Math.round(month.amount / 20) : month.orders)
        }
        return `<div class="gt-cell ${col.left ? 'gt-cell--left' : ''} ${col.num ? 'gt-cell--num' : ''} ${pin} ${pinLast} ${monthStart}" style="left: ${left}px">${content}</div>`
      }).join('')

      const childRows = open
        ? children
            .map(({ child, row }) => {
              const cells = SALES_COLS.map((col, index) => {
                const pin = index < 2 ? 'is-pin' : ''
                const pinLast = index === 1 ? 'is-pin--last' : ''
                const left = index === 0 ? 0 : SALES_COLS[0].w
                const monthStart = col.month && SALES_COLS[index - 1]?.month !== col.month ? 'gt-cell--month-start' : ''
                let content = ''
                if (col.key === 'product') {
                  content = `<span class="name-cell child-name"><span class="name-cell__text" title="${group.product}">${group.product}</span></span>`
                } else if (col.key === 'color') {
                  content = `<span class="name-cell" style="justify-content: space-between"><span class="name-cell__text" title="${child.color}">${child.color}</span><button class="info-btn" data-sku="${skuKey(group.product, child.color)}" title="配置信息">i</button></span>`
                } else if (col.key === 'monthlyAvg') {
                  content = fmt(row.monthlyAvg)
                } else if (col.key === 'totalOrders') {
                  content = fmt(row.totalOrders)
                } else if (col.key === 'activeMonths') {
                  content = String(row.activeMonths)
                } else if (col.key === 'activeCustomers') {
                  content = String(row.activeCustomers)
                } else if (col.key === 'cumulative') {
                  content = fmt(row.cumulative)
                } else if (col.key === 'cr5') {
                  content = `${(row.cr5 * 100).toFixed(1)}%`
                } else if (col.month) {
                  const data = row.months[col.month - 1]
                  content = fmt(col.key.endsWith('s') ? data.amount : col.key.endsWith('w') ? Math.round(data.amount / 20) : data.orders)
                }
                return `<div class="gt-cell ${col.left ? 'gt-cell--left' : ''} ${col.num ? 'gt-cell--num' : ''} ${pin} ${pinLast} ${monthStart}" style="left: ${left}px">${content}</div>`
              }).join('')
              return `<div class="gt-row" data-sales-row="${skuKey(group.product, child.color)}">${cells}</div>`
            })
            .join('')
        : ''

      return `<div class="gt-row gt-row--group" data-sales-product="${group.product}">${parentCells}</div>${childRows}`
    })
    .join('')

  $('#salesTable').innerHTML = `${renderSalesHead()}<div class="gt-body">${
    groups.length ? rows : '<div class="table-empty">没有匹配的数据</div>'
  }</div>`

  const totalSku = groups.reduce((sum, group) => sum + group.children.length, 0)
  $('#salesCount').textContent = `${totalSku} 行 · ${groups.length} 个品名`
  const allOpen = groups.length > 0 && groups.every(({ group }) => state.salesExpanded.has(group.product))
  $('#salesToggleAll').textContent = allOpen ? '全部收起' : '全部展开'
}

$('#salesTable').addEventListener('click', (event) => {
  const info = event.target.closest('.info-btn')
  if (info) {
    event.stopPropagation()
    openSku(info.dataset.sku)
    return
  }
  const parent = event.target.closest('[data-sales-product]')
  if (parent) {
    const product = parent.dataset.salesProduct
    if (state.salesExpanded.has(product)) state.salesExpanded.delete(product)
    else state.salesExpanded.add(product)
    renderSales()
  }
})

$('#salesSearch').addEventListener('input', (event) => {
  state.salesKeyword = event.target.value.trim()
  renderSales()
})

$('#salesToggleAll').addEventListener('click', () => {
  const allOpen = INVENTORY.every((group) => state.salesExpanded.has(group.product))
  state.salesExpanded = allOpen ? new Set() : new Set(INVENTORY.map((group) => group.product))
  renderSales()
})

/* ---------------- 配置：分区 ---------------- */
// 项目里「配置信息」与「下单设置」是两个页面，这里各有一份 .config-layout，
// 分区切换只在当前那一份里生效，互不影响。
const PANEL_DOMAIN = {
  strategy: 'stocking',
  weights: 'stocking',
  scoring: 'stocking',
  spu: 'stocking',
  vat: 'purchase',
  factories: 'purchase',
  people: 'purchase',
  categories: 'purchase',
  'sku-factories': 'purchase',
}

function switchPanel(panel) {
  const view = $(`[data-panel-view="${panel}"]`)
  const host = view?.closest('.config-layout')
  if (!host) return
  $$('.rail__item', host).forEach((item) => item.classList.toggle('is-active', item.dataset.panel === panel))
  $$('[data-panel-view]', host).forEach((item) => {
    item.hidden = item.dataset.panelView !== panel
  })
}

$$('.rail__item').forEach((item) => item.addEventListener('click', () => switchPanel(item.dataset.panel)))

/* ---------------- 设置：统一表单 ---------------- */
// 设置页只有两种交互：表格只读展示 + 一个弹窗改值。
// 弹窗结构、宽度、单位位置、底部按钮顺序全部固定，避免每处各写一套。

let formSpec = null

function esc(text) {
  return String(text ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
}

function formRow(label, control, hint = '') {
  return `<div class="form__row"><span class="form__row-label">${label}</span><span class="form__row-ctrl">${control}${
    hint ? `<span class="form__row-hint">${hint}</span>` : ''
  }</span></div>`
}

function numField(key, value, unit = '', opts = {}) {
  const { min, max, step = 1, placeholder = '' } = opts
  return `<span class="num-field"><input class="input input--num" type="number" inputmode="decimal" data-key="${key}"
    value="${value ?? ''}"${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''}
    step="${step}"${placeholder ? ` placeholder="${placeholder}"` : ''} />${
    unit ? `<span class="num-field__unit">${unit}</span>` : ''
  }</span>`
}

function textField(key, value, opts = {}) {
  return `<input class="input" data-key="${key}" value="${esc(value ?? '')}"${
    opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : ''
  }${opts.readonly ? ' readonly' : ''} />`
}

function selectField(key, value, options) {
  return `<select class="input" data-key="${key}">${options
    .map((opt) => `<option value="${esc(opt.value)}"${opt.value === value ? ' selected' : ''}>${esc(opt.label)}</option>`)
    .join('')}</select>`
}

function switchField(key, on) {
  return `<button type="button" class="switch ${on ? 'is-on' : ''}" data-switch="${key}" data-value="${on ? 1 : 0}" aria-pressed="${on ? 'true' : 'false'}"></button>`
}

function tagsField(key, items, options, placeholder = '添加') {
  return `<span class="tags" data-tags="${key}">
    ${items.map((item) => `<span class="tags__item" data-tag="${esc(item)}">${esc(item)}<button type="button" class="tags__del" data-tag-del aria-label="移除">×</button></span>`).join('')}
    <input class="input tags__input" list="tag-options-${key}" data-tag-input placeholder="${placeholder}" />
    <datalist id="tag-options-${key}">${options.map((opt) => `<option value="${esc(opt)}"></option>`).join('')}</datalist>
  </span>`
}

function readForm() {
  // 从初始结构深拷贝：这样 rows / tiers 这类「行结构」在提交时仍然拿得到
  const values = formSpec?.values ? JSON.parse(JSON.stringify(formSpec.values)) : {}
  $$('[data-key]', $('#formBody')).forEach((el) => {
    const key = el.dataset.key
    if (el.type === 'number') values[key] = el.value === '' ? null : Number(el.value)
    else values[key] = el.value
  })
  $$('[data-switch]', $('#formBody')).forEach((el) => {
    values[el.dataset.switch] = el.dataset.value === '1'
  })
  $$('[data-tags]', $('#formBody')).forEach((wrap) => {
    values[wrap.dataset.tags] = $$('[data-tag]', wrap).map((chip) => chip.dataset.tag)
  })
  return values
}

function validateForm(show = true) {
  if (!formSpec) return true
  const values = readForm()
  formSpec.onInput?.(values)
  const message = formSpec.validate?.(values) || null
  const error = $('#formError')
  error.hidden = !(message && show)
  error.textContent = message || ''
  // 首次打开不拦确定；一旦开始输入，错误即时提示并禁用确定
  $('#formOk').disabled = Boolean(message) && show
  return !message
}

function openForm(spec) {
  formSpec = spec
  $('#formTitle').textContent = spec.title || '编辑'
  const modal = $('#formOverlay').querySelector('.modal')
  modal.classList.toggle('modal--wide', Boolean(spec.wide))
  modal.classList.toggle('modal--narrow', Boolean(spec.narrow))
  modal.classList.toggle('modal--mid', Boolean(spec.mid))
  const note = $('#formNote')
  note.hidden = !spec.note
  note.textContent = spec.note || ''
  $('#formBody').innerHTML = spec.render(spec.values)
  $('#formReset').hidden = !spec.reset
  const ok = $('#formOk')
  ok.textContent = spec.okText || '确定'
  ok.classList.toggle('btn--danger-solid', Boolean(spec.danger))
  $('#formOverlay').hidden = false
  validateForm(false)
  const first = $('#formBody input:not([readonly]), #formBody select')
  first?.focus()
}

function closeForm() {
  $('#formOverlay').hidden = true
  formSpec = null
}

function submitForm() {
  if (!formSpec || !validateForm(true)) return
  const values = readForm()
  formSpec.onSubmit?.(values)
  closeForm()
}

function openConfirm({ title, note, okText = '删除', onOk }) {
  openForm({
    title,
    note,
    values: {},
    render: () => '',
    okText,
    danger: true,
    narrow: true,
    onSubmit: () => onOk(),
  })
}

$('#formOk').addEventListener('click', submitForm)
$('#formCancel').addEventListener('click', closeForm)
$('#formClose').addEventListener('click', closeForm)
$('#formReset').addEventListener('click', () => {
  if (!formSpec?.reset) return
  const spec = formSpec
  openForm({ ...spec, values: spec.reset() })
})

$('#formBody').addEventListener('input', (event) => {
  validateForm()
})

// 开关：点一下就地切换，不依赖原生 checkbox
$('#formBody').addEventListener('click', (event) => {
  const sw = event.target.closest('[data-switch]')
  if (sw) {
    const on = sw.dataset.value !== '1'
    sw.dataset.value = on ? '1' : '0'
    sw.classList.toggle('is-on', on)
    sw.setAttribute('aria-pressed', String(on))
    validateForm()
    return
  }
  const del = event.target.closest('[data-tag-del]')
  if (del) {
    del.closest('[data-tag]').remove()
    validateForm()
  }
})

// 标签：回车添加，去重；输入框保留焦点方便连续录入
$('#formBody').addEventListener('keydown', (event) => {
  const input = event.target.closest('[data-tag-input]')
  if (!input || event.key !== 'Enter') return
  event.preventDefault()
  const value = input.value.trim()
  if (!value) return
  const wrap = input.closest('[data-tags]')
  if ($$('[data-tag]', wrap).some((chip) => chip.dataset.tag === value)) {
    input.value = ''
    return
  }
  const chip = document.createElement('span')
  chip.className = 'tags__item'
  chip.dataset.tag = value
  chip.innerHTML = `${esc(value)}<button type="button" class="tags__del" data-tag-del aria-label="移除">×</button>`
  wrap.insertBefore(chip, input)
  input.value = ''
  validateForm()
})

document.addEventListener('keydown', (event) => {
  if ($('#formOverlay').hidden) return
  if (event.key === 'Escape') {
    event.stopPropagation()
    closeForm()
  }
  if (event.key === 'Enter' && !event.target.closest('[data-tags]')) {
    event.preventDefault()
    submitForm()
  }
})

/* ---------------- 设置：策略与模式 ---------------- */
function currentMode() {
  return MODES.find((item) => item.key === state.activeMode) || MODES[0]
}

function modeRange(mode) {
  const index = MODES.findIndex((item) => item.key === mode.key)
  const above = MODES[index - 1]
  if (!mode.participates) return mode.key === 'slow' ? '月均 = 0' : '0 < 月均 < 3'
  return above ? `${mode.min} ~ ${above.min} 条/月` : `≥ ${mode.min} 条/月`
}

function renderModeList() {
  $('#modeList').innerHTML = MODES.map(
    (mode) => `
    <button class="mode-item ${mode.key === state.activeMode ? 'is-active' : ''}" data-mode="${mode.key}">
      <span class="mode-item__row">
        <span class="mode-item__name">${mode.name}</span>
        <span class="mode-item__hits">${fmt(mode.hits)}</span>
      </span>
      <span class="mode-item__range">${modeRange(mode)}</span>
    </button>`,
  ).join('')
  $('#railStrategyMeta').textContent = `${MODES.length} 个模式`
}

function coefTableReadonly(mode, unit) {
  const cell = (row) => `
    <td class="is-num">${row.redLine.toFixed(1)}</td>
    <td class="is-num">${row.normal.toFixed(1)}</td>
    <td class="is-num">${row.peak.toFixed(1)}</td>`

  return `<table class="coef-table">
    <thead>
      <tr>
        <th class="coef-table__cat">客户类别</th>
        <th class="coef-table__color">色彩</th>
        <th class="is-num">红线（${unit}）</th>
        <th class="is-num">正常（${unit}）</th>
        <th class="is-num">峰值（${unit}）</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="coef-table__cat" rowspan="2">流通品</td>
        <td class="coef-table__color">黑白</td>
        ${cell(mode.rows[0])}
      </tr>
      <tr>
        <td class="coef-table__color">彩色</td>
        ${cell(mode.rows[1])}
      </tr>
      ${
        mode.split
          ? '<tr><td class="coef-table__cat">专属品</td><td colspan="4" class="coef-table__skip">不设系数</td></tr>'
          : ''
      }
    </tbody>
  </table>`
}

function renderEditor() {
  const mode = currentMode()
  const unit = mode.metric === 'days' ? '天' : '条'

  $('#modeEditor').innerHTML = `
    <div class="editor-head">
      <h3 class="editor-head__title">${mode.name}</h3>
      <span class="tag">${modeRange(mode)}</span>
      <span class="editor-head__meta">命中 ${fmt(mode.hits)} 个 SKU</span>
    </div>

    <div class="tbl-block">
      <div class="section-label">备货系数 ${mode.participates ? `<span>单位：${unit}</span>` : ''}</div>
      ${mode.participates ? coefTableReadonly(mode, unit) : '<div class="table-empty">不参与备货计算</div>'}
      <div class="tbl-foot">
        <span class="tbl-foot__hint"></span>
        <button class="btn btn--sm" data-edit="mode">编辑</button>
      </div>
    </div>`

  $$('.mode-item').forEach((item) => item.classList.toggle('is-active', item.dataset.mode === mode.key))
}

function editModeDialog() {
  const mode = currentMode()
  const unit = mode.metric === 'days' ? '天' : '条'

  openForm({
    title: `编辑模式 · ${mode.name}`,
    values: JSON.parse(JSON.stringify(mode)),
    render: (v) => `
      ${formRow('名称', textField('name', v.name))}
      ${
        v.participates
          ? formRow('判定区间', `<span class="form__static">月均条数 ≥</span>${numField('min', v.min, '条/月', {
              min: 0,
              step: 1,
            })}`)
          : formRow('判定条件', '<span class="form__static">月均条数为 0 时命中，不参与备货计算</span>')
      }
      ${
        v.participates
          ? `<div class="form__group">
              <div class="form__group-head">备货系数<span class="form__group-unit">单位：${unit}</span></div>
              <div class="coef-grid">
                <div class="coef-grid__head"><span>色彩</span><span>红线</span><span>正常</span><span>峰值</span></div>
                ${v.rows
                  .map(
                    (row, index) => `
                  <div class="coef-grid__row">
                    <span>${row.color}</span>
                    ${numField(`r${index}-redLine`, row.redLine, '', { step: 0.1, min: 0 })}
                    ${numField(`r${index}-normal`, row.normal, '', { step: 0.1, min: 0 })}
                    ${numField(`r${index}-peak`, row.peak, '', { step: 0.1, min: 0 })}
                  </div>`,
                  )
                  .join('')}
              </div>
              <p class="form__group-hint">同一行需满足 红线 &lt; 正常 &lt; 峰值</p>
            </div>`
          : ''
      }`,
    validate: (v) => {
      if (!v.name.trim()) return '名称不能为空'
      if (!v.participates) return null
      if (v.min === null || v.min < 0) return '判定区间需填写不小于 0 的数值'
      for (let i = 0; i < v.rows.length; i += 1) {
        const red = v[`r${i}-redLine`]
        const normal = v[`r${i}-normal`]
        const peak = v[`r${i}-peak`]
        if ([red, normal, peak].some((value) => value === null)) return `${v.rows[i].color} 的三个系数都要填写`
        if (!(red < normal && normal < peak)) return `${v.rows[i].color}：需满足 红线 < 正常 < 峰值`
      }
      return null
    },
    onSubmit: (v) => {
      pushHistory()
      mode.name = v.name.trim()
      if (v.participates) {
        mode.min = v.min
        mode.rows.forEach((row, index) => {
          row.redLine = v[`r${index}-redLine`]
          row.normal = v[`r${index}-normal`]
          row.peak = v[`r${index}-peak`]
        })
      }
      renderModeList()
      renderEditor()
      markDirty('strategy')
      toast(`已更新「${mode.name}」`)
    },
  })
}

/* ---------------- 设置：销量加权 ---------------- */
const WEIGHT_ROWS = [
  ['近 1 个月', 'm1'],
  ['近 3 个月月均', 'm3'],
  ['近 12 个月月均', 'm12'],
]

function weightTotal() {
  return WEIGHT_ROWS.reduce((sum, [, key]) => sum + state.weights[key], 0)
}

function renderWeights() {
  $('#weightBody').innerHTML = WEIGHT_ROWS.map(
    ([label, key]) => `<tr><td>${label}</td><td class="is-num">${state.weights[key]}%</td></tr>`,
  ).join('')

  const total = weightTotal()
  $('#weightFoot').innerHTML = `<tr class="tfoot"><td>合计</td><td class="is-num ${
    total === 100 ? '' : 'is-bad'
  }">${total}%</td></tr>`
  $('#weightHint').textContent = total === 100 ? '' : `合计需为 100%，当前 ${total}%`
  $('#railWeightMeta').textContent = WEIGHT_ROWS.map(([, key]) => state.weights[key]).join(' / ')
}

function editWeightsDialog() {
  openForm({
    title: '编辑销量加权',
    note: '三个权重相加必须等于 100%，加权结果决定备货系数的基数。',
    values: { ...state.weights },
    reset: () => ({ m1: 50, m3: 30, m12: 20 }),
    render: (v) => `
      ${formRow('近 1 个月', numField('m1', v.m1, '%', { min: 0, max: 100, step: 5 }))}
      ${formRow('近 3 个月月均', numField('m3', v.m3, '%', { min: 0, max: 100, step: 5 }))}
      ${formRow('近 12 个月月均', numField('m12', v.m12, '%', { min: 0, max: 100, step: 5 }))}
      <div class="form__sum">合计 <b id="formSum">${(v.m1 || 0) + (v.m3 || 0) + (v.m12 || 0)}</b>%</div>`,
    onInput: (v) => {
      const sum = (v.m1 || 0) + (v.m3 || 0) + (v.m12 || 0)
      const el = $('#formSum')
      if (el) {
        el.textContent = String(sum)
        el.classList.toggle('is-bad', sum !== 100)
      }
    },
    validate: (v) => {
      if ([v.m1, v.m3, v.m12].some((value) => value === null)) return '三个权重都要填写'
      const sum = v.m1 + v.m3 + v.m12
      return sum === 100 ? null : `合计 ${sum}%，需调整到 100%`
    },
    onSubmit: (v) => {
      pushHistory()
      state.weights = { m1: v.m1, m3: v.m3, m12: v.m12 }
      renderWeights()
      markDirty('weights')
      toast('销量加权已更新')
    },
  })
}

/* ---------------- 设置：健康度评分 ---------------- */
// 区间文案统一成数学式：≤ x / a ~ b / ≥ x，和 SPU 分级的「≥ x」同一套写法。
// 百分号贴数字，其他单位只写在末尾，避免「11 个 ~ 20 个」这种重复
function rangeText(range, unit = '') {
  const tight = (value) => `${value}${unit === '%' ? '%' : ''}`
  const suffix = (value) => `${tight(value)}${unit && unit !== '%' ? ` ${unit}` : ''}`
  if (range.from === null && range.to === null) return '不限'
  if (range.from === null) return `≤ ${suffix(range.to)}`
  if (range.to === null) return `≥ ${suffix(range.from)}`
  if (range.from === range.to) return `= ${suffix(range.from)}`
  return `${tight(range.from)} ~ ${suffix(range.to)}`
}

function scoringWeightTotal() {
  return SCORING_ROWS.reduce((sum, row) => sum + row.weight, 0)
}

function renderScoring() {
  $('#scoringBody').innerHTML = SCORING_ROWS.map(
    (row) => `
    <tr>
      <td>${row.label}</td>
      <td class="is-num">${row.weight}%</td>
      <td>${rangeText(row.low, row.unit)}</td>
      <td>${rangeText(row.mid, row.unit)}</td>
      <td>${rangeText(row.high, row.unit)}</td>
    </tr>`,
  ).join('')

  $('#scoringHint').textContent = `三档得分 ${SCORING_SCORES.low} / ${SCORING_SCORES.mid} / ${
    SCORING_SCORES.high
  } · 综合分档 ≤ ${SCORING_TOTAL.midFrom} 红 · ${SCORING_TOTAL.midFrom} ~ ${SCORING_TOTAL.midTo} 黄 · ≥ ${
    SCORING_TOTAL.midTo
  } 绿`
  $('#railScoringMeta').textContent = `${SCORING_ROWS.length} 个维度`
}

const TIERS = [
  ['low', '低'],
  ['mid', '中'],
  ['high', '高'],
]

const TIER_LABEL = { low: '低', mid: '中', high: '高' }

// 「分档刻度条」：一条轴上只填分界值，相邻两档共用同一个数，不再逐档填 from / to
function bandOrder(row) {
  return TIERS.map(([tier]) => tier).sort(
    (a, b) => (row[a].from ?? Number.NEGATIVE_INFINITY) - (row[b].from ?? Number.NEGATIVE_INFINITY),
  )
}

function bandBar(key, segs) {
  const [first, second, third] = segs
  // 分界值取左段的上界：存量区间本来就写成 0~10 / 11~20，取 10 比取 11 更贴近原值
  const b1 = first.to ?? second.from
  const b2 = second.to ?? third.from
  const empty = b1 === b2
  const seg = (item) =>
    `<span class="bandbar__seg bandbar__seg--${item.tone}${
      empty && item === second ? ' is-empty' : ''
    }"${empty && item === second ? ' title="该档区间为空，不会命中"' : ''}>${item.label}</span>`
  const cut = (suffix, value, label) =>
    `<input class="bandbar__cut" type="number" inputmode="decimal" step="1" data-key="${key}-${suffix}"
      value="${value ?? ''}" placeholder="不限" aria-label="${label}" />`

  return `<div class="bandbar">
    ${seg(first)}
    ${cut('b1', b1, '第 1 个分界值')}
    ${seg(second)}
    ${cut('b2', b2, '第 2 个分界值')}
    ${seg(third)}
  </div>`
}

function rowSegs(row) {
  return bandOrder(row).map((tier) => ({
    label: TIER_LABEL[tier],
    tone: tier,
    from: row[tier].from,
    to: row[tier].to,
  }))
}

function editScoringDialog() {
  openForm({
    title: '编辑健康度评分',
    wide: true,
    note: '三档按数值从小到大排成一条轴，只填两个分界值，左右两档共用；权重合计需为 100%。',
    values: JSON.parse(
      JSON.stringify({ chains: SCORING_ROWS, scores: SCORING_SCORES, total: SCORING_TOTAL }),
    ),
    reset: () => ({
      chains: [
        { key: 'cr5', label: '客户数 CR5', unit: '%', weight: 15, low: { from: 0, to: 40 }, mid: { from: 40, to: 60 }, high: { from: 60, to: null } },
        { key: 'customers', label: '累计客户数', unit: '个', weight: 10, low: { from: 21, to: null }, mid: { from: 11, to: 20 }, high: { from: 0, to: 10 } },
        { key: 'mom', label: '销售环比率', unit: '%', weight: 20, low: { from: 10, to: null }, mid: { from: -10, to: 10 }, high: { from: null, to: -10 } },
        { key: 'inout', label: '本次进销比', unit: '%', weight: 30, low: { from: 0, to: 20 }, mid: { from: 20, to: 30 }, high: { from: 30, to: null } },
        { key: 'consumption', label: '预估月消耗', unit: '条', weight: 25, low: { from: null, to: 0 }, mid: { from: 0, to: 0 }, high: { from: 0, to: null } },
      ],
      scores: { low: 80, mid: 60, high: 40 },
      total: { midFrom: 50, midTo: 70 },
    }),
    render: (v) => `
      <div class="rule-head">
        <span>维度</span>
        <span>风险分档</span>
        <span class="is-right">权重</span>
      </div>
      <div class="rule-body">
        ${v.chains
          .map(
            (row) => `
          <div class="rule-row">
            <span class="rule-row__name">${row.label}${row.unit ? `<em>${row.unit}</em>` : ''}</span>
            ${bandBar(row.key, rowSegs(row))}
            ${numField(`w-${row.key}`, row.weight, '%', { min: 0, max: 100, step: 5 })}
          </div>`,
          )
          .join('')}
      </div>
      <div class="rule-foot">
        <span>分界值同时属于相邻两档，按中风险优先</span>
        <span>权重合计 <b id="formSum">${scoringWeightTotal()}</b>%</span>
      </div>
      <div class="rule-head rule-head--sub">
        <span>总分规则</span>
        <span></span>
        <span></span>
      </div>
      <div class="rule-body">
        <div class="rule-row">
          <span class="rule-row__name">三档得分</span>
          <div class="form__inline">
            ${TIERS.map(
              ([tier, label]) =>
                `<label class="form__inline-item">${label}${numField(`score-${tier}`, v.scores[tier], '', {
                  min: 0,
                  max: 100,
                  step: 5,
                })}</label>`,
            ).join('')}
          </div>
          <span></span>
        </div>
        <div class="rule-row">
          <span class="rule-row__name">综合分档<em>分</em></span>
          ${bandBar('total', [
            { label: '红', tone: 'high', from: 0, to: v.total.midFrom },
            { label: '黄', tone: 'mid', from: v.total.midFrom, to: v.total.midTo },
            { label: '绿', tone: 'low', from: v.total.midTo, to: null },
          ])}
          <span></span>
        </div>
      </div>`,
    onInput: (v) => {
      const sum = v.chains.reduce((total, row) => total + (v[`w-${row.key}`] || 0), 0)
      const el = $('#formSum')
      if (el) {
        el.textContent = String(sum)
        el.classList.toggle('is-bad', sum !== 100)
      }
    },
    validate: (v) => {
      const sum = v.chains.reduce((total, row) => total + (v[`w-${row.key}`] || 0), 0)
      if (sum !== 100) return `权重合计 ${sum}%，需调整到 100%`
      for (const row of v.chains) {
        const b1 = v[`${row.key}-b1`]
        const b2 = v[`${row.key}-b2`]
        if (b1 === null || b2 === null) return `${row.label} 的两个分界值都要填写`
        if (b1 > b2) return `${row.label} 的分界值要按从左到右递增`
      }
      const from = v['total-b1']
      const to = v['total-b2']
      if (from === null || to === null) return '综合分档的两个分界值都要填写'
      if (from > to) return '综合分档的分界值要按从左到右递增'
      return null
    },
    onSubmit: (v) => {
      pushHistory()
      SCORING_ROWS.forEach((row) => {
        const order = bandOrder(row)
        const b1 = v[`${row.key}-b1`]
        const b2 = v[`${row.key}-b2`]
        row.weight = v[`w-${row.key}`]
        row[order[0]] = { from: null, to: b1 }
        row[order[1]] = { from: b1, to: b2 }
        row[order[2]] = { from: b2, to: null }
      })
      TIERS.forEach(([tier]) => {
        SCORING_SCORES[tier] = v[`score-${tier}`]
      })
      SCORING_TOTAL = { midFrom: v['total-b1'], midTo: v['total-b2'] }
      renderScoring()
      markDirty('scoring')
      toast('评分规则已更新')
    },
  })
}

/* ---------------- 设置：SPU 分级 ---------------- */
function gradeText(grade, index) {
  if (grade.min === null) {
    const prev = SPU_GRADES[index - 1]
    return `< ${prev ? prev.min : 0}`
  }
  return `≥ ${grade.min}`
}

function renderGrades() {
  $('#gradeBody').innerHTML = SPU_GRADES.map(
    (grade, index) => `
    <tr>
      <td><span class="grade grade--${grade.tone}">${grade.label}</span></td>
      <td>${gradeText(grade, index)}</td>
      <td class="is-num">${grade.count} 个</td>
    </tr>`,
  ).join('')
  $('#railSpuMeta').textContent = `${SPU_GRADES.length} 档`
}

function editSpuDialog() {
  openForm({
    title: '编辑 SPU 分级',
    mid: true,
    note: '从高到低判定，命中第一条「月均 ≥ 下限」的等级；末档兜底。',
    values: { tiers: JSON.parse(JSON.stringify(SPU_GRADES)) },
    reset: () => ({
      tiers: [
        { key: 'splus', label: 'S+', tone: 'splus', min: 2500, count: 1 },
        { key: 's', label: 'S', tone: 's', min: 300, count: 2 },
        { key: 'a', label: 'A', tone: 'a', min: 100, count: 0 },
        { key: 'b', label: 'B', tone: 'b', min: 30, count: 1 },
        { key: 'c', label: 'C', tone: 'c', min: 1, count: 1 },
        { key: 'z', label: 'Z', tone: 'z', min: null, count: 0 },
      ],
    }),
    render: (v) => `
      <div class="tierrow tierrow--head">
        <span>等级</span>
        <span>月均条数 <em>≥</em></span>
        <span class="is-right">当前命中</span>
      </div>
      <div class="tierbody">
        ${v.tiers
          .map(
            (tier, index) => `
          <div class="tierrow">
            <input class="input tierrow__label" data-key="label-${index}" value="${esc(tier.label)}"
              maxlength="4" aria-label="第 ${index + 1} 档名称" />
            ${
              index < v.tiers.length - 1
                ? `<label class="tierrow__value">${numField(`min-${index}`, tier.min, '条')}</label>`
                : `<span class="tierrow__fallback">低于上一档，全部收下</span>`
            }
            <span class="tierrow__hit">${tier.count} 个</span>
          </div>`,
          )
          .join('')}
      </div>
      <p class="form__group-hint">下限需逐档递减，末档不填。</p>`,
    validate: (v) => {
      for (let i = 0; i < v.tiers.length - 1; i += 1) {
        if (!v[`label-${i}`].trim()) return `第 ${i + 1} 档名称不能为空`
        const min = v[`min-${i}`]
        if (min === null || min < 0) return `${v[`label-${i}`]} 的月均下限需填写不小于 0 的数值`
        if (i > 0 && !(min < v[`min-${i - 1}`])) return `第 ${i + 1} 档下限需小于上一档`
      }
      return null
    },
    onSubmit: (v) => {
      pushHistory()
      SPU_GRADES.forEach((grade, index) => {
        grade.label = v[`label-${index}`].trim()
        if (index < SPU_GRADES.length - 1) grade.min = v[`min-${index}`]
      })
      renderGrades()
      markDirty('spu')
      toast('SPU 分级已更新')
    },
  })
}

/* ---------------- 设置：手动策略 ---------------- */
state.manualSelected = new Set()

function renderManualModes() {
  $('#manualModeBody').innerHTML = MANUAL_MODES.map(
    (item) => `
    <tr>
      <td>${esc(item.name)}</td>
      <td>${
        item.behavior === 'custom'
          ? '<span class="tag">自定系数</span>'
          : `<span class="tag tag--muted">${esc(
              MANUAL_BEHAVIORS.find((b) => b.value === item.behavior)?.label ?? '排除',
            )}</span>`
      }</td>
      <td class="meta">${esc(item.desc)}</td>
      <td class="is-num">${item.participates ? item.redLine.toFixed(1) : '—'}</td>
      <td class="is-num">${item.participates ? item.normal.toFixed(1) : '—'}</td>
      <td class="is-num">${item.participates ? item.peak.toFixed(1) : '—'}</td>
      <td class="is-num">${rowActs('manual-mode', item.id, item.builtin)}</td>
    </tr>`,
  ).join('')
  $('#manualModeMeta').textContent = `${MANUAL_MODES.length} 个模式`
}

function renderManualSkus() {
  $('#manualSkuBody').innerHTML = MANUAL_SKUS.map((item) => {
    const mode = MANUAL_MODES.find((entry) => entry.id === item.modeId)
    const checked = state.manualSelected.has(item.id)
    return `
    <tr class="${checked ? 'is-selected' : ''}">
      <td><span class="cbx"><input type="checkbox" data-manual-check="${item.id}" ${
        checked ? 'checked' : ''
      } /><span></span></span></td>
      <td class="meta">${esc(item.id)}</td>
      <td>${esc(item.product)} / ${esc(item.color)}</td>
      <td>${mode ? esc(mode.name) : '—'}</td>
      <td class="is-num">${
        mode?.participates ? `${item.redLine.toFixed(1)} / ${item.normal.toFixed(1)} / ${item.peak.toFixed(1)}` : '—'
      }</td>
      <td class="is-num">${rowActs('manual-sku', item.id)}</td>
    </tr>`
  }).join('')

  const count = state.manualSelected.size
  $('#manualSkuMeta').textContent = `${MANUAL_SKUS.length} 个 SKU`
  $('#manualSkuHint').textContent = count ? `已选 ${count} 个` : '未手动指定的 SKU 按自动策略判定'
  $('#manualBulkBtn').hidden = count === 0
  const all = $('#manualAll')
  if (all) {
    all.checked = count > 0 && count === MANUAL_SKUS.length
    all.indeterminate = count > 0 && count < MANUAL_SKUS.length
  }
}

function editManualModeDialog(item) {
  const isNew = !item
  const data = item || {
    id: `mm-${Date.now()}`,
    name: '',
    behavior: 'custom',
    desc: '',
    participates: true,
    redLine: 20,
    normal: 40,
    peak: 60,
  }

  openForm({
    title: isNew ? '新增手动模式' : `编辑手动模式 · ${data.name}`,
    values: { ...data },
    render: (v) => `
      ${formRow('名称', textField('name', v.name, { placeholder: '如 自定模式' }))}
      ${formRow(
        '行为',
        selectField(
          'behavior',
          v.behavior,
          MANUAL_BEHAVIORS.map((b) => ({ value: b.value, label: b.label })),
        ),
        esc(MANUAL_BEHAVIORS.find((b) => b.value === v.behavior)?.hint ?? ''),
      )}
      ${formRow('说明', textField('desc', v.desc, { placeholder: '这条模式怎么用' }))}
      ${
        v.behavior === 'custom'
          ? `<div class="form__group">
              <div class="form__group-head">备货系数<span class="form__group-unit">单位：条</span></div>
              <div class="form__inline">
                <label class="form__inline-item">红线${numField('redLine', v.redLine, '', { step: 0.1, min: 0 })}</label>
                <label class="form__inline-item">正常${numField('normal', v.normal, '', { step: 0.1, min: 0 })}</label>
                <label class="form__inline-item">峰值${numField('peak', v.peak, '', { step: 0.1, min: 0 })}</label>
              </div>
            </div>`
          : ''
      }`,
    onInput: (v) => {
      // 行为一变就要重绘：只有「自定系数」才显示系数区
      if (v.behavior !== formSpec.values.behavior) {
        formSpec.values = { ...formSpec.values, ...v }
        $('#formBody').innerHTML = formSpec.render(formSpec.values)
        validateForm(false)
      }
    },
    validate: (v) => {
      if (!String(v.name || '').trim()) return '名称不能为空'
      if (MANUAL_MODES.some((entry) => entry.id !== data.id && entry.name === String(v.name).trim())) {
        return '名称重复'
      }
      if (v.behavior !== 'custom') return null
      if ([v.redLine, v.normal, v.peak].some((value) => value === null)) return '三个系数都要填写'
      return v.redLine < v.normal && v.normal < v.peak ? null : '需满足 红线 < 正常 < 峰值'
    },
    onSubmit: (v) => {
      pushPurchase()
      const target = MANUAL_MODES.find((entry) => entry.id === data.id)
      const next = {
        ...(target || data),
        name: String(v.name).trim(),
        desc: String(v.desc || '').trim(),
        behavior: v.behavior,
        participates: v.behavior === 'custom',
        redLine: v.redLine ?? data.redLine,
        normal: v.normal ?? data.normal,
        peak: v.peak ?? data.peak,
      }
      if (target) Object.assign(target, next)
      else MANUAL_MODES.push(next)
      renderManualModes()
      renderManualSkus()
      markPurchaseDirty('strategy')
      toast(isNew ? `已新增「${next.name}」` : `已更新「${next.name}」`)
    },
  })
}

function editManualSkuDialog(item) {
  const isNew = !item
  const skuOptions = INVENTORY.flatMap((group) =>
    group.children.map((child) => ({
      value: `${group.product}|${child.color}`,
      label: `${group.product} / ${child.color}`,
    })),
  )
  const data = item || {
    id: 'sample',
    product: INVENTORY[0].product,
    color: INVENTORY[0].children[0].color,
    modeId: MANUAL_MODES[0].id,
    redLine: 20,
    normal: 40,
    peak: 60,
  }
  const skuValue = `${data.product}|${data.color}`

  openForm({
    title: isNew ? '新增手动 SKU' : '编辑手动 SKU',
    values: { ...data, sku: skuValue },
    render: (v) => {
      const mode = MANUAL_MODES.find((entry) => entry.id === v.modeId)
      return `
        ${formRow('SKU', isNew ? selectField('sku', v.sku, skuOptions) : `<span class="form__static">${esc(data.product)} / ${esc(data.color)}</span>`)}
        ${formRow(
          '模式',
          selectField(
            'modeId',
            v.modeId,
            MANUAL_MODES.map((entry) => ({ value: entry.id, label: entry.name })),
          ),
        )}
        ${
          mode?.participates
            ? `<div class="form__group">
                <div class="form__group-head">备货系数<span class="form__group-unit">单位：条</span></div>
                <div class="form__inline">
                  <label class="form__inline-item">红线${numField('redLine', v.redLine, '', { step: 0.1, min: 0 })}</label>
                  <label class="form__inline-item">正常${numField('normal', v.normal, '', { step: 0.1, min: 0 })}</label>
                  <label class="form__inline-item">峰值${numField('peak', v.peak, '', { step: 0.1, min: 0 })}</label>
                </div>
              </div>`
            : `<p class="form__empty">该模式不参与备货计算，无需填系数</p>`
        }`
    },
    validate: (v) => {
      const mode = MANUAL_MODES.find((entry) => entry.id === v.modeId)
      if (!mode) return '请选择模式'
      if (!mode.participates) return null
      if ([v.redLine, v.normal, v.peak].some((value) => value === null)) return '三个系数都要填写'
      return v.redLine < v.normal && v.normal < v.peak ? null : '需满足 红线 < 正常 < 峰值'
    },
    onSubmit: (v) => {
      pushPurchase()
      const [product, color] = String(v.sku || skuValue).split('|')
      const mode = MANUAL_MODES.find((entry) => entry.id === v.modeId)
      const target = MANUAL_SKUS.find((entry) => entry.id === data.id)
      const next = {
        id: `${product}-${color}`,
        product,
        color,
        modeId: v.modeId,
        redLine: mode.participates ? v.redLine : undefined,
        normal: mode.participates ? v.normal : undefined,
        peak: mode.participates ? v.peak : undefined,
      }
      if (target) Object.assign(target, next)
      else MANUAL_SKUS.push(next)
      state.manualSelected.delete(data.id)
      renderManualSkus()
      markPurchaseDirty('strategy')
      toast(isNew ? `已新增 ${product} / ${color}` : '已更新手动策略')
    },
  })
}

/* ---------------- 设置：下单主数据 ---------------- */
function rowActs(kind, id, lockDelete = false) {
  return `<span class="row-acts">
    <button class="icon-btn" data-edit-row="${kind}:${id}" title="编辑">
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M11.1 2.6 13.4 4.9 5.9 12.4l-3 .7.7-3 7.5-7.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      </svg>
    </button>
    <button class="icon-btn" data-del-row="${kind}:${id}" title="${lockDelete ? '内置模式不可删除' : '删除'}" ${
      lockDelete ? 'disabled' : ''
    }>
      <svg viewBox="0 0 16 16" fill="none">
        <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </span>`
}

function renderFactories() {
  $('#factoryBody').innerHTML = FACTORIES.map(
    (item) => `
    <tr>
      <td>${esc(item.name)}</td>
      <td>${item.enabled ? '<span class="tag">启用</span>' : '<span class="tag tag--muted">停用</span>'}</td>
      <td class="is-num">${rowActs('factory', item.id)}</td>
    </tr>`,
  ).join('')

  const on = FACTORIES.filter((item) => item.enabled).length
  $('#factoryHint').textContent = `共 ${FACTORIES.length} 家 · ${on} 家启用`
  $('#railFactoryMeta').textContent = `${FACTORIES.length} 家 · ${on} 家启用`
}

function renderPeople() {
  $('#peopleBody').innerHTML = PEOPLE.map(
    (item) => `
    <tr>
      <td>${esc(item.category)}</td>
      <td>
        <span class="chips">
          ${item.people.map((name) => `<span class="chip">${esc(name)}</span>`).join('')}
          ${item.people.length ? '' : '<span class="meta">未分配</span>'}
        </span>
      </td>
      <td class="is-num">${rowActs('people', item.id)}</td>
    </tr>`,
  ).join('')
  $('#peopleHint').textContent = `${PEOPLE.length} 个分类 · 未分配的分类不参与分单`
  $('#railPeopleMeta').textContent = `${PEOPLE.length} 个分类`
}

function renderSkuFactories() {
  const keyword = ($('#skuFactorySearch')?.value || '').trim().toLowerCase()
  const rows = SKU_FACTORIES.filter((item) =>
    `${item.id} ${item.product} ${item.color} ${item.category}`.toLowerCase().includes(keyword),
  )

  $('#skuFactoryBody').innerHTML = rows.length
    ? rows
        .map(
          (item) => `
      <tr>
        <td class="meta">${esc(item.id)}</td>
        <td>${esc(item.product)} / ${esc(item.color)}</td>
        <td class="meta">${esc(item.category)}</td>
        <td>
          <span class="chips">
            ${item.factories.map((name) => `<span class="chip">${esc(name)}</span>`).join('')}
          </span>
        </td>
        <td class="is-num">${rowActs('sku-factory', item.id)}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="table-empty">没有匹配的 SKU</td></tr>'

  $('#skuFactoryCount').textContent = `${SKU_FACTORIES.length} 个 SKU 有约束`
  $('#skuFactoryHint').textContent = keyword
    ? `匹配 ${rows.length} 个`
    : '未列出的 SKU 默认全部启用染厂可选'
  $('#railSkuMeta').textContent = `${SKU_FACTORIES.length} 个 SKU 有约束`
}

/* ---------------- 设置：缸规则 ---------------- */
// 一条规则 = 判定依据 + 一组「上限 → 动作」档位。单位跟着判定依据走：
// 需安排是公斤，月均条数（SKU/SPU）是条。
const VAT_BAND_KEYS = [
  { value: 'planned', label: '需安排（公斤）', unit: '公斤' },
  { value: 'skuMonthlyAvg', label: 'SKU 月均条数', unit: '条' },
  { value: 'spuMonthlyAvg', label: 'SPU 月均条数合计', unit: '条' },
]
const VAT_ACTIONS = [
  { value: 'skip', label: '不下单', valueLabel: '' },
  { value: 'fixed', label: '固定下单量', valueLabel: '固定量' },
  { value: 'vat', label: '按每缸取整', valueLabel: '每缸' },
  { value: 'round', label: '取整到步长', valueLabel: '步长' },
]
const VAT_REMAINDER_SHORT = { nearest: '就近', floor: '舍弃', ceil: '补足' }
const VAT_REMAINDERS = [
  { value: 'nearest', label: '就近（余量过半补一缸）' },
  { value: 'floor', label: '舍弃（只下整缸）' },
  { value: 'ceil', label: '补足（不足一缸也下一缸）' },
]

function vatUnitOf(rule) {
  return VAT_BAND_KEYS.find((item) => item.value === rule.bandKey)?.unit ?? '公斤'
}

function vatBandRangeText(bands, index) {
  const prev = index > 0 ? bands[index - 1].upTo : null
  const cur = bands[index].upTo
  if (cur === null) return prev === null ? '全部' : `> ${fmt(prev)}`
  if (prev === null) return `≤ ${fmt(cur)}`
  return `${fmt(prev)} ~ ${fmt(cur)}`
}

function vatActionText(band, unit) {
  if (band.action === 'skip') return '不下单'
  const value = fmt(band.value)
  if (band.action === 'fixed') return `固定 ${value} ${unit}`
  if (band.action === 'vat') return `每缸 ${value} ${unit}`
  return `按 ${value} ${unit} 取整`
}

function vatRuleUsage(ruleId) {
  return Object.values(VAT_SPU).filter((id) => id === ruleId).length
}

function vatSpuRows() {
  return INVENTORY.map((group) => {
    const monthly = group.children.reduce(
      (sum, child) => sum + (child.monthlyAvg ?? Math.round((child.weekly ?? 0) * 4.3)),
      0,
    )
    return { product: group.product, skuCount: group.children.length, monthlyAvg: monthly }
  })
}

// 品名 → 规则：未绑定返回 ''（表示走默认）
function vatRuleOf(product) {
  return VAT_SPU[product] ?? ''
}

function renderVat() {
  const options = VAT_RULES.map(
    (rule) => `<option value="${rule.id}"${rule.id === VAT_DEFAULT_RULE ? ' selected' : ''}>${esc(rule.name)}</option>`,
  ).join('')
  $('#vatDefaultRule').innerHTML = options

  // 规则表：区间与动作一列里把所有档位摊开，一眼能看到阈值阶梯
  $('#vatRuleBody').innerHTML = VAT_RULES.length
    ? VAT_RULES.map((rule) => {
        const unit = vatUnitOf(rule)
        const usage = vatRuleUsage(rule.id)
        return `
        <tr>
          <td>
            <div class="vat-name">${esc(rule.name)}${
              rule.id === VAT_DEFAULT_RULE ? '<span class="tag">默认</span>' : ''
            }</div>
            <div class="vat-name__meta">${esc(
              VAT_BAND_KEYS.find((item) => item.value === rule.bandKey)?.label ?? '',
            )} · 零头${esc(VAT_REMAINDER_SHORT[rule.remainder] ?? '就近')}</div>
          </td>
          <td>
            <div class="vat-bands">
              ${rule.bands
                .map(
                  (band, index) => `<span class="vat-bands__item"><em>${vatBandRangeText(
                    rule.bands,
                    index,
                  )}</em>${vatActionText(band, unit)}</span>`,
                )
                .join('')}
            </div>
          </td>
          <td class="is-num">${usage}</td>
          <td class="is-num">${rowActs('vat-rule', rule.id)}</td>
        </tr>`
      }).join('')
    : '<tr><td colspan="4" class="table-empty">还没有缸规则</td></tr>'

  const spus = vatSpuRows()
  $('#vatRuleHint').textContent = `未绑定的品名使用默认规则`
  $('#railVatMeta').textContent = `${VAT_RULES.length} 条规则`
  $('#vatRuleMeta').textContent = `共 ${VAT_RULES.length} 条规则 · ${spus.length} 个品名`

  renderVatSpu()
}

function renderVatSpu() {
  const keyword = ($('#vatSpuSearch')?.value || '').trim().toLowerCase()
  const rows = vatSpuRows().filter((row) => row.product.toLowerCase().includes(keyword))
  const defaultName = VAT_RULES.find((rule) => rule.id === VAT_DEFAULT_RULE)?.name ?? '无'

  $('#vatSpuBody').innerHTML = rows.length
    ? rows
        .map(
          (row) => `
      <tr>
        <td class="vat-spu__product" title="${esc(row.product)}">${esc(row.product)}</td>
        <td class="is-num">${row.skuCount}</td>
        <td class="is-num">${fmt(row.monthlyAvg)}</td>
        <td>
          <select class="input input--cell" data-vat-spu="${esc(row.product)}">
            <option value=""${vatRuleOf(row.product) === '' ? ' selected' : ''}>默认（${esc(defaultName)}）</option>
            ${VAT_RULES.map(
              (rule) =>
                `<option value="${rule.id}"${vatRuleOf(row.product) === rule.id ? ' selected' : ''}>${esc(
                  rule.name,
                )}</option>`,
            ).join('')}
            <option value="__none__"${vatRuleOf(row.product) === '__none__' ? ' selected' : ''}>不取整（按原样下单）</option>
          </select>
        </td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="table-empty">${
        keyword ? '没有匹配的品名' : '还没有品名数据'
      }</td></tr>`

  const bound = Object.keys(VAT_SPU).length
  $('#vatSpuMeta').textContent = `${bound} 个品名单独绑定 · 其余走默认`
  $('#vatBulkRule').innerHTML =
    '<option value="">选择规则批量套用</option>' +
    VAT_RULES.map((rule) => `<option value="${rule.id}">${esc(rule.name)}</option>`).join('') +
    '<option value="__none__">不取整</option>'
}

/* ---------------- 设置：分单人员表 ---------------- */
function renderPoPeople() {
  $('#poPeopleBody').innerHTML = PO_PEOPLE_LIST.length
    ? PO_PEOPLE_LIST.map((name) => {
        const cats = PEOPLE.filter((entry) => entry.people.includes(name)).map((entry) => entry.category)
        return `
      <tr>
        <td>${esc(name)}</td>
        <td class="is-num">${
          cats.length ? `<span class="chips">${cats.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</span>` : '<span class="meta">未分配</span>'
        }</td>
        <td class="is-num">
          <button class="icon-btn icon-btn--sm" data-del="person" data-id="${esc(name)}" title="移除">×</button>
        </td>
      </tr>`
      }).join('')
    : '<tr><td colspan="3" class="table-empty">还没有分单人员</td></tr>'

  $('#poPeopleHint').textContent = `${PO_PEOPLE_LIST.length} 人 · 分单时先按树形分类找人`
  $('#railPeopleListMeta').textContent = `${PO_PEOPLE_LIST.length} 人`
}

/* ---------------- 设置：缸规则编辑器 ---------------- */
// 弹窗里的档位可以增删，所以每次改动都从 DOM 回收一次 bands，再整块重绘。
function vatBandsFromValues(v) {
  const list = v.bands ?? []
  return list.map((band, index) => ({
    upTo: index === list.length - 1 ? null : v[`band-${index}-upTo`] ?? null,
    action: v[`band-${index}-action`] ?? band.action,
    value: band.action === 'skip' && !v[`band-${index}-value`] ? 0 : v[`band-${index}-value`] ?? 0,
  }))
}

// 用当前档位模拟一次下单：先按判定依据落档，再按动作算缸数与下单量。
function vatSimulate(values, need, metric) {
  const bands = vatBandsFromValues(values)
  if (!bands.length) return ''
  const key = values.bandKey === 'planned' ? Number(need) || 0 : Number(metric) || 0
  const band = bands.find((item, index) => index === bands.length - 1 || (item.upTo != null && key <= item.upTo))
  if (!band || band.action === 'skip') return `落在 ${vatBandRangeText(bands, bands.indexOf(band))} → 不下单`
  const rangeText = vatBandRangeText(bands, bands.indexOf(band))

  if (band.action === 'fixed') return `落在 ${rangeText} → 固定下单 ${fmt(band.value)} 公斤`
  if (band.action === 'round') {
    const step = Math.max(1, Number(band.value) || 1)
    const kg = Math.round(Number(need) / step) * step
    return `落在 ${rangeText} → 按 ${fmt(step)} 取整，下单 ${fmt(kg)} 公斤`
  }
  const perVat = Math.max(1, Number(band.value) || 1)
  const raw = (Number(need) || 0) / perVat
  const minVats = Math.max(0, Number(values.minVats) || 0)
  let vats = 0
  if (values.remainder === 'ceil') vats = Math.ceil(raw)
  else if (values.remainder === 'floor') vats = Math.floor(raw)
  else vats = Math.floor(raw) + (raw - Math.floor(raw) >= (Number(values.threshold) || 0.5) ? 1 : 0)
  if ((Number(need) || 0) > 0) vats = Math.max(vats, minVats || 1)
  return `落在 ${rangeText} → 每缸 ${fmt(perVat)} 公斤，${vats} 缸 = ${fmt(vats * perVat)} 公斤`
}

function editVatRuleDialog(rule) {
  const isNew = !rule
  openForm({
    title: isNew ? '新增缸规则' : '编辑缸规则',
    wide: true,
    kind: 'vat',
    note: '上限按从小到大串联，最后一档固定无上限；判定依据落在哪一档，就按该档的处理方式算整缸。',
    values: {
      name: rule?.name ?? '',
      bandKey: rule?.bandKey ?? 'planned',
      remainder: rule?.remainder ?? 'nearest',
      threshold: rule?.threshold ?? 0.5,
      minVats: rule?.minVats ?? 1,
      trial: 1000,
      trialMetric: 300,
      bands: JSON.parse(
        JSON.stringify(rule?.bands ?? [{ upTo: null, action: 'vat', value: 100 }]),
      ),
    },
    render: (v) => {
      const unit = VAT_BAND_KEYS.find((item) => item.value === v.bandKey)?.unit ?? '公斤'
      const bands = v.bands ?? []
      return `
      <div class="form__grid form__grid--3">
        ${formRow('规则名称', textField('name', v.name, { placeholder: '例如：标准大货补单' }))}
        ${formRow(
          '判定依据',
          selectField(
            'bandKey',
            v.bandKey,
            VAT_BAND_KEYS.map((item) => ({ value: item.value, label: item.label })),
          ),
        )}
        ${formRow(
          '零头处理',
          selectField(
            'remainder',
            v.remainder,
            VAT_REMAINDERS.map((item) => ({ value: item.value, label: item.label })),
          ),
        )}
      </div>
      <div class="form__grid form__grid--3">
        ${formRow('补缸阈值', numField('threshold', v.threshold, '余量占比', { min: 0.05, max: 1, step: 0.05 }))}
        ${formRow('至少几缸', numField('minVats', v.minVats, '缸', { min: 0, max: 99 }))}
        ${formRow('', '')}
      </div>

      <div class="vat-edit">
        <div class="vat-edit__head">
          <span>区间</span>
          <span>上限（${esc(unit)}）</span>
          <span>处理方式</span>
          <span>参数</span>
          <span></span>
        </div>
        ${bands
          .map(
            (band, index) => `
          <div class="vat-edit__row">
            <span class="vat-edit__range">${vatBandRangeText(bands, index)}</span>
            ${
              index < bands.length - 1
                ? numField(`band-${index}-upTo`, band.upTo, '', { min: 1 })
                : '<span class="meta vat-edit__none">无上限</span>'
            }
            ${selectField(
              `band-${index}-action`,
              band.action,
              VAT_ACTIONS.map((item) => ({ value: item.value, label: item.label })),
            )}
            ${
              band.action === 'skip'
                ? '<span class="meta vat-edit__none">—</span>'
                : numField(`band-${index}-value`, band.value, unit === '条' ? '条' : '公斤', { min: 0 })
            }
            <button type="button" class="icon-btn icon-btn--sm" data-band-del="${index}" title="删除该档" ${
              bands.length <= 1 ? 'disabled' : ''
            }>×</button>
          </div>`,
          )
          .join('')}
        <div class="vat-edit__foot">
          <button type="button" class="btn btn--text btn--sm" data-band-add>＋ 新增阈值</button>
          <span class="vat-edit__trial" id="vatTrial"></span>
        </div>
      </div>

      <div class="form__grid form__grid--3">
        ${formRow('试算需安排', numField('trial', v.trial, '公斤', { min: 0, step: 10 }))}
        ${formRow(
          '试算判据值',
          numField('trialMetric', v.trialMetric, unit === '条' ? '条' : '公斤', { min: 0, step: 10 }),
        )}
        ${formRow('', '')}
      </div>`
    },
    onInput: (v) => {
      const slot = $('#vatTrial')
      if (slot) slot.textContent = vatSimulate(v, v.trial, v.trialMetric)
    },
    validate: (v) => {
      if (!String(v.name || '').trim()) return '规则名称不能为空'
      if (VAT_RULES.some((item) => item.id !== rule?.id && item.name === String(v.name).trim())) {
        return '规则名称重复'
      }
      const bands = vatBandsFromValues(v)
      for (let i = 0; i < bands.length - 1; i += 1) {
        if (bands[i].upTo === null) return `第 ${i + 1} 档上限不能为空`
        if (i > 0 && !(bands[i].upTo > bands[i - 1].upTo)) return `第 ${i + 1} 档上限需大于上一档`
        if (bands[i].action !== 'skip' && !(bands[i].value > 0)) return `第 ${i + 1} 档参数需大于 0`
      }
      const last = bands[bands.length - 1]
      if (last.action !== 'skip' && !(last.value > 0)) return '最后一档参数需大于 0'
      return null
    },
    onSubmit: (v) => {
      pushPurchase()
      const payload = {
        name: String(v.name).trim(),
        bandKey: v.bandKey,
        remainder: v.remainder,
        threshold: v.threshold,
        minVats: v.minVats,
        bands: vatBandsFromValues(v),
      }
      if (isNew) VAT_RULES.push({ id: `v${Date.now()}`, ...payload })
      else Object.assign(rule, payload)
      renderVat()
      markPurchaseDirty('vat')
      toast(isNew ? '已新增缸规则' : '缸规则已更新')
    },
  })
}

function editPersonDialog() {
  openForm({
    title: '新增分单人员',
    narrow: true,
    values: { name: '' },
    render: (v) => formRow('姓名', textField('name', v.name, { placeholder: '例如：阿婷' })),
    validate: (v) => {
      const name = String(v.name || '').trim()
      if (!name) return '姓名不能为空'
      if (PO_PEOPLE_LIST.includes(name)) return '该人员已存在'
      return null
    },
    onSubmit: (v) => {
      pushPurchase()
      PO_PEOPLE_LIST.push(String(v.name).trim())
      renderPoPeople()
      renderPeople()
      markPurchaseDirty('people')
      toast('已添加分单人员')
    },
  })
}

function editFactoryDialog(item) {
  const isNew = !item
  const data = item || { id: `f-${Date.now()}`, name: '', enabled: true, orders: 0 }

  openForm({
    title: isNew ? '新增染厂' : '编辑染厂',
    values: { ...data },
    render: (v) => `
      ${formRow('染厂名称', textField('name', v.name, { placeholder: '与合同、对账单一致' }))}
      ${formRow('启用', switchField('enabled', v.enabled), '停用后不再出现在下单下拉里')}
      ${!isNew && data.orders ? `<p class="form__empty">已有 ${data.orders} 张分订单使用，停用或改名不影响这些订单的原厂名</p>` : ''}`,
    validate: (v) => {
      if (!v.name.trim()) return '染厂名称不能为空'
      if (FACTORIES.some((entry) => entry.id !== data.id && entry.name === v.name.trim())) return '名称重复'
      return null
    },
    onSubmit: (v) => {
      pushPurchase()
      const target = FACTORIES.find((entry) => entry.id === data.id)
      if (target) Object.assign(target, { name: v.name.trim(), enabled: v.enabled })
      else FACTORIES.push({ ...data, name: v.name.trim(), enabled: v.enabled })
      renderFactories()
      renderSkuFactories()
      markPurchaseDirty('factories')
      toast(isNew ? '已新增染厂' : '已更新染厂')
    },
  })
}

function editPeopleDialog(item) {
  const isNew = !item
  const data = item || { id: `p-${Date.now()}`, category: '', people: [] }

  openForm({
    title: isNew ? '新增分类' : '编辑分单人员',
    values: { ...data, people: [...data.people] },
    render: (v) => `
      ${formRow(
        '树形分类',
        isNew
          ? `<input class="input" data-key="category" list="category-options" value="${esc(v.category)}" placeholder="与产品资料一致" />
             <datalist id="category-options">${['经编网布', '其他', '涤纶网布', '锦纶网布', '交织网布', '瑞士网']
               .map((name) => `<option value="${name}"></option>`)
               .join('')}</datalist>`
          : `<span class="form__static">${esc(data.category)}</span>`,
      )}
      ${formRow('分单人员', tagsField('people', v.people, STAFF_POOL, '选择或输入姓名'), '回车添加，末位人员负责兜底')}`,
    validate: (v) => {
      if (!isNew) return null
      if (!String(v.category || '').trim()) return '树形分类不能为空'
      if (PEOPLE.some((entry) => entry.category === v.category.trim())) return '该分类已存在'
      return null
    },
    onSubmit: (v) => {
      pushPurchase()
      const target = PEOPLE.find((entry) => entry.id === data.id)
      if (target) target.people = v.people
      else PEOPLE.push({ ...data, category: v.category.trim(), people: v.people })
      renderPeople()
      markPurchaseDirty('people')
      toast(isNew ? '已新增分类' : '已更新分单人员')
    },
  })
}

function editSkuFactoryDialog(item) {
  const isNew = !item
  const skuOptions = INVENTORY.flatMap((group) =>
    group.children.map((child) => ({
      value: `${group.product}|${child.color}`,
      label: `${group.product} / ${child.color}`,
    })),
  )
  const data = item || { id: '', product: INVENTORY[0].product, color: INVENTORY[0].children[0].color, category: '', factories: [] }
  const enabledNames = FACTORIES.filter((entry) => entry.enabled).map((entry) => entry.name)

  openForm({
    title: isNew ? '新增 SKU 染厂约束' : '编辑可选染厂',
    note: '留空表示该 SKU 可以用全部启用染厂。',
    values: { ...data, factories: [...data.factories], sku: `${data.product}|${data.color}` },
    render: (v) => `
      ${formRow('SKU', isNew ? selectField('sku', v.sku, skuOptions) : `<span class="form__static">${esc(data.product)} / ${esc(data.color)}</span>`)}
      ${formRow('可选染厂', tagsField('factories', v.factories, enabledNames, '从启用染厂中选择'))}`,
    validate: () => null,
    onSubmit: (v) => {
      pushPurchase()
      const [product, color] = String(v.sku || `${data.product}|${data.color}`).split('|')
      const id = `${product}-${color}`
      const category = SKU_FACTORIES.find((entry) => entry.id === id)?.category || PEOPLE[0].category
      const target = SKU_FACTORIES.find((entry) => entry.id === data.id)
      if (target) {
        target.factories = v.factories
      } else {
        SKU_FACTORIES.push({ id, product, color, category, factories: v.factories })
      }
      renderSkuFactories()
      markPurchaseDirty('sku-factories')
      toast(isNew ? '已新增约束' : '已更新可选染厂')
    },
  })
}

const RAIL_PANEL = {
  'manual-mode': 'strategy',
  'manual-sku': 'strategy',
  'vat-rule': 'vat',
  factory: 'factories',
  people: 'categories',
  person: 'people',
  'sku-factory': 'sku-factories',
}

const ROW_EDIT = {
  'manual-mode': editManualModeDialog,
  'manual-sku': editManualSkuDialog,
  'vat-rule': editVatRuleDialog,
  factory: editFactoryDialog,
  people: editPeopleDialog,
  'sku-factory': editSkuFactoryDialog,
}

function rowById(kind, id) {
  if (kind === 'manual-mode') return MANUAL_MODES.find((entry) => entry.id === id)
  if (kind === 'manual-sku') return MANUAL_SKUS.find((entry) => entry.id === id)
  if (kind === 'vat-rule') return VAT_RULES.find((entry) => entry.id === id)
  if (kind === 'factory') return FACTORIES.find((entry) => entry.id === id)
  if (kind === 'people') return PEOPLE.find((entry) => entry.id === id)
  return SKU_FACTORIES.find((entry) => entry.id === id)
}

function deleteRow(kind, id) {
  const item = rowById(kind, id)
  if (!item) return
  const name = item.name || item.category || item.id || `${item.product} / ${item.color}`
  openConfirm({
    title: '确认删除',
    note:
      kind === 'factory' && item.orders
        ? `删除「${name}」后，已有 ${item.orders} 张分订单仍保留原厂名，新订单不再出现该染厂。`
        : `删除「${name}」后不可恢复。`,
    onOk: () => {
      pushPurchase()
      if (kind === 'manual-mode') MANUAL_MODES = MANUAL_MODES.filter((entry) => entry.id !== id)
      if (kind === 'manual-sku') MANUAL_SKUS = MANUAL_SKUS.filter((entry) => entry.id !== id)
      if (kind === 'vat-rule') {
        VAT_RULES = VAT_RULES.filter((entry) => entry.id !== id)
        if (VAT_DEFAULT_RULE === id) VAT_DEFAULT_RULE = VAT_RULES[0]?.id ?? ''
        Object.keys(VAT_SPU).forEach((product) => {
          if (VAT_SPU[product] === id) delete VAT_SPU[product]
        })
      }
      if (kind === 'factory') FACTORIES = FACTORIES.filter((entry) => entry.id !== id)
      if (kind === 'people') PEOPLE = PEOPLE.filter((entry) => entry.id !== id)
      if (kind === 'sku-factory') SKU_FACTORIES = SKU_FACTORIES.filter((entry) => entry.id !== id)
      renderManualModes()
      renderManualSkus()
      renderVat()
      renderFactories()
      renderPeople()
      renderSkuFactories()
      markPurchaseDirty(RAIL_PANEL[kind])
      toast('已删除')
    },
  })
}

/* ---------------- 设置：事件 ---------------- */
function renderConfig() {
  renderModeList()
  renderEditor()
  renderWeights()
  renderScoring()
  renderGrades()
  renderManualModes()
  renderManualSkus()
  renderVat()
  renderFactories()
  renderPeople()
  renderPoPeople()
  renderSkuFactories()
}

document.addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit]')
  if (edit) {
    const map = { mode: editModeDialog, weights: editWeightsDialog, scoring: editScoringDialog, spu: editSpuDialog }
    map[edit.dataset.edit]?.()
    return
  }

  const add = event.target.closest('[data-add]')
  if (add) {
    const map = {
      'manual-mode': () => editManualModeDialog(null),
      'manual-sku': () => editManualSkuDialog(null),
      'vat-rule': () => editVatRuleDialog(null),
      factory: () => editFactoryDialog(null),
      people: () => editPeopleDialog(null),
      category: () => editPeopleDialog(null),
      'sku-factory': () => editSkuFactoryDialog(null),
      person: () => editPersonDialog(),
    }
    map[add.dataset.add]?.()
    return
  }

  const rowEdit = event.target.closest('[data-edit-row]')
  if (rowEdit) {
    const [kind, id] = rowEdit.dataset.editRow.split(':')
    ROW_EDIT[kind]?.(rowById(kind, id))
    return
  }

  const rowDel = event.target.closest('[data-del-row]')
  if (rowDel) {
    const [kind, id] = rowDel.dataset.delRow.split(':')
    deleteRow(kind, id)
  }
})

$('#modeList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-mode]')
  if (!item) return
  state.activeMode = item.dataset.mode
  renderModeList()
  renderEditor()
})

$$('[data-strategy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-strategy]').forEach((el) => {
      const active = el === btn
      el.classList.toggle('is-active', active)
      el.setAttribute('aria-selected', String(active))
    })
    const manual = btn.dataset.strategy === 'manual'
    $('#autoStrategy').hidden = manual
    $('#manualStrategy').hidden = !manual
  })
})

$('#manualSkuBody').addEventListener('change', (event) => {
  const box = event.target.closest('[data-manual-check]')
  if (!box) return
  if (box.checked) state.manualSelected.add(box.dataset.manualCheck)
  else state.manualSelected.delete(box.dataset.manualCheck)
  renderManualSkus()
})

$('#manualAll').addEventListener('change', (event) => {
  state.manualSelected = event.target.checked ? new Set(MANUAL_SKUS.map((item) => item.id)) : new Set()
  renderManualSkus()
})

$('#manualBulkBtn').addEventListener('click', () => {
  openConfirm({
    title: '恢复自动判定',
    note: `将 ${state.manualSelected.size} 个 SKU 从手动清单移除，改由自动策略判定。`,
    okText: '恢复',
    onOk: () => {
      pushPurchase()
      MANUAL_SKUS = MANUAL_SKUS.filter((item) => !state.manualSelected.has(item.id))
      state.manualSelected = new Set()
      renderManualSkus()
      markPurchaseDirty('strategy')
      toast('已恢复自动判定')
    },
  })
})

$('#skuFactorySearch').addEventListener('input', renderSkuFactories)

/* ---------------- 设置：草稿、校验、保存 ---------------- */
function configSnapshot() {
  return JSON.stringify({
    weights: state.weights,
    modes: MODES,
    scoring: SCORING_ROWS,
    scores: SCORING_SCORES,
    total: SCORING_TOTAL,
    grades: SPU_GRADES,
    manualModes: MANUAL_MODES,
    manualSkus: MANUAL_SKUS,
  })
}

function applyConfig(json) {
  const data = JSON.parse(json)
  state.weights = data.weights
  MODES.length = 0
  MODES.push(...data.modes)
  SCORING_ROWS = data.scoring
  SCORING_SCORES = data.scores
  SCORING_TOTAL = data.total
  SPU_GRADES = data.grades
  MANUAL_MODES = data.manualModes
  MANUAL_SKUS = data.manualSkus
  state.activeMode = MODES.some((mode) => mode.key === state.activeMode) ? state.activeMode : MODES[0].key
  state.manualSelected = new Set()
  renderConfig()
}

function pushHistory() {
  state.history.push(configSnapshot())
  if (state.history.length > 50) state.history.shift()
  state.redo = []
  syncHistoryButtons()
}

function undo() {
  if (!state.history.length) return
  state.redo.push(configSnapshot())
  applyConfig(state.history.pop())
  syncHistoryButtons()
  markDirty()
}

function redo() {
  if (!state.redo.length) return
  state.history.push(configSnapshot())
  applyConfig(state.redo.pop())
  syncHistoryButtons()
  markDirty()
}

function syncHistoryButtons() {
  $('#undoBtn').disabled = state.history.length === 0
  $('#redoBtn').disabled = state.redo.length === 0
}

// 保存前先跑一遍规则自检：不通过时禁用保存，并把原因挂在状态标签上
function configIssues() {
  const issues = []
  const total = weightTotal()
  if (total !== 100) issues.push(`销量加权合计 ${total}%，需为 100%`)

  const weightSum = scoringWeightTotal()
  if (weightSum !== 100) issues.push(`评分权重合计 ${weightSum}%，需为 100%`)

  SCORING_ROWS.forEach((row) => {
    TIERS.forEach(([tier, label]) => {
      const range = row[tier]
      if (range.from !== null && range.to !== null && range.from > range.to) {
        issues.push(`${row.label} 的${label}风险区间下限大于上限`)
      }
    })
  })

  MODES.filter((mode) => mode.participates).forEach((mode) => {
    mode.rows.forEach((row) => {
      if (!(row.redLine < row.normal && row.normal < row.peak)) {
        issues.push(`${mode.name} · ${row.color} 系数需满足 红线 < 正常 < 峰值`)
      }
    })
  })

  return issues
}

function refreshConfigState() {
  const issues = configIssues()
  const save = $('#saveBtn')
  const label = $('#saveState')
  save.disabled = !state.dirty || issues.length > 0
  save.title = issues.length ? issues.join('；') : ''
  label.classList.toggle('state--dirty', state.dirty)
  label.classList.toggle('state--error', issues.length > 0)
  label.textContent = issues.length ? `待修正 ${issues.length} 项` : state.dirty ? '未保存' : '已保存'
  label.title = issues.length ? issues.join('\n') : ''
}

const STOCKING_PANELS = ['strategy', 'weights', 'scoring', 'spu']
const PURCHASE_PANELS = ['vat', 'factories', 'people', 'categories', 'sku-factories']

function syncDirtyMarkers() {
  $$('.rail__item').forEach((item) => {
    item.classList.toggle('is-dirty', state.dirtyPanels.has(item.dataset.panel))
  })
}

function markDirty(section) {
  state.dirty = true
  if (section) state.dirtyPanels.add(section)
  syncDirtyMarkers()
  $('#discardBtn').disabled = false
  refreshConfigState()
}

function markClean() {
  state.dirty = false
  state.history = []
  state.redo = []
  STOCKING_PANELS.forEach((panel) => state.dirtyPanels.delete(panel))
  syncDirtyMarkers()
  syncHistoryButtons()
  refreshConfigState()
}

/* 下单配置：单套设置，独立于备货方案，有自己的放弃 / 确定 */
let purchaseBackup = null

function pushPurchase() {
  if (purchaseBackup) return
  purchaseBackup = JSON.stringify({
    factories: FACTORIES,
    people: PEOPLE,
    skus: SKU_FACTORIES,
    manualModes: MANUAL_MODES,
    manualSkus: MANUAL_SKUS,
  })
}

function markPurchaseDirty(section) {
  if (section) state.dirtyPanels.add(section)
  syncDirtyMarkers()
  $('#purchaseState').textContent = '未保存'
  $('#purchaseState').classList.add('state--dirty')
  $('#purchaseOk').disabled = false
  $('#purchaseDiscard').disabled = false
}

function markPurchaseClean() {
  purchaseBackup = null
  PURCHASE_PANELS.forEach((panel) => state.dirtyPanels.delete(panel))
  syncDirtyMarkers()
  $('#purchaseState').textContent = '已保存'
  $('#purchaseState').classList.remove('state--dirty')
  $('#purchaseOk').disabled = true
  $('#purchaseDiscard').disabled = true
}

$('#undoBtn').addEventListener('click', undo)
$('#redoBtn').addEventListener('click', redo)
$('#saveBtn').addEventListener('click', () => {
  const issues = configIssues()
  if (issues.length) {
    toast(issues[0])
    return
  }
  markClean()
  toast('已保存到 src/stocking/config.json')
})
$('#discardBtn').addEventListener('click', () => {
  if (state.history.length) applyConfig(state.history[0])
  markClean()
})

$('#purchaseOk').addEventListener('click', () => {
  markPurchaseClean()
  toast('已保存到 src/purchase/settings.json')
})
$('#purchaseDiscard').addEventListener('click', () => {
  if (purchaseBackup) {
    const data = JSON.parse(purchaseBackup)
    FACTORIES = data.factories
    PEOPLE = data.people
    SKU_FACTORIES = data.skus
    MANUAL_MODES = data.manualModes
    MANUAL_SKUS = data.manualSkus
    state.manualSelected = new Set()
    renderManualModes()
    renderManualSkus()
    renderFactories()
    renderPeople()
    renderSkuFactories()
  }
  markPurchaseClean()
})

document.addEventListener('keydown', (event) => {
  if (state.screen !== 'config' || !(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  if (key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
  }
  if (key === 'y') {
    event.preventDefault()
    redo()
  }
})

/* 方案菜单 */
const profileBtn = $('#profileBtn')
const profileMenu = $('#profileMenu')
profileBtn.addEventListener('click', (event) => {
  event.stopPropagation()
  profileMenu.hidden = !profileMenu.hidden
})
document.addEventListener('click', (event) => {
  if (!profileMenu.hidden && !event.target.closest('.menu-anchor')) profileMenu.hidden = true
})

/* 演示按钮 */
document.addEventListener('click', (event) => {
  const demo = event.target.closest('[data-demo]')
  if (!demo) return
  if (demo.classList.contains('menu__item')) profileMenu.hidden = true
  toast(demo.dataset.demo)
})

/* ---------------- 采购下单 ---------------- */
// 左侧是待下单 SKU 表，右侧是该 SKU 的分订单明细表；两处都是表格，不再用卡片。
const PO_FACTORIES = [
  '连江东禾晟',
  '福清长福',
  '长乐华鹤',
  '汕头兴滨染厂',
  '清远千百丽',
  '连江俊诚(华阳)',
  '久顺',
  '长乐力宏',
]

const PO_PEOPLE = ['阿婷', '刘玉红', '小凤', '钟秋兰', '刘燕', '小良']

// 分订单 = { factory, assignee, vats(缸数), kg(公斤), note }；缸数与公斤双向联动
const PURCHASE_SKUS = [
  {
    id: 'po-1',
    product: '巴哈斯',
    color: '102#玫红',
    category: '涤纶网布',
    planned: 3371,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [
      { factory: '连江东禾晟', assignee: '阿婷', vats: 20, kg: 2000, note: '' },
      { factory: '福清长福', assignee: '', vats: 0, kg: 0, note: '' },
    ],
  },
  {
    id: 'po-2',
    product: '巴哈斯',
    color: '46#杏色',
    category: '涤纶网布',
    planned: 1947,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [],
  },
  {
    id: 'po-3',
    product: '巴哈斯',
    color: '49#浅兰',
    category: '涤纶网布',
    planned: 1931,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [],
  },
  {
    id: 'po-4',
    product: '巴哈斯',
    color: '2#本白',
    category: '涤纶网布',
    planned: 1411,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [],
  },
  {
    id: 'po-5',
    product: '巴哈斯',
    color: '1773#米白',
    category: '涤纶网布',
    planned: 1773,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [],
  },
  {
    id: 'po-6',
    product: '巴哈斯',
    color: '1991#深灰',
    category: '涤纶网布',
    planned: 1991,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [],
  },
  {
    id: 'po-7',
    product: '巴哈斯',
    color: '1423#浅咖',
    category: '涤纶网布',
    planned: 1423,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [],
  },
  {
    id: 'po-8',
    product: '巴哈斯',
    color: '1952#酒红',
    category: '涤纶网布',
    planned: 1952,
    rule: { name: '标准大货补单', kgPerVat: 100 },
    orders: [],
  },
  {
    id: 'po-9',
    product: '巴哈斯',
    color: '1607#藏青',
    category: '涤纶网布',
    planned: 1607,
    rule: { name: '小批量补单', kgPerVat: 50 },
    orders: [],
  },
]

const poState = { selectedId: PURCHASE_SKUS[0].id, keyword: '', onlyUnordered: false }

function poSelected() {
  return PURCHASE_SKUS.find((row) => row.id === poState.selectedId) ?? null
}

function poTotals(row) {
  return {
    kg: row.orders.reduce((sum, order) => sum + (Number(order.kg) || 0), 0),
    vats: row.orders.reduce((sum, order) => sum + (Number(order.vats) || 0), 0),
  }
}

// 建议缸数：需安排 ÷ 每缸公斤，余量过半补一缸（与 nearest 零头策略一致）
function poSuggestion(row) {
  const per = row.rule.kgPerVat
  const raw = row.planned / per
  const floor = Math.floor(raw)
  const vats = Math.max(raw - floor >= 0.5 ? floor + 1 : floor, 1)
  return { vats, kg: vats * per }
}

function poVisibleRows() {
  const keyword = poState.keyword.trim().toLowerCase()
  return PURCHASE_SKUS.filter((row) => {
    if (poState.onlyUnordered && poTotals(row).kg > 0) return false
    if (!keyword) return true
    return `${row.product}${row.color}${row.category}`.toLowerCase().includes(keyword)
  })
}

function renderPoStats() {
  const planned = PURCHASE_SKUS.reduce((sum, row) => sum + row.planned, 0)
  const totals = PURCHASE_SKUS.map(poTotals)
  const ordered = totals.reduce((sum, item) => sum + item.kg, 0)
  const vats = totals.reduce((sum, item) => sum + item.vats, 0)
  const pending = PURCHASE_SKUS.filter((row) => poTotals(row).kg === 0).length

  const items = [
    ['SKU', fmt(PURCHASE_SKUS.length), '', ''],
    ['需安排', fmt(planned), '', ''],
    ['已下单', fmt(ordered), 'is-accent', ''],
    ['缸数', fmt(vats), '', ''],
    ['未下单', fmt(pending), 'is-warn', 'pending'],
  ]

  $('#poStats').innerHTML = items
    .map(
      ([label, value, tone, filter]) => `
      <div class="po-stats__item ${filter ? 'is-clickable' : ''}"${filter ? ` data-filter="${filter}"` : ''}${
        filter ? ' title="只看未下单"' : ''
      }>
        <dt>${label}</dt>
        <dd class="${tone}">${value}</dd>
      </div>`,
    )
    .join('')
}

function renderPoList() {
  const list = poVisibleRows()
  $('#poListCount').textContent = `${list.length} / ${PURCHASE_SKUS.length}`

  if (!list.length) {
    $('#poListBody').innerHTML = `<tr><td colspan="3" class="po-empty">没有匹配的 SKU</td></tr>`
    return
  }

  $('#poListBody').innerHTML = list
    .map((row) => {
      const { kg } = poTotals(row)
      return `<tr data-sku="${row.id}" class="${row.id === poState.selectedId ? 'is-active' : ''}">
        <td class="po-mini__name" title="${row.product} · ${row.color}"><span class="po-mini__product">${
          row.product
        }</span><span class="po-mini__sep">·</span>${row.color}</td>
        <td class="is-num">${fmt(row.planned)}</td>
        <td class="is-num po-mini__ordered ${kg > 0 ? 'is-done' : 'is-zero'}">${kg > 0 ? fmt(kg) : '—'}</td>
      </tr>`
    })
    .join('')

  syncPoLink()
}

function poOrderRow(order, index, kgPerVat) {
  const factoryOptions = [`<option value="">选择染厂</option>`]
    .concat(
      PO_FACTORIES.map(
        (name) => `<option value="${name}"${name === order.factory ? ' selected' : ''}>${name}</option>`,
      ),
    )
    .join('')
  const peopleOptions = [`<option value="">选择分单人员</option>`]
    .concat(
      PO_PEOPLE.map(
        (name) => `<option value="${name}"${name === order.assignee ? ' selected' : ''}>${name}</option>`,
      ),
    )
    .join('')

  // 数量还没填的行整体压灰：一眼能分出"已填"和"只选了厂"的行
  return `<tr data-index="${index}" class="${Number(order.kg) > 0 ? '' : 'is-blank'}">
    <td class="po-order__idx">${index + 1}</td>
    <td><select class="po-cell" data-order="${index}" data-field="factory" aria-label="第 ${index + 1} 个分订单染厂">${factoryOptions}</select></td>
    <td><select class="po-cell" data-order="${index}" data-field="assignee" aria-label="第 ${index + 1} 个分订单分单人员">${peopleOptions}</select></td>
    <td><input class="po-cell is-num" type="number" min="0" step="1" data-order="${index}" data-field="vats" value="${
      order.vats || ''
    }" placeholder="—" aria-label="第 ${index + 1} 个分订单缸数" title="每缸 ${kgPerVat} 公斤" /></td>
    <td><input class="po-cell is-num" type="number" min="0" step="0.01" data-order="${index}" data-field="kg" value="${
      order.kg || ''
    }" placeholder="—" aria-label="第 ${index + 1} 个分订单数量" /></td>
    <td><input class="po-cell" data-order="${index}" data-field="note" value="${esc(
      order.note ?? '',
    )}" placeholder="缸号 / 交期" aria-label="第 ${index + 1} 个分订单备注" /></td>
    <td class="is-center"><button type="button" class="po-order__del" data-del="${index}" title="删除这张分订单" aria-label="删除第 ${
      index + 1
    } 个分订单">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5.6 2.2h4.8M2.6 4.4h10.8M4.2 4.4l.55 7.9a1 1 0 0 0 1 .93h4.5a1 1 0 0 0 1-.93l.55-7.9M6.6 6.8v4.2M9.4 6.8v4.2" />
      </svg>
    </button></td>
  </tr>`
}

function renderPoDetail() {
  const row = poSelected()
  if (!row) {
    $('#poTitle').textContent = '选择一个 SKU 开始下单'
    $('#poCategory').hidden = true
    $('#poSummary').innerHTML = ''
    $('#poOrderBody').innerHTML = `<tr><td colspan="7" class="po-empty">左侧选择一个 SKU</td></tr>`
    $('#poOrderFoot').innerHTML = ''
    $('#poClear').disabled = true
    return
  }

  const totals = poTotals(row)
  const suggestion = poSuggestion(row)
  const diff = totals.kg - row.planned

  $('#poTitle').textContent = `${row.product} · ${row.color}`
  const category = $('#poCategory')
  category.hidden = false
  category.textContent = row.category

  const diffItem = !row.orders.length
    ? `<span class="po-summary__item">尚未录入分订单</span>`
    : Math.abs(diff) < 0.005
      ? `<span class="po-summary__item is-ok">与需安排一致</span>`
      : diff > 0
        ? `<span class="po-summary__item is-over">超出需安排 <b>${fmt(diff)}</b> 公斤</span>`
        : `<span class="po-summary__item is-warn">还差 <b>${fmt(-diff)}</b> 公斤</span>`

  $('#poSummary').innerHTML = `
    <span class="po-summary__item">需安排 <b>${fmt(row.planned)}</b> 公斤</span>
    <span class="po-summary__item">已下单 <b>${fmt(totals.kg)}</b> 公斤<em>${fmt(totals.vats)} 缸</em></span>
    ${diffItem}
    <span class="po-summary__tip" title="${row.rule.name} · 每缸 ${row.rule.kgPerVat} 公斤 · 建议 ${suggestion.vats} 缸（${fmt(
      suggestion.kg,
    )} 公斤），余量过半补一缸">建议 ${suggestion.vats} 缸</span>`

  $('#poOrderBody').innerHTML = row.orders.length
    ? row.orders
        .map((order, index) => poOrderRow(order, index, row.rule.kgPerVat))
        .join('') +
      `<tr class="po-add-row"><td colspan="7">
        <button type="button" class="po-add" data-add>＋ 添加分订单</button>
      </td></tr>`
    : `<tr><td colspan="7" class="po-empty">暂无分订单</td></tr>
       <tr class="po-add-row"><td colspan="7">
        <button type="button" class="po-add" data-add>＋ 添加分订单</button>
        <button type="button" class="po-add po-add--muted" data-add-suggest title="按缸规则建议生成一张 ${fmt(
          suggestion.kg,
        )} 公斤的分订单">按建议添加 ${suggestion.vats} 缸</button>
      </td></tr>`

  renderPoFoot()
  $('#poClear').disabled = row.orders.length === 0
}

// 合计行单独更新：改缸数 / 公斤时只重绘这里，输入框不失焦
function renderPoFoot() {
  const row = poSelected()
  if (!row || !row.orders.length) {
    $('#poOrderFoot').innerHTML = ''
    return
  }
  const totals = poTotals(row)
  const diff = totals.kg - row.planned
  const state = Math.abs(diff) < 0.005 ? 'is-ok' : diff > 0 ? 'is-over' : 'is-warn'
  const text =
    Math.abs(diff) < 0.005
      ? '与需安排一致'
      : diff > 0
        ? `超出 ${fmt(diff)} 公斤`
        : `还差 ${fmt(-diff)} 公斤`

  $('#poOrderFoot').innerHTML = `<tr>
    <td colspan="3" class="po-foot__label">合计</td>
    <td class="is-num">${fmt(totals.vats)} 缸</td>
    <td class="is-num">${totals.kg.toFixed(2)}</td>
    <td colspan="2" class="po-foot__state ${state}">${text}</td>
  </tr>`
}

function renderPoSummaryOnly() {
  const row = poSelected()
  if (!row) return
  const totals = poTotals(row)
  const diff = totals.kg - row.planned
  // summary 只重绘这一块：改缸数 / 公斤时不碰表格，输入框不失焦
  const diffText = !row.orders.length
    ? '尚未录入分订单'
    : Math.abs(diff) < 0.005
      ? '与需安排一致'
      : diff > 0
        ? `超出需安排 <b>${fmt(diff)}</b> 公斤`
        : `还差 <b>${fmt(-diff)}</b> 公斤`
  const tone = !row.orders.length ? '' : Math.abs(diff) < 0.005 ? 'is-ok' : diff > 0 ? 'is-over' : 'is-warn'

  $('#poSummary').innerHTML = `
    <span class="po-summary__item">需安排 <b>${fmt(row.planned)}</b> 公斤</span>
    <span class="po-summary__item">已下单 <b>${fmt(totals.kg)}</b> 公斤<em>${fmt(totals.vats)} 缸</em></span>
    <span class="po-summary__item ${tone}">${diffText}</span>
    <span class="po-summary__tip" title="${row.rule.name} · 每缸 ${row.rule.kgPerVat} 公斤">建议 ${poSuggestion(
      row,
    ).vats} 缸</span>`

  renderPoFoot()

  const cell = $(`#poListBody tr[data-sku="${row.id}"] .po-mini__ordered`)
  if (cell) {
    cell.textContent = totals.kg > 0 ? `${fmt(totals.kg)}${totals.vats ? ` · ${totals.vats} 缸` : ''}` : '—'
    cell.classList.toggle('is-done', totals.kg > 0)
    cell.classList.toggle('is-zero', totals.kg === 0)
  }
  renderPoStats()
}

function renderPurchase() {
  renderPoStats()
  renderPoList()
  renderPoDetail()
}

// 连接件跟着选中行走：切行、滚动、缩放都重算一次
function syncPoLink() {
  const link = $('#poLink')
  const layout = $('.po-layout')
  if (!link || !layout) return

  const tr = $('#poListBody tr.is-active')
  if (!tr) {
    link.hidden = true
    return
  }

  link.hidden = false

  const layoutRect = layout.getBoundingClientRect()
  // 屏幕还没显示出来时量不到高度，直接跳过，避免把扇形压成 0
  if (layoutRect.height < 60) return

  // 宽度按实测缝隙算，不写死：左栏右缘 → 面板左缘再多 1px（正好吃掉面板那条 1px 左边框）
  const listPanel = layout.querySelector('.po-panel')
  const detailPanel = layout.querySelector('.po-panel--detail')
  if (listPanel && detailPanel) {
    const listRect = listPanel.getBoundingClientRect()
    const detailRect = detailPanel.getBoundingClientRect()
    link.style.left = `${Math.round(listRect.right - layoutRect.left)}px`
    link.style.width = `${Math.max(8, Math.round(detailRect.left - listRect.right) + 1)}px`
  }

  const trRect = tr.getBoundingClientRect()
  const rowHeight = Math.round(trRect.height) || 31
  // 扇形高度跟着框走：右侧面板高度的 1/4，窗口变化时比例不变
  const height = Math.round(layoutRect.height / 4)

  // 行中心的绝对位置（相对 layout）
  const center = trRect.top - layoutRect.top + rowHeight / 2

  // 扇形以行中心对称上下张开；贴到框外时整体夹回，改用开口偏移量，
  // 保证左右两端都落在框内，而窄口始终对准这一行
  let top = Math.round(center - height / 2)
  top = Math.max(0, Math.min(top, Math.round(layoutRect.height - height)))
  const openCenter = Math.max(0, Math.min(Math.round(center - top), height))
  const half = rowHeight / 2

  link.style.height = `${height}px`
  link.style.top = `${top}px`
  link.style.clipPath = `polygon(0 ${Math.max(0, openCenter - half)}px, 100% 0, 100% 100%, 0 ${Math.min(
    height,
    openCenter + half,
  )}px)`
}

/* ---------------- 采购下单：交互 ---------------- */
function poEnsureSelection() {
  const list = poVisibleRows()
  if (list.length && !list.some((row) => row.id === poState.selectedId)) {
    poState.selectedId = list[0].id
    // 清单也要重绘，否则新选中的行没有 is-active，扇形会跟着消失
    renderPoList()
    renderPoDetail()
  }
}

$('#poListBody').addEventListener('click', (event) => {
  const tr = event.target.closest('tr[data-sku]')
  if (!tr) return
  poState.selectedId = tr.dataset.sku
  renderPoList()
  renderPoDetail()
  syncPoLink()
})

// 点顶部「未下单」= 勾上「只看未下单」，两个入口同一状态
$('#poStats').addEventListener('click', (event) => {
  if (!event.target.closest('[data-filter="pending"]')) return
  poState.onlyUnordered = !poState.onlyUnordered
  $('#poOnlyUnordered').checked = poState.onlyUnordered
  renderPoList()
  poEnsureSelection()
})

$('.po-list__scroll').addEventListener('scroll', syncPoLink)
window.addEventListener('resize', syncPoLink)

$('#poSearch').addEventListener('input', (event) => {
  poState.keyword = event.target.value
  renderPoList()
  poEnsureSelection()
})

$('#poOnlyUnordered').addEventListener('change', (event) => {
  poState.onlyUnordered = event.target.checked
  renderPoList()
  poEnsureSelection()
})

// 改缸数 → 公斤 = 缸数 × 每缸；改公斤 → 缸数按每缸回算；只重绘合计，输入框不失焦
$('#poOrderBody').addEventListener('input', (event) => {
  const input = event.target.closest('input[data-order]')
  if (!input) return
  const row = poSelected()
  const index = Number(input.dataset.order)
  const order = row?.orders[index]
  if (!order) return

  const field = input.dataset.field
  const per = row.rule.kgPerVat

  if (field === 'vats') {
    const vats = Math.max(0, Number(input.value) || 0)
    order.vats = vats
    order.kg = Math.round(vats * per * 100) / 100
    const kg = $(`[data-order="${index}"][data-field="kg"]`)
    if (kg) kg.value = order.kg
  } else if (field === 'kg') {
    const kg = Math.max(0, Number(input.value) || 0)
    order.kg = kg
    order.vats = Math.round((kg / per) * 100) / 100
    const vats = $(`[data-order="${index}"][data-field="vats"]`)
    if (vats) vats.value = order.vats
  } else {
    order[field] = input.value
  }

  renderPoSummaryOnly()
})

$('#poOrderBody').addEventListener('change', (event) => {
  const select = event.target.closest('select[data-order]')
  if (!select) return
  const row = poSelected()
  const order = row?.orders[Number(select.dataset.order)]
  if (!order) return
  order[select.dataset.field] = select.value
  renderPoSummaryOnly()
})

$('#poOrderBody').addEventListener('click', (event) => {
  const row = poSelected()
  if (!row) return

  const del = event.target.closest('[data-del]')
  if (del) {
    row.orders.splice(Number(del.dataset.del), 1)
    renderPoDetail()
    renderPoList()
    renderPoStats()
    return
  }

  if (event.target.closest('[data-add]')) {
    row.orders.push({ factory: '', assignee: '', vats: 0, kg: 0, note: '' })
    renderPoDetail()
    renderPoList()
    renderPoStats()
    return
  }

  if (event.target.closest('[data-add-suggest]')) {
    const suggestion = poSuggestion(row)
    row.orders = [{ factory: '', assignee: '', vats: suggestion.vats, kg: suggestion.kg, note: '' }]
    renderPoDetail()
    renderPoList()
    renderPoStats()
  }
})

$('#poClear').addEventListener('click', () => {
  const row = poSelected()
  if (!row || !row.orders.length) return
  openConfirm({
    title: '清空分订单',
    note: `确定清空「${row.product} · ${row.color}」的 ${row.orders.length} 张分订单？`,
    okText: '清空',
    onOk: () => {
      row.orders = []
      renderPoDetail()
      renderPoList()
      renderPoStats()
      toast('已清空该 SKU 的分订单')
    },
  })
})

/* ---------------- 设置：缸规则 / 人员 交互 ---------------- */
// 缸规则弹窗里的档位可以增删：先从 DOM 回收当前值，再整块重绘
$('#formBody').addEventListener('click', (event) => {
  if (!formSpec || formSpec.kind !== 'vat') return
  const add = event.target.closest('[data-band-add]')
  const del = event.target.closest('[data-band-del]')
  if (!add && !del) return
  event.preventDefault()

  const current = readForm()
  const bands = vatBandsFromValues({ ...formSpec.values, ...current })

  if (add) {
    const prev = bands[bands.length - 2]?.upTo ?? 0
    const last = bands[bands.length - 1]
    bands.splice(bands.length - 1, 0, {
      upTo: Number(prev) + 200,
      action: last?.action ?? 'vat',
      value: last?.value ?? 100,
    })
  } else {
    if (bands.length <= 1) return
    bands.splice(Number(del.dataset.bandDel), 1)
    bands[bands.length - 1].upTo = null
  }

  formSpec.values = { ...current, bands }
  $('#formBody').innerHTML = formSpec.render(formSpec.values)
  validateForm(false)
})

$('#vatDefaultRule').addEventListener('change', (event) => {
  VAT_DEFAULT_RULE = event.target.value
  renderVat()
  markPurchaseDirty('vat')
})

$('#vatSpuSearch').addEventListener('input', renderVatSpu)

$('#vatSpuBody').addEventListener('change', (event) => {
  const select = event.target.closest('[data-vat-spu]')
  if (!select) return
  const product = select.dataset.vatSpu
  if (!select.value) delete VAT_SPU[product]
  else VAT_SPU[product] = select.value
  renderVat()
  markPurchaseDirty('vat')
})

function vatFilteredSpus() {
  const keyword = ($('#vatSpuSearch')?.value || '').trim().toLowerCase()
  return vatSpuRows().filter((row) => row.product.toLowerCase().includes(keyword))
}

$('#vatBulkApply').addEventListener('click', () => {
  const ruleId = $('#vatBulkRule').value
  const rows = vatFilteredSpus()
  if (!ruleId) return toast('先选择要套用的规则')
  if (!rows.length) return toast('当前筛选结果为空')
  pushPurchase()
  rows.forEach((row) => {
    if (ruleId === '__none__') VAT_SPU[row.product] = '__none__'
    else VAT_SPU[row.product] = ruleId
  })
  renderVat()
  markPurchaseDirty('vat')
  toast(`已套用到 ${rows.length} 个品名`)
})

$('#vatBulkClear').addEventListener('click', () => {
  const rows = vatFilteredSpus()
  if (!rows.length) return toast('当前筛选结果为空')
  pushPurchase()
  rows.forEach((row) => delete VAT_SPU[row.product])
  renderVat()
  markPurchaseDirty('vat')
  toast(`已清空 ${rows.length} 个品名的绑定`)
})

// 人员移除
document.addEventListener('click', (event) => {
  const del = event.target.closest('[data-del="person"]')
  if (!del) return
  const name = del.dataset.id
  openConfirm({
    title: '移除分单人员',
    note: `移除「${name}」后，已按该人员拆好的分订单保留原姓名，新分单不再出现这个人。`,
    okText: '移除',
    onOk: () => {
      pushPurchase()
      PO_PEOPLE_LIST = PO_PEOPLE_LIST.filter((item) => item !== name)
      PEOPLE = PEOPLE.map((entry) => ({ ...entry, people: entry.people.filter((p) => p !== name) }))
      renderPoPeople()
      renderPeople()
      markPurchaseDirty('people')
      toast('已移除')
    },
  })
})

/* ---------------- 屏蔽列表 ---------------- */
const hiddenState = { keyword: '', selected: new Set(), collapsed: new Set() }

function hiddenSkuTotal() {
  return HIDDEN_GROUPS.reduce((sum, group) => sum + group.skus.length, 0)
}

function syncHiddenBadge() {
  const total = hiddenSkuTotal()
  const badge = $('#hiddenBadge')
  badge.textContent = String(total)
  badge.hidden = total === 0
  if ($('#hiddenCount')) $('#hiddenCount').textContent = `共 ${total} 个 SKU，已选 ${hiddenState.selected.size} 个`
  if ($('#hiddenSummary')) {
    $('#hiddenSummary').textContent = `${HIDDEN_GROUPS.length} 个品名 · ${total} 个 SKU`
  }
  const restore = $('#hiddenRestoreSelected')
  if (restore) {
    restore.textContent = `解除屏蔽（${hiddenState.selected.size}）`
    restore.disabled = hiddenState.selected.size === 0
  }
  const all = $('#hiddenSelectAll')
  if (all) all.checked = total > 0 && hiddenState.selected.size === total
}

function hiddenVisibleGroups() {
  const keyword = hiddenState.keyword.trim().toLowerCase()
  return HIDDEN_GROUPS.map((group) => {
    const hitGroup = group.product.toLowerCase().includes(keyword)
    const hitSkus = group.skus.filter((sku) =>
      `${sku.color} ${sku.skuId}`.toLowerCase().includes(keyword),
    )
    const visibleSkus = keyword ? (hitGroup ? group.skus : hitSkus) : group.skus
    return { ...group, visibleSkus, visible: !keyword || hitGroup || hitSkus.length > 0 }
  }).filter((group) => group.visible)
}

function renderHidden() {
  const groups = hiddenVisibleGroups()

  $('#hiddenList').innerHTML = groups.length
    ? groups
        .map((group) => {
          const open = !hiddenState.collapsed.has(group.product)
          const selectedAll = group.skus.length > 0 && group.skus.every((sku) => hiddenState.selected.has(sku.skuId))
          const selectedSome = group.skus.some((sku) => hiddenState.selected.has(sku.skuId))
          return `
        <section class="hidden-group">
          <div class="hidden-group__head" data-hide-toggle="${esc(group.product)}">
            <input type="checkbox" class="hidden-check" data-hide-group="${esc(group.product)}" ${
              selectedAll ? 'checked' : ''
            } ${selectedSome && !selectedAll ? 'data-indeterminate="1"' : ''} aria-label="选择品名 ${esc(
              group.product,
            )}" />
            <span class="hidden-caret${open ? ' is-open' : ''}" aria-hidden="true">
              <svg viewBox="0 0 12 12"><path d="M4 2.5 8 6l-4 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </span>
            <span class="hidden-group__name">
              <span class="hidden-group__text" title="${esc(group.product)}">${esc(group.product)}</span>
              ${group.whole ? '<span class="tag">整组屏蔽</span>' : ''}
            </span>
            <span class="hidden-group__meta">${
              group.whole ? `当前数据 ${group.skus.length} 个 SKU` : `${group.skus.length} 个 SKU`
            }</span>
            <button class="btn btn--text btn--sm" data-hide-restore="${esc(group.product)}">解除</button>
          </div>
          ${
            open
              ? `<div class="hidden-group__body">
            ${
              group.visibleSkus.length
                ? group.visibleSkus
                    .map(
                      (sku) => `
              <div class="hidden-child">
                ${
                  group.whole
                    ? '<span class="hidden-child__dot" aria-hidden="true"></span>'
                    : `<input type="checkbox" class="hidden-check" data-hide-sku="${esc(sku.skuId)}" ${
                        hiddenState.selected.has(sku.skuId) ? 'checked' : ''
                      } aria-label="选择 SKU ${esc(sku.skuId)}" />`
                }
                <span class="hidden-child__color" title="${esc(sku.color)}">${esc(sku.color) || '—'}</span>
                <span class="hidden-child__sku" title="${esc(sku.skuId)}">${esc(sku.skuId)}</span>
                ${
                  group.whole
                    ? '<span></span>'
                    : `<button class="btn btn--text btn--sm" data-hide-restore-sku="${esc(sku.skuId)}">解除</button>`
                }
              </div>`,
                    )
                    .join('')
                : '<p class="hidden-empty">没有匹配的 SKU</p>'
            }
          </div>`
              : ''
          }
        </section>`
        })
        .join('')
    : `<p class="hidden-empty">${
        HIDDEN_GROUPS.length ? '没有匹配的屏蔽记录' : '还没有屏蔽任何品名或 SKU'
      }</p>`

  // indeterminate 只能用属性设，模板里写不进去
  $$('[data-indeterminate]').forEach((box) => {
    box.indeterminate = true
  })
  syncHiddenBadge()
}

function removeHiddenSku(skuId) {
  HIDDEN_GROUPS = HIDDEN_GROUPS.map((group) => ({
    ...group,
    skus: group.skus.filter((sku) => sku.skuId !== skuId),
  })).filter((group) => group.skus.length > 0)
  hiddenState.selected.delete(skuId)
}

$('#hiddenSearch').addEventListener('input', (event) => {
  hiddenState.keyword = event.target.value
  renderHidden()
})

$('#hiddenSelectAll').addEventListener('change', (event) => {
  const groups = hiddenVisibleGroups()
  if (event.target.checked) {
    groups.forEach((group) => {
      if (group.whole) hiddenState.selected.add(`product:${group.product}`)
      group.skus.forEach((sku) => hiddenState.selected.add(sku.skuId))
    })
  } else {
    hiddenState.selected.clear()
  }
  renderHidden()
})

$('#hiddenList').addEventListener('click', (event) => {
  const restoreSku = event.target.closest('[data-hide-restore-sku]')
  if (restoreSku) {
    removeHiddenSku(restoreSku.dataset.hideRestoreSku)
    renderHidden()
    toast('已解除屏蔽')
    return
  }

  const restoreGroup = event.target.closest('[data-hide-restore]')
  if (restoreGroup) {
    const product = restoreGroup.dataset.hideRestore
    HIDDEN_GROUPS = HIDDEN_GROUPS.filter((group) => group.product !== product)
    HIDDEN_GROUPS.forEach((group) => {})
    hiddenState.selected.clear()
    renderHidden()
    toast('已解除该品名的屏蔽')
    return
  }

  const toggle = event.target.closest('[data-hide-toggle]')
  if (toggle && !event.target.closest('input')) {
    const product = toggle.dataset.hideToggle
    if (hiddenState.collapsed.has(product)) hiddenState.collapsed.delete(product)
    else hiddenState.collapsed.add(product)
    renderHidden()
  }
})

$('#hiddenList').addEventListener('change', (event) => {
  const groupBox = event.target.closest('[data-hide-group]')
  if (groupBox) {
    const group = HIDDEN_GROUPS.find((item) => item.product === groupBox.dataset.hideGroup)
    if (!group) return
    if (groupBox.checked) {
      group.skus.forEach((sku) => hiddenState.selected.add(sku.skuId))
      if (group.whole) hiddenState.selected.add(`product:${group.product}`)
    } else {
      group.skus.forEach((sku) => hiddenState.selected.delete(sku.skuId))
      hiddenState.selected.delete(`product:${group.product}`)
    }
    renderHidden()
    return
  }

  const skuBox = event.target.closest('[data-hide-sku]')
  if (skuBox) {
    if (skuBox.checked) hiddenState.selected.add(skuBox.dataset.hideSku)
    else hiddenState.selected.delete(skuBox.dataset.hideSku)
    syncHiddenBadge()
  }
})

$('#hiddenRestoreSelected').addEventListener('click', () => {
  const ids = [...hiddenState.selected].filter((key) => !key.startsWith('product:'))
  const products = [...hiddenState.selected]
    .filter((key) => key.startsWith('product:'))
    .map((key) => key.slice('product:'.length))
  if (!ids.length && !products.length) return
  ids.forEach(removeHiddenSku)
  HIDDEN_GROUPS = HIDDEN_GROUPS.filter((group) => !products.includes(group.product))
  hiddenState.selected.clear()
  renderHidden()
  toast('已解除选中的屏蔽')
})

$('#hiddenRestoreAll').addEventListener('click', () => {
  if (!HIDDEN_GROUPS.length) return
  openConfirm({
    title: '全部解除屏蔽',
    note: `将恢复 ${HIDDEN_GROUPS.length} 个品名、${hiddenSkuTotal()} 个 SKU，解除后它们会重新出现在主面板。`,
    okText: '全部解除',
    onOk: () => {
      HIDDEN_GROUPS = []
      hiddenState.selected.clear()
      renderHidden()
      toast('已全部解除')
    },
  })
})

// 主面板「屏蔽选中」：写进屏蔽清单，同时从主面板移除
function hideSelectedSkus() {
  if (!state.selected.size) return
  const keys = [...state.selected]
  const byProduct = new Map()

  keys.forEach((key) => {
    const [product, color] = key.split('|')
    const group = INVENTORY.find((item) => item.product === product)
    if (!group || !group.children.some((child) => child.color === color)) return
    if (!byProduct.has(product)) byProduct.set(product, [])
    byProduct.get(product).push({ skuId: `${product}|${color}`, color })
  })

  byProduct.forEach((skus, product) => {
    const existing = HIDDEN_GROUPS.find((group) => group.product === product)
    if (existing) {
      skus.forEach((sku) => {
        if (!existing.skus.some((item) => item.skuId === sku.skuId)) existing.skus.push(sku)
      })
    } else {
      HIDDEN_GROUPS.push({ product, whole: false, skus })
    }
  })

  keys.forEach((key) => {
    const [product, color] = key.split('|')
    const group = INVENTORY.find((item) => item.product === product)
    if (!group) return
    group.children = group.children.filter((child) => child.color !== color)
  })
  for (let i = INVENTORY.length - 1; i >= 0; i -= 1) {
    if (!INVENTORY[i].children.length) INVENTORY.splice(i, 1)
  }

  state.selected.clear()
  renderInventory()
  syncHiddenBadge()
  toast(`已屏蔽 ${keys.length} 个 SKU，可在「屏蔽列表」解除`)
}

/* ---------------- 主面板：添加 SKU ---------------- */
function addSkuDialog() {
  openForm({
    title: '添加 SKU',
    wide: true,
    kind: 'add-sku',
    note: '字段与导入的总表 / 销售表一致；品名 + 颜色不能与已有 SKU 重复。手动添加的 SKU 只保留在当前页面。',
    values: {
      product: '',
      color: '',
      category: '黑白',
      treeCategory: '',
      warehouse: 0,
      inTransit: 0,
      producing: 0,
      backorder: 0,
      cumulative: 0,
      months: 12,
      monthlyAvg: null,
    },
    render: (v) => `
      <p class="form__section">基础信息</p>
      <div class="form__grid form__grid--2">
        ${formRow('品名', textField('product', v.product, { placeholder: '例如：挪威网' }))}
        ${formRow('颜色', textField('color', v.color, { placeholder: '例如：1#黑色' }))}
        ${formRow(
          '色彩',
          selectField('category', v.category, [
            { value: '黑白', label: '黑白' },
            { value: '彩色', label: '彩色' },
          ]),
        )}
        ${formRow('树形分类', textField('treeCategory', v.treeCategory, { placeholder: '采购下单用，可留空' }))}
      </div>

      <p class="form__section">数量（公斤）</p>
      <div class="form__grid form__grid--4">
        ${formRow('期初库存', numField('warehouse', v.warehouse, '', { min: 0 }))}
        ${formRow('在途', numField('inTransit', v.inTransit, '', { min: 0 }))}
        ${formRow('待生产', numField('producing', v.producing, '', { min: 0 }))}
        ${formRow('待出库', numField('backorder', v.backorder, '', { min: 0 }))}
      </div>

      <p class="form__section">动销指标</p>
      <div class="form__grid form__grid--3">
        ${formRow('累积条数', numField('cumulative', v.cumulative, '条', { min: 0 }))}
        ${formRow('动销月份', numField('months', v.months, '月', { min: 1, max: 12 }))}
        ${formRow('月均条数', numField('monthlyAvg', v.monthlyAvg, '条', { min: 0, placeholder: '留空自动算' }))}
      </div>`,
    validate: (v) => {
      const product = String(v.product || '').trim()
      const color = String(v.color || '').trim()
      if (!product) return '品名不能为空'
      if (!color) return '颜色不能为空'
      const group = INVENTORY.find((item) => item.product === product)
      if (group?.children.some((child) => child.color === color)) return '该品名 + 颜色已存在'
      return null
    },
    onSubmit: (v) => {
      const product = String(v.product).trim()
      const color = String(v.color).trim()
      const monthly =
        v.monthlyAvg === null || v.monthlyAvg === ''
          ? Math.round((Number(v.cumulative) || 0) / Math.max(1, Number(v.months) || 1))
          : Number(v.monthlyAvg)
      const child = {
        mode: '常规',
        color,
        tone: 'normal',
        planned: 0,
        producing: Number(v.producing) || 0,
        backorder: Number(v.backorder) || 0,
        weekly: Math.round((monthly / 4.3) * 10) / 10,
        warehouse: Number(v.warehouse) || 0,
        inTransit: Number(v.inTransit) || 0,
        monthlyAvg: monthly,
        treeCategory: String(v.treeCategory || '').trim(),
      }
      let group = INVENTORY.find((item) => item.product === product)
      if (!group) {
        group = { product, grade: 'Z', children: [] }
        INVENTORY.push(group)
      }
      group.children.push(child)
      renderInventory()
      syncCounts()
      toast(`已添加 ${product} · ${color}`)
    },
  })
}

$('#addSkuBtn').addEventListener('click', addSkuDialog)
$('#hideSelected').addEventListener('click', hideSelectedSkus)

/* ---------------- 初始化 ---------------- */
// 依赖 MODES / skuKey 全部初始化完成后再摆种子数据
normalizeSeed()
syncCounts()

renderToneFilters()
renderInventory()
renderSales()
renderConfig()
renderPurchase()
renderHidden()
markClean()
markPurchaseClean()

// 便于评审直接打开某一屏：?screen=config&panel=weights&strategy=manual&sku=挪威网|1#黑色
const params = new URLSearchParams(location.search)
const initialScreen = params.get('screen')
const SCREENS = ['inventory', 'sales', 'purchase', 'config', 'purchase-settings', 'hidden']
if (initialScreen && SCREENS.includes(initialScreen)) switchScreen(initialScreen)
const initialPanel = params.get('panel')
if (initialPanel && Object.keys(PANEL_DOMAIN).includes(initialPanel)) switchPanel(initialPanel)
if (params.get('strategy') === 'manual') $('[data-strategy="manual"]').click()
// 评审时可直接打开某个编辑弹窗：?screen=config&panel=scoring&dialog=scoring
const initialDialog = params.get('dialog')
const DIALOGS = {
  mode: editModeDialog,
  weights: editWeightsDialog,
  scoring: editScoringDialog,
  spu: editSpuDialog,
  factory: () => editFactoryDialog(null),
  people: () => editPeopleDialog(null),
  'sku-factory': () => editSkuFactoryDialog(null),
  'manual-mode': () => editManualModeDialog(null),
  'manual-sku': () => editManualSkuDialog(null),
  vat: () => editVatRuleDialog(VAT_RULES[0]),
  'add-sku': addSkuDialog,
}
if (initialDialog && DIALOGS[initialDialog]) DIALOGS[initialDialog]()

const initialSku = params.get('sku')
if (initialSku) openSku(initialSku)
