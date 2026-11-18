<script setup>
// 顶部导航：左侧是主面板组（需求表 → 采购下单 → 销售表 → 配置板块），顺序与显示名都在 panels.js，
// 右侧是屏蔽列表这类辅助入口，辅助入口不带角标（数量在屏蔽列表页内按 SKU 统计）。
// 高亮按路径前缀判定：子面板（如 /purchase/history）也要让「采购下单」保持选中。
import { useRoute } from 'vue-router'
import { mainNavEntries, utilityNavEntries } from '@/data/panels'

const route = useRoute()

function isActive(entry) {
  const path = route.path
  if (entry.path === '/') return path === '/'
  return path === entry.path || path.startsWith(`${entry.path}/`)
}
</script>

<template>
  <nav class="page-navigation" aria-label="页面导航">
    <div class="page-navigation-group">
      <RouterLink
        v-for="entry in mainNavEntries"
        :key="entry.key"
        :to="entry.path"
        class="page-navigation-link"
        :class="{ 'is-active': isActive(entry) }"
      >
        {{ entry.label }}
      </RouterLink>
    </div>

    <div class="page-navigation-group page-navigation-group--utility">
      <RouterLink
        v-for="entry in utilityNavEntries"
        :key="entry.key"
        :to="entry.path"
        class="page-navigation-link page-navigation-link--utility"
        :class="{ 'is-active': isActive(entry) }"
      >
        {{ entry.label }}
      </RouterLink>
    </div>
  </nav>
</template>

<style scoped>
.page-navigation {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 6px 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--industrial-grid);
}

.page-navigation-group {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  min-width: 0;
}

.page-navigation-group--utility {
  align-items: flex-end;
}

.page-navigation-link {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 38px;
  padding: 0 18px;
  color: var(--industrial-muted);
  font-size: 13.5px;
  border-bottom: 2px solid transparent;
  text-decoration: none;
  white-space: nowrap;
}

.page-navigation-link:hover,
.page-navigation-link.router-link-active,
.page-navigation-link.is-active {
  color: var(--industrial-primary);
}

.page-navigation-link.router-link-active,
.page-navigation-link.is-active {
  border-bottom-color: var(--industrial-primary);
  font-weight: 600;
}

.page-navigation-link--utility {
  display: inline-flex;
  align-items: center;
  height: 38px;
  font-size: 12.5px;
}

@media (max-width: 720px) {
  .page-navigation-group {
    gap: 2px;
  }

  .page-navigation-group--utility {
    justify-content: flex-end;
  }

  .page-navigation-link {
    height: 34px;
    padding: 0 10px;
    font-size: 13px;
  }
}
</style>
