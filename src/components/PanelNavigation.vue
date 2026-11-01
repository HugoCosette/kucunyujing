<script setup>
// 顶部导航：左侧是主面板与“配置信息”，右侧是示例数据区（示例面板 / 示例配置）。
// ⚠️ 右侧示例数据区仅用于对照演示，请勿修改其中的示例数据与示例配置。
import { exampleNavEntries, mainNavEntries } from '@/data/panels'
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

    <!-- 示例数据区：仅供对照演示，请勿修改 -->
    <div class="page-navigation-group page-navigation-group--example">
      <span class="page-navigation-hint">示例数据，请勿修改</span>
      <RouterLink
        v-for="entry in exampleNavEntries"
        :key="entry.key"
        :to="entry.path"
        class="page-navigation-link page-navigation-link--example"
      >
        {{ entry.label }}
      </RouterLink>
    </div>
  </nav>
</template>

<style scoped>
.page-navigation {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
  border-bottom: 1px solid var(--industrial-grid);
}

.page-navigation-group {
  display: flex;
  gap: 6px;
}

.page-navigation-group--example {
  align-items: center;
}

.page-navigation-hint {
  margin-right: 2px;
  padding: 2px 8px;
  color: var(--industrial-muted);
  border: 1px dashed var(--industrial-grid);
  border-radius: 10px;
  font-size: 12px;
  white-space: nowrap;
}

.page-navigation-link {
  padding: 9px 16px;
  color: var(--industrial-muted);
  border-bottom: 2px solid transparent;
  text-decoration: none;
}

.page-navigation-link:hover,
.page-navigation-link.router-link-active {
  color: var(--industrial-primary);
}

.page-navigation-link.router-link-active {
  border-bottom-color: var(--industrial-primary);
  font-weight: 600;
}

.page-navigation-link--example {
  color: var(--industrial-overstock);
}

.page-navigation-link--example:hover,
.page-navigation-link--example.router-link-active {
  color: var(--industrial-overstock);
}

.page-navigation-link--example.router-link-active {
  border-bottom-color: var(--industrial-overstock);
}
</style>
