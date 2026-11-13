<script setup>
import PanelNavigation from '@/components/PanelNavigation.vue'
import HiddenSkusPanel from '@/components/HiddenSkusPanel.vue'
</script>

<template>
  <main class="hidden-page">
    <PanelNavigation />
    <HiddenSkusPanel />
  </main>
</template>

<style scoped>
.hidden-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 8px 14px 12px;
  overflow: hidden;
  color: var(--industrial-text);
  background: var(--industrial-page);
}

@media (max-width: 720px) {
  .hidden-page {
    padding: 8px;
  }
}
</style>
