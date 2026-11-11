import { CUSTOMER_EXCLUSIVE, CUSTOMER_FLOW } from './constants.js'
import { createDefaultConfig } from './defaults.js'

// 演示配置在 v1.5 起「封禁」：方案不出现在配置页下拉里，也不会被激活。
// 这里保留完整的模拟逻辑，下次需要恢复时：
//   1. 删掉 DEMO_PROFILE_DISABLED 或把方案加入 createDefaultProfileFile().profiles
//   2. 配置页方案下拉放开对 demo 的过滤
export const DEMO_PROFILE_DISABLED = true

function coefficients(white, color) {
  return { 黑白: { ...white }, 彩色: { ...color } }
}

// 演示方案：与生产方案同结构（v4 五模式），用一组更宽松的演示阈值与系数。
export function createDemoProfile() {
  const config = createDefaultConfig()
  const auto = config.strategies.find((strategy) => strategy.behavior === 'auto')
  for (const mode of auto?.modes ?? []) {
    if (mode.key === 'hot') {
      mode.range = { from: 20, to: null }
      mode.coefficients = {
        [CUSTOMER_FLOW]: coefficients(
          { redLine: 15, normal: 30, peak: 45 },
          { redLine: 12, normal: 24, peak: 36 },
        ),
        [CUSTOMER_EXCLUSIVE]: null,
      }
    } else if (mode.key === 'normal') {
      mode.range = { from: 8, to: 20 }
      mode.coefficients = {
        [CUSTOMER_FLOW]: coefficients(
          { redLine: 12, normal: 24, peak: 36 },
          { redLine: 8, normal: 16, peak: 24 },
        ),
        [CUSTOMER_EXCLUSIVE]: null,
      }
    } else if (mode.key === 'bulk') {
      mode.range = { from: 2, to: 8 }
    } else if (mode.key === 'tail') {
      mode.range = { from: 0.01, to: 2 }
    }
  }

  return {
    id: 'demo',
    name: '演示配置（已封禁）',
    config,
  }
}
