// 主面板的显示筛选：把「补一点点没意义」的小额补货从「紧急 / 常规」两个预警筛选里排除。
// 它只改筛选按钮的计数与结果，行本身仍在「全部」里、数据也一行不动 —— 和屏蔽清单不是一回事。
// 门槛存在配置方案的 config.displayFilters 上，与 SPU 分级一样只影响展示，不参与备货计算，不升配置版本。

export const LOW_PLANNED_DEFAULT_KG = 30

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toPositive(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

// 默认开启：紧急 / 常规里低于 30 公斤的不列出来（更像实际下的单）。
export function createDefaultDisplayFilters() {
  return {
    lowPlanned: { enabled: true, minKg: LOW_PLANNED_DEFAULT_KG },
  }
}

export function normalizeDisplayFilters(source) {
  const input = isPlainObject(source) ? source : {}
  const lowPlanned = isPlainObject(input.lowPlanned) ? input.lowPlanned : {}
  return {
    lowPlanned: {
      // 缺省即开启：老配置没有这一段时按新功能生效，不需要用户先去设置里找开关。
      enabled: lowPlanned.enabled === undefined ? true : Boolean(lowPlanned.enabled),
      minKg: toPositive(lowPlanned.minKg, LOW_PLANNED_DEFAULT_KG),
    },
  }
}

export function validateDisplayFilters(source) {
  const { minKg } = normalizeDisplayFilters(source).lowPlanned
  if (!Number.isFinite(minKg) || minKg <= 0) {
    return [{ message: '小额补货门槛必须是大于 0 的公斤数' }]
  }
  return []
}

// 实际生效的门槛：关闭时返回 0，调用方按「不筛」处理。
export function resolveLowPlannedThreshold(filters) {
  const { enabled, minKg } = normalizeDisplayFilters(filters).lowPlanned
  return enabled ? minKg : 0
}
