<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

// 轻量虚拟滚动容器：弹窗里的长列表（紧急补货、采购清单）可能有上万行，
// 一次性渲染会长时间阻塞主线程，这里只渲染视口内的行。
const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  itemHeight: {
    type: Number,
    default: 44,
  },
  overscan: {
    type: Number,
    default: 6,
  },
})

const scrollRef = ref(null)
const headerRef = ref(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)
const headerHeight = ref(0)
let scrollFrame = 0
let resizeObserver = null

function handleScroll() {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    scrollTop.value = scrollRef.value?.scrollTop ?? 0
  })
}

function measureHeader() {
  headerHeight.value = headerRef.value?.offsetHeight ?? 0
}

const visible = computed(() => {
  const total = props.items.length
  if (total === 0) return { items: [], offset: 0, start: 0, total: 0 }

  // 表头固定在最上方，虚拟窗口要按「滚动位置 - 表头高度」计算。
  const listTop = Math.max(0, scrollTop.value - headerHeight.value)
  const listHeight = Math.max(props.itemHeight, viewportHeight.value - headerHeight.value)
  const start = Math.max(0, Math.floor(listTop / props.itemHeight) - props.overscan)
  const count = Math.ceil(listHeight / props.itemHeight) + props.overscan * 2
  const end = Math.min(total, start + count)
  return {
    items: props.items.slice(start, end),
    offset: start * props.itemHeight,
    start,
    total,
  }
})

onMounted(() => {
  const element = scrollRef.value
  if (!element) return
  viewportHeight.value = element.clientHeight || 320
  measureHeader()
  if (typeof ResizeObserver === 'undefined') return

  resizeObserver = new ResizeObserver((entries) => {
    viewportHeight.value = entries[0]?.contentRect.height ?? viewportHeight.value
    measureHeader()
  })
  resizeObserver.observe(element)
})

onBeforeUnmount(() => {
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="scrollRef" class="virtual-list" @scroll.passive="handleScroll">
    <div v-if="$slots.header" ref="headerRef" class="virtual-list__head">
      <slot name="header" />
    </div>
    <div class="virtual-list__viewport" :style="{ height: `${visible.total * itemHeight}px` }">
      <div class="virtual-list__rows" :style="{ transform: `translateY(${visible.offset}px)` }">
        <div
          v-for="(item, index) in visible.items"
          :key="item?.id ?? visible.start + index"
          class="virtual-list__row"
          :style="{ height: `${itemHeight}px` }"
        >
          <slot :item="item" :index="visible.start + index" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-list {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.virtual-list__head {
  position: sticky;
  top: 0;
  z-index: 1;
}

.virtual-list__viewport {
  position: relative;
}

.virtual-list__rows {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
}

.virtual-list__row {
  box-sizing: border-box;
}
</style>
