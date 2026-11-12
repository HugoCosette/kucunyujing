<script setup>
// 只负责表格行里的入口按钮：弹窗本体由页面级 SkuDetailDialog 渲染，
// 避免弹窗挂在虚拟滚动行内随行卸载（遮罩也会被列表容器裁掉）。
const props = defineProps({
  item: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['open'])

function handleClick() {
  if (!props.item) return
  emit('open', props.item)
}
</script>

<template>
  <button
    v-if="item && !item.isProductGroup"
    type="button"
    class="sku-detail-trigger"
    title="查看配置信息与月度销量"
    :aria-label="`查看 ${item.product} ${item.color} 的配置信息与月度销量`"
    aria-haspopup="dialog"
    @click.stop="handleClick"
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="2.2"
        y="2"
        width="11.6"
        height="12"
        rx="2.2"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <path
        d="M5.2 5.9h5.6M5.2 8h5.6M5.2 10.2h3.4"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-width="1.4"
      />
    </svg>
  </button>
</template>

<style scoped>
/* 24px 的方形小按钮：可点区域够大，但底色 / 描边 / 图标都很浅，不抢表格里的数字。 */
.sku-detail-trigger {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: #94a5af;
  background: #f6f9fa;
  border: 1px solid #e4ebef;
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 120ms ease,
    background 120ms ease,
    border-color 120ms ease;
}

.sku-detail-trigger:hover {
  color: var(--industrial-primary);
  background: #eaf1f5;
  border-color: #cddce4;
}

.sku-detail-trigger:active {
  transform: translateY(1px);
}

.sku-detail-trigger:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: 1px;
}

.sku-detail-trigger svg {
  width: 13px;
  height: 13px;
  fill: none;
}
</style>
