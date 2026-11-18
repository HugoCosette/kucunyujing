// 下单填量的颜色口径（唯一一份，下单页与下单弹窗共用）：
// 未下单灰 → < 80% 黄 → 80% ~ 100% 绿 → 超出但还在一缸以内仍绿 → 超过一缸红。
// 「一缸以内」按该 SKU 的缸型判断：缸本来就要装满才省运费，多出来半缸是正常取舍。
export const FILL_LOW_RATIO = 0.8

const EPSILON = 1e-6

export function fillTone(filledKg, plannedKg, perVatKg) {
  if (!(filledKg > 0)) return 'idle'
  if (!(plannedKg > 0)) return 'ok'
  if (filledKg < plannedKg * FILL_LOW_RATIO - EPSILON) return 'low'
  const over = filledKg - plannedKg
  if (over <= EPSILON) return 'ok'
  return Number(perVatKg) > 0 && over <= Number(perVatKg) + EPSILON ? 'ok' : 'err'
}
