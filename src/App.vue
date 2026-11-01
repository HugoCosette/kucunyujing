<script setup>
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <RouterView :key="route.path" />
</template>
