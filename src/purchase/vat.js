// 缸规则：把「建议下单量（公斤）」换算成整缸 / 整十整百的实际下单量。
// 规则挂在 SPU（品名）上，该品名下的 SKU 全部沿用；SKU 也可单独覆盖。
// 一条规则 = 判据 + 分档，每档命中一种处理方式：
//   skip  不下单（0 公斤）
//   fixed 固定下单量（可理解为 1 缸的公斤数）
//   vat   按「每缸公斤」取模：缸数按零头策略取整，下单量 = 缸数 × 每缸公斤
//   round 四舍五入到整十 / 整百（等价于每缸 10 / 100 公斤的 vat）
// 零头默认「就近」：余量 ≥ 阈值（默认半缸）补一缸，否则舍弃；需求 > 0 时至少 minVats 缸。

// 显式「不取整」：SPU 绑到这个值就不套任何规则，按原样下单。
export const VAT_RULE_NONE = '__none__'

export const VAT_BAND_KEYS = [
  { value: 'planned', label: '需安排（公斤）', unit: '公斤' },
  { value: 'skuMonthlyAvg', label: 'SKU 月均条数（条）', unit: '条' },
  { value: 'spuMonthlyAvg', label: 'SPU 月均条数合计（条）', unit: '条' },
]

export const VAT_ACTIONS = [
  { value: 'skip', label: '不下单（0 公斤）', valueLabel: '' },
  { value: 'fixed', label: '固定下单量', valueLabel: '固定量（公斤）' },
  { value: 'vat', label: '按每缸公斤取整', valueLabel: '每缸公斤' },
  { value: 'round', label: '四舍五入到整十/整百', valueLabel: '取整步长（公斤）' },
]

export const VAT_REMAINDER_POLICIES = [
  { value: 'nearest', label: '就近（余量过半补一缸）' },
  { value: 'floor', label: '舍弃（只下整缸）' },
  { value: 'ceil', label: '补足（不足一缸也下一缸）' },
]

const ACTIONS = new Set(VAT_ACTIONS.map((entry) => entry.value))
const BAND_KEYS = new Set(VAT_BAND_KEYS.map((entry) => entry.value))
const REMAINDERS = new Set(VAT_REMAINDER_POLICIES.map((entry) => entry.value))
const EPSILON = 1e-9

// 两条默认规则与「下单数量规则」示例同构：标准大货补单 / 小批量补单。
export function createDefaultVatRules() {
  return [
    {
      id: 'vr-standard',
      name: '标准大货补单',
      bandKey: 'planned',
      remainder: 'nearest',
      remainderThreshold: 0.5,
      minVats: 1,
      bands: [
        { upTo: 30, action: 'skip', value: 0 },
        { upTo: 120, action: 'fixed', value: 80 },
        { upTo: 200, action: 'fixed', value: 200 },
        { upTo: null, action: 'round', value: 100 },
      ],
    },
    {
      id: 'vr-small',
      name: '小批量补单',
      bandKey: 'planned',
      remainder: 'nearest',
      remainderThreshold: 0.5,
      minVats: 1,
      bands: [
        { upTo: 50, action: 'skip', value: 0 },
        { upTo: 100, action: 'fixed', value: 60 },
        { upTo: null, action: 'round', value: 10 },
      ],
    },
  ]
}

function text(value) {
  return String(value ?? '').trim()
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function roundKg(value) {
  return Math.round(value * 100) / 100
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '--'
  const fixed = roundKg(value)
  return Number.isInteger(fixed) ? String(fixed) : fixed.toFixed(2)
}

export function normalizeVatRule(raw, index = 0) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const bands = []
  for (const entry of Array.isArray(source.bands) ? source.bands : []) {
    if (!entry || typeof entry !== 'object') continue
    bands.push({
      upTo: toNumber(entry.upTo, null),
      action: ACTIONS.has(entry.action) ? entry.action : 'skip',
      value: Math.max(0, toNumber(entry.value, 0)),
    })
  }
  // 上限升序、末档无上限：脏数据也不会让判定乱跳。
  bands.sort((a, b) => (a.upTo === null ? Infinity : a.upTo) - (b.upTo === null ? Infinity : b.upTo))
  if (bands.length === 0) bands.push({ upTo: null, action: 'vat', value: 240 })
  if (bands[bands.length - 1].upTo !== null) bands.push({ upTo: null, action: 'vat', value: 240 })

  return {
    id: text(source.id) || `vr-${index + 1}`,
    name: text(source.name) || `规则 ${index + 1}`,
    bandKey: BAND_KEYS.has(source.bandKey) ? source.bandKey : 'planned',
    remainder: REMAINDERS.has(source.remainder) ? source.remainder : 'nearest',
    remainderThreshold: clamp(toNumber(source.remainderThreshold, 0.5), 0, 1),
    minVats: Math.max(0, Math.round(toNumber(source.minVats, 1))),
    bands,
  }
}

// 规则列表归一化：id 去重；空列表回落到默认两条规则（老设置升级与导入都走这里）。
export function normalizeVatRules(source) {
  const entries = Array.isArray(source) ? source : []
  if (entries.length === 0) return createDefaultVatRules()

  const used = new Set()
  const rules = []
  entries.forEach((entry, index) => {
    const rule = normalizeVatRule(entry, index)
    let id = rule.id
    let suffix = 2
    while (used.has(id)) {
      id = `${rule.id}-${suffix}`
      suffix += 1
    }
    used.add(id)
    rules.push({ ...rule, id })
  })
  return rules
}

export function validateVatRule(raw) {
  const rule = normalizeVatRule(raw)
  const errors = []

  if (!text(raw?.name)) errors.push({ message: '规则名称必须填写' })

  const bands = Array.isArray(raw?.bands) ? raw.bands : []
  if (bands.length === 0) errors.push({ message: `规则「${rule.name}」至少需要一个区间` })

  let previousUpTo = 0
  bands.forEach((band, index) => {
    const label = `区间 ${index + 1}`
    const upTo = toNumber(band?.upTo, null)
    const action = ACTIONS.has(band?.action) ? band.action : null
    if (!action) errors.push({ message: `${label}：处理方式必须选择` })
    if (action && action !== 'skip' && !(toNumber(band?.value, 0) > 0)) {
      errors.push({ message: `${label}：${VAT_ACTIONS.find((item) => item.value === action)?.valueLabel}必须大于 0` })
    }
    if (index === bands.length - 1) {
      if (upTo !== null) errors.push({ message: '最后一档必须无上限' })
      return
    }
    if (upTo === null) {
      errors.push({ message: `${label}：只有最后一档可以无上限` })
      return
    }
    if (upTo <= previousUpTo) {
      errors.push({ message: `${label}：上限必须大于上一档的上限（${formatNumber(previousUpTo)}）` })
    }
    previousUpTo = upTo
  })

  return errors
}

export function validateVatRules(source) {
  const rules = Array.isArray(source) ? source : []
  const errors = []
  const seen = new Set()
  rules.forEach((entry, index) => {
    for (const error of validateVatRule(entry)) errors.push(error)
    const name = text(entry?.name)
    if (!name) return
    if (seen.has(name)) errors.push({ message: `规则名称「${name}」重复` })
    seen.add(name)
  })
  return errors
}

export function findVatRule(settings, ruleId) {
  const id = text(ruleId)
  if (!id) return null
  const rules = Array.isArray(settings?.vatRules) ? settings.vatRules : []
  return rules.find((rule) => rule.id === id) ?? null
}

// SPU 生效的规则：SKU 覆盖 > SPU 绑定 > 默认规则；显式绑「不取整」时返回 null。
export function resolveVatRule(settings, { skuId, product } = {}) {
  const skuKey = text(skuId)
  const skuRules = settings?.skuVatRules ?? {}
  if (skuKey && Object.prototype.hasOwnProperty.call(skuRules, skuKey)) {
    const bound = text(skuRules[skuKey])
    if (bound === VAT_RULE_NONE) return null
    const rule = findVatRule(settings, bound)
    if (rule) return rule
  }

  const productKey = text(product)
  const spuRules = settings?.spuVatRules ?? {}
  if (productKey && Object.prototype.hasOwnProperty.call(spuRules, productKey)) {
    const bound = text(spuRules[productKey])
    if (bound === VAT_RULE_NONE) return null
    const rule = findVatRule(settings, bound)
    if (rule) return rule
  }

  const rules = Array.isArray(settings?.vatRules) ? settings.vatRules : []
  return findVatRule(settings, settings?.defaultVatRuleId) ?? rules[0] ?? null
}

function metricValueOf(rule, context) {
  const source = context ?? {}
  if (rule?.bandKey === 'skuMonthlyAvg') return toNumber(source.monthlyAvgCount, null)
  if (rule?.bandKey === 'spuMonthlyAvg') return toNumber(source.spuMonthlyAvg, null)
  return toNumber(source.planned, null)
}

// 命中的分档：从低到高取第一条「上限为空或指标 < 上限」的档（与「30 至不足 120」一致）。
export function resolveVatBand(rule, context) {
  if (!rule) return null
  const metric = metricValueOf(rule, context)
  const missing = metric === null
  const value = missing ? 0 : metric
  const bands = Array.isArray(rule.bands) ? rule.bands : []
  const index = bands.findIndex((band) => band.upTo === null || value < band.upTo - EPSILON)
  const band = index >= 0 ? bands[index] : null
  return {
    band,
    index,
    metricValue: metric,
    missing,
    from: index > 0 ? bands[index - 1].upTo : 0,
    unit: VAT_BAND_KEYS.find((entry) => entry.value === rule.bandKey)?.unit ?? '公斤',
  }
}

function countVats(rawVats, rule) {
  const policy = REMAINDERS.has(rule.remainder) ? rule.remainder : 'nearest'
  if (policy === 'ceil') return Math.ceil(rawVats - EPSILON)
  if (policy === 'floor') return Math.floor(rawVats + EPSILON)
  const floor = Math.floor(rawVats + EPSILON)
  const remainder = rawVats - floor
  return remainder + EPSILON >= clamp(rule.remainderThreshold, 0, 1) ? floor + 1 : floor
}

// 核心换算：need（公斤）→ 缸数 / 实际下单量 / 与需安排的差额 / 提示。
export function planOrderQuantity(need, rule, context = {}) {
  const raw = Math.max(0, toNumber(need, 0) ?? 0)
  const empty = {
    ruleId: '',
    ruleName: '',
    raw,
    action: 'none',
    bandIndex: -1,
    bandText: '',
    kgPerVat: null,
    rawVats: null,
    vatCount: null,
    rounded: raw,
    remainderKg: 0,
    deltaKg: 0,
    deltaRate: 0,
    warnings: [],
  }
  if (!rule) return empty
  if (raw <= 0) {
    return { ...empty, ruleId: rule.id, ruleName: rule.name, action: 'skip', vatCount: 0, rounded: 0 }
  }

  const matched = resolveVatBand(rule, { ...context, planned: raw })
  const band = matched?.band
  const warnings = []
  if (matched?.missing) {
    warnings.push(`缺少「${VAT_BAND_KEYS.find((entry) => entry.value === rule.bandKey)?.label ?? '判据'}」，按最低档处理`)
  }
  if (!band) {
    warnings.push('需安排量超出规则区间，按原量下单')
    return { ...empty, ruleId: rule.id, ruleName: rule.name, warnings }
  }

  const base = {
    ...empty,
    ruleId: rule.id,
    ruleName: rule.name,
    action: band.action,
    bandIndex: matched.index,
    bandText: describeBand(matched),
  }

  if (band.action === 'skip') {
    return {
      ...base,
      vatCount: 0,
      rounded: 0,
      deltaKg: -raw,
      deltaRate: -1,
      warnings: [...warnings, `规则判定不补，需安排 ${formatNumber(raw)} 公斤不下单`],
    }
  }

  if (band.action === 'fixed') {
    const rounded = roundKg(band.value)
    const deltaKg = roundKg(rounded - raw)
    return {
      ...base,
      kgPerVat: rounded,
      rawVats: 1,
      vatCount: 1,
      rounded,
      deltaKg,
      deltaRate: raw > 0 ? deltaKg / raw : 0,
      warnings,
    }
  }

  const kgPerVat = roundKg(band.value)
  if (!(kgPerVat > 0)) {
    return { ...base, warnings: [...warnings, '每缸公斤未配置，按原量下单'] }
  }

  const rawVats = raw / kgPerVat
  const vatCount = Math.max(countVats(rawVats, rule), Math.round(rule.minVats ?? 0))
  const rounded = roundKg(vatCount * kgPerVat)
  const deltaKg = roundKg(rounded - raw)

  return {
    ...base,
    kgPerVat,
    rawVats: roundKg(rawVats),
    vatCount,
    rounded,
    remainderKg: roundKg(raw - Math.floor(rawVats + EPSILON) * kgPerVat),
    deltaKg,
    deltaRate: raw > 0 ? deltaKg / raw : 0,
    warnings,
  }
}

function actionText(band) {
  if (band.action === 'skip') return '不下单（0 公斤）'
  if (band.action === 'fixed') return `固定 ${formatNumber(band.value)} 公斤`
  if (band.action === 'vat') return `每缸 ${formatNumber(band.value)} 公斤，按缸取整`
  const step = Number(band.value)
  const label = step === 100 ? '整百' : step === 10 ? '整十' : `${formatNumber(step)} 公斤`
  return `四舍五入到${label}`
}

function describeBand(matched) {
  const band = matched?.band
  if (!band) return ''
  return `${rangeText(matched)} → ${actionText(band)}`
}

function rangeText(matched) {
  const band = matched?.band
  if (!band) return ''
  const unit = matched.unit
  const from = formatNumber(matched.from)
  if (band.upTo === null) return `${from} ${unit}及以上`
  if (!(matched.from > 0)) return `低于 ${formatNumber(band.upTo)} ${unit}`
  return `${from} 至不足 ${formatNumber(band.upTo)} ${unit}`
}

// 规则表的「区间与动作」行：配置页列表与详情摘要共用。
export function describeVatBands(rule) {
  if (!rule) return []
  const bands = Array.isArray(rule.bands) ? rule.bands : []
  return bands.map((band, index) => {
    const from = index > 0 ? bands[index - 1].upTo : 0
    const matched = { band, from, unit: VAT_BAND_KEYS.find((entry) => entry.value === rule.bandKey)?.unit ?? '公斤' }
    return {
      index,
      rangeText: rangeText(matched),
      actionText: actionText(band),
      action: band.action,
      upTo: band.upTo,
      value: band.value,
    }
  })
}

export function summarizeVatRule(rule) {
  return describeVatBands(rule)
    .map((entry) => `${entry.rangeText} ${entry.actionText}`)
    .join(' · ')
}

export function describeVatRemainder(rule) {
  if (!rule) return ''
  if (rule.remainder === 'floor') return '整缸向下取整（零头舍弃）'
  if (rule.remainder === 'ceil') return '整缸向上取整（不足补一缸）'
  return `就近取整（余量 ≥ ${Math.round((rule.remainderThreshold ?? 0.5) * 100)}% 一缸时补一缸，否则舍弃）`
}
