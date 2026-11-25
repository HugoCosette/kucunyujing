// 补货 / 下单数量输入：统一限制为最多 6 位整数（最多 999999 公斤）。
// ElInputNumber 用 QUANTITY_MAX 兜住模型值；vQuantityDigits 在键入 / 粘贴时直接截断，
// 避免先显示 7 位数、失焦后才弹回上限。
export const QUANTITY_MAX_DIGITS = 6
export const QUANTITY_MAX = Number('9'.repeat(QUANTITY_MAX_DIGITS))

// 只保留第一段整数数字的前 digits 位；空串 / 纯符号保持空，清空输入框仍然有效。
export function clampQuantityDigits(raw, digits = QUANTITY_MAX_DIGITS) {
  const match = String(raw ?? '').match(/\d+/)
  return match ? match[0].slice(0, digits) : ''
}

// 挂在 ElInputNumber / 原生 input 上：捕获阶段改写目标值，组件随后读到的就是截断后的数量。
export const vQuantityDigits = {
  mounted(el, binding) {
    const digits = Number(binding.value) > 0 ? Number(binding.value) : QUANTITY_MAX_DIGITS
    const handler = (event) => {
      const target = event.target
      if (!target || typeof target.value !== 'string') return
      const limited = clampQuantityDigits(target.value, digits)
      if (limited !== target.value) target.value = limited
    }
    el.__quantityDigitsHandler = handler
    el.addEventListener('input', handler, true)
  },
  unmounted(el) {
    if (!el.__quantityDigitsHandler) return
    el.removeEventListener('input', el.__quantityDigitsHandler, true)
    delete el.__quantityDigitsHandler
  },
}
