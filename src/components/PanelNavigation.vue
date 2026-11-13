<script setup>
// 顶部导航：左侧是主面板组（主面板 → 销售表 → 采购下单 → 设置），
// 右侧是屏蔽列表这类辅助入口，辅助入口不带角标（数量在屏蔽列表页内按 SKU 统计）。
import { mainNavEntries, utilityNavEntries } from '@/data/panels'
</script>

<template>
  <nav class="page-navigation" aria-label="页面导航">
    <div class="page-navigation-group">
      <RouterLink
        v-for="entry in mainNavEntries"
        :key="entry.key"
        :to="entry.path"
        class="page-navigation-link"
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
.page-navigation-link.router-link-active {
  color: var(--industrial-primary);
}

.page-navigation-link.router-link-active {
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
