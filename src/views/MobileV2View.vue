<script setup lang="ts">
import ConsoleDiscoveredBotsPanel from '@/components/console/ConsoleDiscoveredBotsPanel.vue';

const botStore = useBotStore();

// Experimental snappier mobile view (sandbox for /mobile). Same data + panels as MobileView.vue,
// but the open-trades panel uses the lightweight hand-rolled MobileOpenTradesTable instead of the
// TanStack-backed TradeList — the open-trades list is the hot path (re-rendered every 5s poll).
// Closed Trades and VPS discovery are collapsed by default — both are heavy and rarely needed at a
// glance on mobile. Discovery uses a mount-once latch (its onMounted fires an SSH-backed fetch, so we
// keep it mounted after first open); Closed Trades uses a plain v-if (no network, so fully unmounting
// on collapse stops its recurring concat+sort/table work — and skips the downstream cost of the
// shared store's 60s full-history refetch being rendered).
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
      <div class="v2-panel p-1">
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
      <div class="v2-panel p-1">
        <MobileOpenTradesTable :trades="botStore.allOpenTradesSelectedBots" multi-bot-view />
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
      <div v-if="showClosed" class="v2-panel v2-panel-deferred p-1">
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
      <div v-if="discoveryOpened" v-show="showDiscovery" class="v2-panel v2-panel-deferred p-1">
        <ConsoleDiscoveredBotsPanel />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Isolate each panel's layout/paint/style so an open-trades re-render (every 5s poll) doesn't
   invalidate sibling panels. */
.v2-panel {
  contain: content;
}
/* Below-the-fold panels: skip layout+paint entirely until scrolled into view. The intrinsic-size
   placeholder prevents scroll-jump before first render. */
.v2-panel-deferred {
  content-visibility: auto;
  contain-intrinsic-size: auto 400px;
}

/* Compact all nested tables (Nuxt UI UTable + native <table>) on the Mobile page only.
   :deep() pierces scoped styles to reach the rendered cells inside child components (BotComparisonList,
   the closed-trades TradeList, and the discovery panel — the hand-rolled open table sets its own padding). */
.mobile-compact :deep(th),
.mobile-compact :deep(td) {
  padding: 0.25rem 0.4rem !important; /* py-1 px-1.5 — overrides UTable's px-4 py-3.5 default */
  line-height: 1.15;
}
.mobile-compact :deep(thead th) {
  font-size: 0.88rem;
}
/* UCard header (Discovered Bots panel) — shrink chrome */
.mobile-compact :deep([class*='card'] > [class*='header']) {
  padding: 0.25rem 0.5rem;
}
/* Pagination + filter strip inside TradeList */
.mobile-compact :deep(.flex.justify-end) {
  padding: 0.25rem 0.25rem;
}
</style>
