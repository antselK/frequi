<script setup lang="ts">
import ConsoleDiscoveredBotsPanel from '@/components/console/ConsoleDiscoveredBotsPanel.vue';
import DashboardView from '@/views/DashboardView.vue';
</script>

<template>
  <div class="w-full h-full flex flex-col gap-4">
    <DashboardView />
    <ConsoleDiscoveredBotsPanel />
  </div>
</template>
