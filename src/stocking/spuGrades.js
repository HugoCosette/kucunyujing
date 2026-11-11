// SPU（品名）分级：按「该品名下全部 SKU 的月均条数之和」落到 S+ / S / A / B / C / Z 六档。
// 阈值存在配置方案的 config.spuGrades 上，配置页可改，主面板品名汇总行的模式列展示等级。
// 判定与模式一致：从高到低取第一条命中的档，末档 Z 兜底收下低于上一档的全部 SPU。

// 固定 6 档、固定顺序（顺序即判定优先级），不可增删；只有名称与月均条数下限可改。
export const SPU_GRADE_TIERS = [
  { key: 'sPlus', label: 'S+', tone: 'violet', minMonthlyAvg: 2500 },
  { key: 's', label: 'S', tone: 'red', minMonthlyAvg: 300 },
  { key: 'a', label: 'A', tone: 'amber', minMonthlyAvg: 100 },
  { key: 'b', label: 'B', tone: 'blue', minMonthlyAvg: 30 },
  { key: 'c', label: 'C', tone: 'green', minMonthlyAvg: 1 },
  // 末档兜底：没有下限，minMonthlyAvg 恒为 null。
  { key: 'z', label: 'Z', tone: 'gray', minMonthlyAvg: null },
]

// 展示色板只由档位决定，不进配置：配置里只有名称与阈值。
export const SPU_GRADE_TONES = Object.fromEntries(
  SPU_GRADE_TIERS.map((tier) => [tier.key, tier.tone]),
)

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toNonNegative(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function createDefaultSpuGrades() {
  return {
    tiers: SPU_GRADE_TIERS.map(({ key, label, minMonthlyAvg }) => ({
      key,
      label,
      minMonthlyAvg,
    })),
  }
}

// 归一化：固定 6 档、固定顺序，缺失的档按内置默认补齐，非法数值回落默认。
export function normalizeSpuGrades(source) {
  const input = isPlainObject(source) ? source : {}
  const entries = Array.isArray(input.tiers) ? input.tiers : []
  const byKey = new Map()
  for (const entry of entries) {
    const key = String(entry?.key ?? '').trim()
    if (key && !byKey.has(key)) byKey.set(key, entry)
  }

  return {
    tiers: SPU_GRADE_TIERS.map((definition) => {
      const entry = isPlainObject(byKey.get(definition.key)) ? byKey.get(definition.key) : {}
      return {
        key: definition.key,
        label: String(entry.label ?? '').trim() || definition.label,
        minMonthlyAvg:
          definition.minMonthlyAvg === null
            ? null
            : toNonNegative(entry.minMonthlyAvg, definition.minMonthlyAvg),
      }
    }),
  }
}

export function validateSpuGrades(source) {
  const { tiers } = normalizeSpuGrades(source)
  const errors = []
  const labels = new Set()

  tiers.forEach((tier, index) => {
    if (labels.has(tier.label)) {
      errors.push({ message: `SPU 等级名称「${tier.label}」重复` })
    }
    labels.add(tier.label)

    // 末档 Z 是兜底，没有下限。
    if (index === tiers.length - 1) return
    if (!Number.isFinite(tier.minMonthlyAvg)) {
      errors.push({ message: `SPU 等级 ${tier.label}：月均条数下限必须填写` })
      return
    }
    const previous = tiers[index - 1]
    if (
      previous &&
      Number.isFinite(previous.minMonthlyAvg) &&
      previous.minMonthlyAvg <= tier.minMonthlyAvg
    ) {
      errors.push({
        message: `SPU 分级阈值需从高到低递减：「${previous.label}」≥ ${previous.minMonthlyAvg} 必须大于「${tier.label}」≥ ${tier.minMonthlyAvg}`,
      })
    }
  })

  return errors
}

// 月均条数缺失（没有销售表数据）时不硬判成 Z，返回 null 让界面显示「—」。
export function resolveSpuGrade(monthlyAvg, grades) {
  if (!Number.isFinite(monthlyAvg)) return null
  const tiers = Array.isArray(grades?.tiers) ? grades.tiers : createDefaultSpuGrades().tiers

  for (const tier of tiers) {
    if (tier.minMonthlyAvg === null || monthlyAvg >= tier.minMonthlyAvg) {
      return { ...tier, tone: SPU_GRADE_TONES[tier.key] ?? 'gray' }
    }
  }

  const fallback = tiers[tiers.length - 1] ?? null
  return fallback ? { ...fallback, tone: SPU_GRADE_TONES[fallback.key] ?? 'gray' } : null
}

// 配置页摘要与悬停说明用：返回 { sPlus: '≥ 2500', …, z: '< 1' }（相对阈值，前面拼「月均条数」即可）。
export function describeSpuGradeThresholds(grades) {
  const { tiers } = normalizeSpuGrades(grades)
  return Object.fromEntries(
    tiers.map((tier, index) => {
      if (tier.minMonthlyAvg !== null) return [tier.key, `≥ ${tier.minMonthlyAvg}`]
      const previous = tiers[index - 1]
      return [
        tier.key,
        previous && Number.isFinite(previous.minMonthlyAvg)
          ? `< ${previous.minMonthlyAvg}`
          : '兜底',
      ]
    }),
  )
}
