<script setup>
// 顶部导航：左侧是主面板组（主面板 → 销售表 → 采购下单 → 下单设置 → 配置信息），
// 右侧是屏蔽列表这类辅助入口。
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
  margin-bottom: 18px;
  border-bottom: 1px solid var(--industrial-grid);
}

.page-navigation-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.page-navigation-group--utility {
  align-items: center;
}

.page-navigation-link {
  flex-shrink: 0;
  padding: 9px 16px;
  color: var(--industrial-muted);
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
}

@media (max-width: 720px) {
  .page-navigation-group {
    gap: 2px;
  }

  .page-navigation-group--utility {
    justify-content: flex-end;
  }

  .page-navigation-link {
    padding: 8px 10px;
    font-size: 13px;
  }
}
</style>
