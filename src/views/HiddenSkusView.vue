<script setup>
import PanelNavigation from '@/components/PanelNavigation.vue'
import HiddenSkusPanel from '@/components/HiddenSkusPanel.vue'
</script>

<template>
  <main class="hidden-page">
    <div class="hidden-page__inner">
      <PanelNavigation />

      <header class="hidden-page__heading">
        <h1>屏蔽列表</h1>
        <p>
          主面板上的「屏蔽选中」只把商品记进这份清单：重新导入或刷新后仍然隐藏，源表数据不受影响。勾选品名或
          SKU 后点「解除屏蔽」即可恢复，恢复的行会立即回到主面板。
        </p>
      </header>

      <HiddenSkusPanel />
    </div>
  </main>
</template>

<style scoped>
.hidden-page {
  min-height: 100vh;
  padding: 12px;
  color: var(--industrial-text);
  background: var(--industrial-page);
}

.hidden-page__inner {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px 24px;
  border: 1px solid var(--industrial-grid);
  border-radius: 6px;
  background: var(--industrial-surface);
}

.hidden-page__heading h1 {
  margin: 0 0 4px;
  color: var(--industrial-text);
  font-size: 20px;
}

.hidden-page__heading p {
  max-width: 900px;
  margin: 0;
  color: var(--industrial-muted);
  font-size: 13px;
  line-height: 1.6;
}

@media (max-width: 720px) {
  .hidden-page {
    padding: 8px;
  }

  .hidden-page__inner {
    padding: 8px 10px 16px;
  }
}
</style>
