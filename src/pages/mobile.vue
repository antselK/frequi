<script setup lang="ts">
import ConsoleDiscoveredBotsPanel from '@/components/console/ConsoleDiscoveredBotsPanel.vue';

definePage({
  meta: {
    allowAnonymous: true,
  },
});

const botStore = useBotStore();

// Closed Trades and the VPS discovery panel are collapsed by default — both are heavy and rarely
// needed at a glance on mobile. Discovery uses a mount-once latch (its onMounted fires an SSH-backed
// fetch, so we keep it mounted after first open); Closed Trades uses a plain v-if (no network, so
// fully unmounting on collapse stops its recurring concat+sort/table work).
const showClosed = ref(false);
const showDiscovery = ref(false);
const discoveryOpened = ref(false);

function toggleDiscovery() {
  showDiscovery.value = !showDiscovery.value;
  if (showDiscovery.value) discoveryOpened.value = true;
}

onMounted(async () => {
  // activeBot is undefined when no bot is selected (fresh/zero-bot session) — skip the fetch.
  if (!botStore.activeBot) return;
  botStore.activeBot.getOpenTrades();
  botStore.activeBot.getProfit();
});
</script>

<template>
  <div class="mobile-compact w-full flex flex-col gap-2 p-1 text-[15px]">
    <!-- Bot Comparison -->
    <div class="border border-surface-300 dark:border-surface-700 rounded">
      <div
        class="bg-surface-100 dark:bg-surface-800 px-2 py-1 font-semibold text-sm border-b border-surface-300 dark:border-surface-700"
      >
        Bot comparison
      </div>
      <div class="p-1">
        <BotComparisonList />
      </div>
    </div>

    <!-- Open Trades -->
    <div class="border border-surface-300 dark:border-surface-700 rounded">
      <div
        class="bg-surface-100 dark:bg-surface-800 px-2 py-1 font-semibold text-sm border-b border-surface-300 dark:border-surface-700"
      >
        Open Trades
      </div>
      <div class="p-1">
        <TradeList active-trades :trades="botStore.allOpenTradesSelectedBots" multi-bot-view />
      </div>
    </div>

    <!-- Closed Trades -->
    <div class="border border-surface-300 dark:border-surface-700 rounded">
      <div
        class="bg-surface-100 dark:bg-surface-800 px-2 py-1 font-semibold text-sm border-b border-surface-300 dark:border-surface-700 flex items-center justify-between"
      >
        <span>Closed Trades</span>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :label="showClosed ? 'Hide' : 'Show'"
          @click="showClosed = !showClosed"
        />
      </div>
      <div v-if="showClosed" class="p-1">
        <TradeList
          :active-trades="false"
          show-filter
          :trades="botStore.allClosedTradesSelectedBots"
          multi-bot-view
        />
      </div>
    </div>

    <!-- Discovered Bots from VPS -->
    <div class="border border-surface-300 dark:border-surface-700 rounded">
      <div
        class="bg-surface-100 dark:bg-surface-800 px-2 py-1 font-semibold text-sm border-b border-surface-300 dark:border-surface-700 flex items-center justify-between"
      >
        <span>Discovered Bots from VPS</span>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :label="showDiscovery ? 'Hide' : 'Show'"
          @click="toggleDiscovery"
        />
      </div>
      <div v-if="discoveryOpened" v-show="showDiscovery" class="p-1">
        <ConsoleDiscoveredBotsPanel />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Compact all nested tables (Nuxt UI UTable + native <table>) on the Mobile page only.
   :deep() pierces scoped styles to reach the rendered cells inside child components. */
.mobile-compact :deep(th),
.mobile-compact :deep(td) {
  padding: 0.25rem 0.4rem !important; /* py-1 px-1.5 — overrides UTable's px-4 py-3.5 default */
  line-height: 1.15;
}
.mobile-compact :deep(thead th) {
  font-size: 0.88rem;
}
/* UCard header (Discovered Bots panel) — shrink chrome */
.mobile-compact :deep([class*="card"] > [class*="header"]) {
  padding: 0.25rem 0.5rem;
}
/* Pagination + filter strip inside TradeList */
.mobile-compact :deep(.flex.justify-end) {
  padding: 0.25rem 0.25rem;
}
</style>
