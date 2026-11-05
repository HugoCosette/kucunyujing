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
    @click.stop="handleClick"
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3" />
      <path d="M8 7.2v4.1" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
    </svg>
  </button>
</template>

<style scoped>
.sku-detail-trigger {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  color: var(--industrial-muted);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  transition:
    color 120ms ease,
    background 120ms ease;
}

.sku-detail-trigger:hover {
  color: var(--industrial-primary);
  background: rgba(63, 113, 141, 0.16);
}

.sku-detail-trigger:focus-visible {
  outline: 2px solid var(--industrial-primary);
  outline-offset: 1px;
}

.sku-detail-trigger svg {
  width: 14px;
  height: 14px;
  fill: none;
}
</style>
