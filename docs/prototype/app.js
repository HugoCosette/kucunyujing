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

const TONE_COUNTS = { all: 21, urgent: 2, replenish: 6, normal: 7, overstock: 3, none: 3 }

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

const SCORING_ROWS = [
  { label: '客户数 CR5', weight: 15, low: '0 – 40%', mid: '40 – 60%', high: '60% 以上' },
  { label: '累计客户数', weight: 10, low: '21 以上', mid: '11 – 20', high: '0 – 10' },
  { label: '销售环比率', weight: 20, low: '10% 以上', mid: '-10% – 10%', high: '-10% 以下' },
  { label: '本次进销比', weight: 30, low: '0 – 20%', mid: '20 – 30%', high: '30% 以上' },
  { label: '预估月消耗', weight: 25, low: '0 以下', mid: '等于 0', high: '0 以上' },
]

const SPU_GRADES = [
  { label: 'S+', tone: 'splus', threshold: '≥ 2500', count: 1 },
  { label: 'S', tone: 's', threshold: '≥ 300', count: 2 },
  { label: 'A', tone: 'a', threshold: '≥ 100', count: 0 },
  { label: 'B', tone: 'b', threshold: '≥ 30', count: 1 },
  { label: 'C', tone: 'c', threshold: '≥ 1', count: 1 },
  { label: 'Z', tone: 'z', threshold: '< 1', count: 0 },
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

function derive(sku) {
  const theoretical = sku.warehouse + sku.inTransit + sku.producing - sku.backorder - sku.planned
  const projected = theoretical - Math.round(sku.weekly)
  const days = sku.weekly > 0 ? projected / (sku.weekly / 7) : null
  const shortage = sku.planned
  const rate = shortage > 0 ? shortage / (shortage + Math.max(projected, 0)) : 0
  return { theoretical, projected, days, shortage, rate }
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
      <span class="chip__count">${TONE_COUNTS[item.key]}</span>
    </button>`,
  ).join('')
}

const INV_COLS = [
  { key: 'select', label: '', w: 38, group: '' },
  { key: 'mode', label: '模式', w: 78, group: '备货判定' },
  { key: 'product', label: '品名', w: 144, group: '商品', left: true },
  { key: 'color', label: '颜色', w: 132, group: '商品', left: true },
  { key: 'urgency', label: '预警', w: 52, group: '商品' },
  { key: 'planned', label: '需安排', w: 138, group: '补货计划' },
  { key: 'producing', label: '生产中', w: 72, group: '补货计划', num: true },
  { key: 'backorder', label: '欠货', w: 64, group: '出货需求', num: true },
  { key: 'weekly', label: '周销量', w: 72, group: '出货需求', num: true },
  { key: 'turnover', label: '周转入', w: 66, group: '库存（公斤）', num: true },
  { key: 'inTransit', label: '在途库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'warehouse', label: '在仓库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'theoretical', label: '理论库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'projected', label: '预计库存', w: 76, group: '库存（公斤）', num: true },
  { key: 'days', label: '日库销比', w: 72, group: '数据反馈', num: true },
  { key: 'shortage', label: '缺口量', w: 68, group: '数据反馈', num: true },
  { key: 'rate', label: '缺口率', w: 68, group: '数据反馈', num: true },
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
      const worst = ['urgent', 'replenish', 'overstock', 'normal', 'none'].find((key) =>
        group.children.some((child) => child.tone === key),
      ) || 'none'
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
  const d = derive(child)
  const key = skuKey(group.product, child.color)
  const selected = state.selected.has(key)
  const tone = TONES[child.tone]
  const inactive = child.mode === '尾货' || child.mode === '滞销'

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
      content = `<div class="planned"><input class="planned__input" data-planned="${key}" value="${
        child.planned || ''
      }" placeholder="待填" /><span class="planned__unit">条</span><button class="planned__accept" data-accept="${key}">采纳</button></div>`
    } else if (col.key === 'days') {
      content = inactive ? '—' : d.days.toFixed(1)
    } else if (col.key === 'rate') {
      content = inactive ? '—' : `${(d.rate * 100).toFixed(0)}%`
    } else if (col.key === 'theoretical') {
      content = fmt(d.theoretical)
    } else if (col.key === 'projected') {
      content = fmt(d.projected)
    } else if (col.key === 'shortage') {
      content = inactive ? '—' : fmt(d.shortage)
    } else if (col.key === 'turnover') {
      content = '0'
    } else {
      content = fmt(child[col.key])
    }

    return `<div class="gt-cell ${col.left ? 'gt-cell--left' : ''} ${col.num ? 'gt-cell--num' : ''} ${
      content === '—' ? 'gt-cell--muted' : ''
    }">${content}</div>`
  }).join('')

  return `<div class="gt-row ${selected ? 'is-selected' : ''}" data-sku-row="${key}">${cells}</div>`
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
    const input = $(`[data-planned="${accept.dataset.accept}"]`, $('#invTable'))
    const value = Number(input?.value)
    if (!Number.isFinite(value) || value <= 0) {
      toast('请先填写需安排数量')
      return
    }
    const [product, color] = accept.dataset.accept.split('|')
    const target = INVENTORY.find((item) => item.product === product)?.children.find((item) => item.color === color)
    if (target) target.planned = value
    toast(`已采纳 ${fmt(value)} 条`)
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
        <input class="coef-input" value="20.0" aria-label="红线" />
        <input class="coef-input" value="40.0" aria-label="正常" />
        <input class="coef-input" value="60.0" aria-label="峰值" />
        <span>红线 / 正常 / 峰值（条）</span>
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
function switchPanel(panel) {
  $$('.rail__item').forEach((item) => item.classList.toggle('is-active', item.dataset.panel === panel))
  $$('[data-panel-view]').forEach((view) => {
    view.hidden = view.dataset.panelView !== panel
  })
}

$$('.rail__item').forEach((item) => item.addEventListener('click', () => switchPanel(item.dataset.panel)))

/* ---------------- 配置：策略与模式 ---------------- */
function modeRange(mode) {
  const index = MODES.findIndex((item) => item.key === mode.key)
  const above = MODES[index - 1]
  if (!mode.participates) return mode.key === 'slow' ? '月均 = 0' : '0 < 月均 < 3'
  return above ? `${mode.min} – ${above.min} 条/月` : `≥ ${mode.min} 条/月`
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
}

function renderCoefficients(mode) {
  if (!mode.participates) {
    return '<div class="table-empty">该模式不参与计算</div>'
  }

  const unit = mode.metric === 'days' ? '天' : '条'
  const rowHtml = (row, first) => `
    <tr>
      ${first ? '<td class="coef-table__cat" rowspan="2">流通品</td>' : ''}
      <td class="coef-table__color">${row.color}</td>
      <td class="is-num"><input class="coef-input" data-coef="${row.color}-redLine" value="${row.redLine.toFixed(1)}" /></td>
      <td class="is-num"><input class="coef-input" data-coef="${row.color}-normal" value="${row.normal.toFixed(1)}" /></td>
      <td class="is-num"><input class="coef-input" data-coef="${row.color}-peak" value="${row.peak.toFixed(1)}" /></td>
    </tr>`

  return `
    <table class="coef-table">
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
        ${rowHtml(mode.rows[0], true)}
        ${rowHtml(mode.rows[1], false)}
        ${
          mode.split
            ? `<tr><td class="coef-table__cat">专属品</td><td colspan="4" class="coef-table__skip">不设系数</td></tr>`
            : ''
        }
      </tbody>
    </table>`
}

function renderEditor() {
  const mode = MODES.find((item) => item.key === state.activeMode) || MODES[0]
  const unit = mode.metric === 'days' ? '天' : '条'

  $('#modeEditor').innerHTML = `
    <div class="editor-head">
      <input class="input editor-name" value="${mode.name}" data-mode-name aria-label="模式名称" />
      <span class="editor-head__meta">命中 ${fmt(mode.hits)} 个 SKU</span>
    </div>

    <div class="field-row">
      <span>月均条数 ≥</span>
      <input class="num-input" value="${mode.min}" data-mode-min aria-label="月均条数阈值" />
      <span>条/月</span>
    </div>

    <p class="section-label">备货系数 ${mode.participates ? `<span>单位：${unit}</span>` : ''}</p>
    ${renderCoefficients(mode)}`

  $$('.mode-item').forEach((item) => item.classList.toggle('is-active', item.dataset.mode === mode.key))
}

$('#modeList').addEventListener('click', (event) => {
  const item = event.target.closest('[data-mode]')
  if (!item) return
  state.activeMode = item.dataset.mode
  renderModeList()
  renderEditor()
})

$('#modeEditor').addEventListener('input', (event) => {
  const mode = MODES.find((item) => item.key === state.activeMode)
  if (!mode) return
  pushHistory()
  if (event.target.matches('[data-mode-name]')) mode.name = event.target.value
  if (event.target.matches('[data-mode-min]')) mode.min = Number(event.target.value) || 0
  const coef = event.target.closest('[data-coef]')
  if (coef) {
    const [color, field] = coef.dataset.coef.split('-')
    const row = mode.rows.find((item) => item.color === color)
    if (row) row[field] = Number(coef.value) || 0
  }
  markDirty()
  renderModeList()
})

$('#modeEditor').addEventListener('change', (event) => {
  if (event.target.matches('.coef-input') || event.target.matches('[data-mode-min]')) renderEditor()
})

$$('[data-strategy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-strategy]').forEach((el) => el.classList.toggle('is-active', el === btn))
    const manual = btn.dataset.strategy === 'manual'
    $('#autoStrategy').hidden = manual
    $('#manualStrategy').hidden = !manual
  })
})

/* ---------------- 配置：销量加权 ---------------- */
const WEIGHT_KEYS = ['m1', 'm3', 'm12']

function syncWeights() {
  WEIGHT_KEYS.forEach((key) => {
    $(`[data-weight="${key}"]`).value = String(state.weights[key])
  })

  const total = WEIGHT_KEYS.reduce((sum, key) => sum + state.weights[key], 0)
  const totalEl = $('#weightTotal')
  totalEl.textContent = `合计 ${total}%`
  totalEl.className = total === 100 ? 'weight-total' : 'weight-total weight-total--warn'
}

$$('[data-weight]').forEach((input) => {
  input.addEventListener('input', () => {
    pushHistory()
    state.weights[input.dataset.weight] = Math.max(0, Math.min(100, Number(input.value) || 0))
    syncWeights()
    markDirty()
  })
})

$('[data-reset-weights]').addEventListener('click', () => {
  pushHistory()
  state.weights = { m1: 50, m3: 30, m12: 20 }
  syncWeights()
  markDirty()
})

/* ---------------- 配置：评分 / SPU ---------------- */
function renderScoring() {
  $('#scoringBody').innerHTML = SCORING_ROWS.map(
    (row) => `
    <tr>
      <td class="score-table__dim">${row.label}</td>
      <td class="is-num">${row.weight}%</td>
      <td class="risk--low">${row.low}</td>
      <td class="risk--mid">${row.mid}</td>
      <td class="risk--high">${row.high}</td>
    </tr>`,
  ).join('')
}

function renderGrades() {
  $('#gradeBody').innerHTML = SPU_GRADES.map(
    (grade) => `
    <tr>
      <td><span class="grade grade--${grade.tone}">${grade.label}</span></td>
      <td>${grade.threshold}</td>
      <td class="is-num">${grade.count} 个</td>
    </tr>`,
  ).join('')
}

/* ---------------- 配置：草稿状态 ---------------- */
function snapshot() {
  return JSON.stringify({ weights: state.weights, modes: MODES })
}

function pushHistory() {
  state.history.push(snapshot())
  if (state.history.length > 50) state.history.shift()
  state.redo = []
  syncHistoryButtons()
}

function restore(json) {
  const data = JSON.parse(json)
  state.weights = data.weights
  MODES.length = 0
  MODES.push(...data.modes)
  state.activeMode = MODES.some((mode) => mode.key === state.activeMode) ? state.activeMode : MODES[0].key
  renderModeList()
  renderEditor()
  syncWeights()
}

function undo() {
  if (!state.history.length) return
  state.redo.push(snapshot())
  restore(state.history.pop())
  syncHistoryButtons()
  markDirty()
}

function redo() {
  if (!state.redo.length) return
  state.history.push(snapshot())
  restore(state.redo.pop())
  syncHistoryButtons()
  markDirty()
}

function syncHistoryButtons() {
  $('#undoBtn').disabled = state.history.length === 0
  $('#redoBtn').disabled = state.redo.length === 0
}

function markDirty() {
  $('#saveState').textContent = '未保存'
  $('#saveState').classList.add('state--dirty')
  $('#saveBtn').disabled = false
  $('#discardBtn').disabled = false
}

function markClean() {
  state.history = []
  state.redo = []
  syncHistoryButtons()
  $('#saveState').textContent = '已保存'
  $('#saveState').classList.remove('state--dirty')
  $('#saveBtn').disabled = true
  $('#discardBtn').disabled = true
}

$('#undoBtn').addEventListener('click', undo)
$('#redoBtn').addEventListener('click', redo)
$('#saveBtn').addEventListener('click', () => {
  markClean()
  toast('已保存到 src/stocking/config.json')
})
$('#discardBtn').addEventListener('click', () => {
  if (state.history.length) restore(state.history[0])
  markClean()
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

/* ---------------- 初始化 ---------------- */
renderToneFilters()
renderInventory()
renderSales()
renderModeList()
renderEditor()
syncWeights()
renderScoring()
renderGrades()
markClean()

// 便于评审直接打开某一屏：?screen=config&panel=weights&strategy=manual&sku=挪威网|1#黑色
const params = new URLSearchParams(location.search)
const initialScreen = params.get('screen')
if (initialScreen && ['inventory', 'sales', 'config'].includes(initialScreen)) switchScreen(initialScreen)
const initialPanel = params.get('panel')
if (initialPanel && ['strategy', 'weights', 'scoring', 'spu'].includes(initialPanel)) switchPanel(initialPanel)
if (params.get('strategy') === 'manual') $('[data-strategy="manual"]').click()
const initialSku = params.get('sku')
if (initialSku) openSku(initialSku)
