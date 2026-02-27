<script setup lang="ts">
import ConsoleDiscoveredBotsPanel from '@/components/console/ConsoleDiscoveredBotsPanel.vue';

const botStore = useBotStore();

onMounted(async () => {
  botStore.activeBot.getOpenTrades();
  botStore.activeBot.getProfit();
});
</script>

<template>
  <div class="w-full flex flex-col gap-4 p-2 text-xs">
    <!-- Bot Comparison -->
    <div class="border border-surface-300 dark:border-surface-700 rounded">
      <div class="bg-surface-100 dark:bg-surface-800 px-3 py-2 font-semibold text-sm border-b border-surface-300 dark:border-surface-700">
        Bot comparison
      </div>
      <div class="p-2">
        <BotComparisonList />
      </div>
    </div>

    <!-- Open Trades -->
    <div class="border border-surface-300 dark:border-surface-700 rounded">
      <div class="bg-surface-100 dark:bg-surface-800 px-3 py-2 font-semibold text-sm border-b border-surface-300 dark:border-surface-700">
        Open Trades
      </div>
      <div class="p-2">
        <TradeList active-trades :trades="botStore.allOpenTradesSelectedBots" multi-bot-view />
      </div>
    </div>

    <!-- Closed Trades -->
    <div class="border border-surface-300 dark:border-surface-700 rounded">
      <div class="bg-surface-100 dark:bg-surface-800 px-3 py-2 font-semibold text-sm border-b border-surface-300 dark:border-surface-700">
        Closed Trades
      </div>
      <div class="p-2">
        <TradeList
          :active-trades="false"
          show-filter
          :trades="botStore.allClosedTradesSelectedBots"
          multi-bot-view
        />
      </div>
    </div>

    <!-- Discovered Bots from VPS -->
    <ConsoleDiscoveredBotsPanel />
  </div>
</template>
