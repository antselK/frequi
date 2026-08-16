<script setup lang="ts">
import type { MultiDeletePayload, MultiForceExitPayload, Trade } from '@/types';

// Lightweight open-trades table for the experimental /mobile-v2 view. Deliberately a hand-rolled
// <table> with a keyed v-for instead of the shared TradeList's TanStack UTable: the multi-bot poll
// loop hands us a fresh `trades` array reference every 5s, and a plain keyed list patches rows in
// place far more cheaply than the UTable row-model rebuild. Full action parity is preserved by
// reusing <TradeActionsPopover> + the same wrapper-store actions/dialogs as TradeList.
const props = withDefaults(
  defineProps<{
    trades: Trade[];
    multiBotView?: boolean;
    emptyText?: string;
  }>(),
  {
    multiBotView: true,
    emptyText: 'No open trades.',
  },
);

const botStore = useBotStore();
const settingsStore = useSettingsStore();
const router = useRouter();
const { confirm } = useConfirmBox();
const { forceEntryDialog, forceDcaDialog, forceExitDialog } = useForceTrade();

function formatPriceWithDecimals(price: number | null) {
  return formatPrice(price ?? 0, botStore.activeBot.stakeCurrencyDecimals);
}

// --- Action handlers (mirrored from TradeList.vue to keep behaviour identical) ---
async function forceExitHandler(item: Trade, ordertype: string | undefined = undefined) {
  const message = ordertype
    ? `Really exit trade ${item.trade_id} (Pair ${item.pair}) using a ${ordertype} order?`
    : `Really exit trade ${item.trade_id} (Pair ${item.pair})?`;
  if (
    settingsStore.confirmDialog !== true ||
    (await confirm({
      title: 'Force exit trade',
      description: 'This action cannot be undone.',
      message,
      confirmText: 'Confirm',
    }))
  ) {
    const payload: MultiForceExitPayload = {
      tradeid: String(item.trade_id),
      botId: item.botId,
    };
    if (ordertype) {
      payload.ordertype = ordertype;
    }
    botStore
      .forceSellMulti(payload)
      .then((xxx) => console.log(xxx))
      .catch((error) => console.log(error.response));
  }
}

function forceExitPartialHandler(item: Trade) {
  forceExitDialog({
    trade: item,
    stakeCurrencyDecimals: botStore.activeBot.botState.stake_currency_decimals ?? 3,
  });
}

async function removeTradeHandler(item: Trade) {
  if (
    await confirm({
      title: 'Delete trade',
      description: 'This action cannot be undone.',
      message: `Really delete trade ${item.trade_id} (Pair ${item.pair})?`,
      confirmText: 'Confirm',
    })
  ) {
    const payload: MultiDeletePayload = {
      tradeid: String(item.trade_id),
      botId: item.botId,
    };
    botStore.deleteTradeMulti(payload).catch((error) => console.log(error.response));
  }
}

async function cancelOpenOrderHandler(item: Trade) {
  if (
    await confirm({
      title: 'Cancel open order',
      description: 'This action cannot be undone.',
      message: `Really cancel open order for trade ${item.trade_id} (Pair ${item.pair})?`,
      confirmText: 'Confirm',
    })
  ) {
    const payload: MultiDeletePayload = {
      tradeid: String(item.trade_id),
      botId: item.botId,
    };
    botStore.cancelOpenOrderMulti(payload).catch((error) => console.log(error.response));
  }
}

function reloadTradeHandler(item: Trade) {
  botStore.reloadTradeMulti({ tradeid: String(item.trade_id), botId: item.botId });
}

function handleForceEntry(item: Trade) {
  forceEntryDialog({
    pair: item.pair,
    positionIncrease: true,
  });
}

function handleForceDcaEntry(item: Trade) {
  // The dialog acts on the active bot; in multi-bot view switch to the trade's bot first.
  if (props.multiBotView && botStore.selectedBot !== item.botId) {
    botStore.selectBot(item.botId);
  }
  forceDcaDialog({
    trade: item,
    stakeCurrencyDecimals: botStore.activeBot.botState.stake_currency_decimals ?? 3,
  });
}

function onRowClicked(item: Trade) {
  if (props.multiBotView && botStore.selectedBot !== item.botId) {
    // Multibotview - on click switch to the bot trade view
    botStore.selectBot(item.botId);
  }
  if (item && item.trade_id !== botStore.activeBot.detailTradeId) {
    botStore.activeBot.setDetailTrade(item);
    if (props.multiBotView) {
      router.push('/trade');
    }
  } else {
    botStore.activeBot.setDetailTrade(null);
  }
}

function isSelectedRow(t: Trade) {
  return botStore.selectedBot === t.botId && t.trade_id === botStore.activeBot.detailTradeId;
}
</script>

<template>
  <div class="overflow-x-auto w-full">
    <table class="w-full text-sm border-collapse">
      <thead>
        <tr class="border-b border-surface-300 dark:border-surface-700 text-left text-surface-500">
          <th v-if="multiBotView" class="py-1 pe-2 whitespace-nowrap">Bot</th>
          <th class="py-1 pe-2 whitespace-nowrap">ID</th>
          <th class="py-1 pe-2 whitespace-nowrap">Pair</th>
          <th class="py-1 pe-2 text-right whitespace-nowrap">Amount</th>
          <th class="py-1 pe-2 text-right whitespace-nowrap">Stake</th>
          <th class="py-1 pe-2 text-right whitespace-nowrap">Open</th>
          <th class="py-1 pe-2 text-right whitespace-nowrap">Current</th>
          <th class="py-1 pe-2 text-right whitespace-nowrap">Profit</th>
          <th class="py-1 pe-2 whitespace-nowrap">Open date</th>
          <th class="py-1 pe-2 text-right"></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(t, index) in trades"
          :key="t.botTradeId"
          class="border-b border-surface-200 dark:border-surface-700/70 cursor-pointer hover:bg-surface-100 dark:hover:bg-surface-800/40"
          :class="isSelectedRow(t) ? 'bg-primary-100 dark:bg-primary-900/30' : ''"
          @click="onRowClicked(t)"
        >
          <td v-if="multiBotView" class="py-1 pe-2 whitespace-nowrap text-xs">
            {{ t.botName
            }}<span
              v-if="t.strategy"
              class="ms-1 text-[10px] text-surface-500 dark:text-surface-400"
              >({{ shortStrategyName(t.strategy) }})</span
            >
          </td>
          <td class="py-1 pe-2 whitespace-nowrap font-mono text-xs">
            {{ t.trade_id }}
            <span v-if="t.trading_mode !== 'spot'" class="text-surface-400">
              {{ t.is_short ? 'S' : 'L' }}
            </span>
          </td>
          <td class="py-1 pe-2 whitespace-nowrap">
            {{ t.pair }}<span v-if="t.open_order_id || t.has_open_orders">*</span>
          </td>
          <td class="py-1 pe-2 text-right font-mono text-xs">{{ formatPrice(t.amount) }}</td>
          <td class="py-1 pe-2 text-right font-mono text-xs whitespace-nowrap">
            {{ formatPriceWithDecimals(t.stake_amount) }}
            <span v-if="t.trading_mode !== 'spot'" class="text-surface-400"
              >({{ t.leverage }}x)</span
            >
          </td>
          <td class="py-1 pe-2 text-right font-mono text-xs">{{ formatPrice(t.open_rate) }}</td>
          <td class="py-1 pe-2 text-right font-mono text-xs">
            {{ formatPrice(t.current_rate ?? null) }}
          </td>
          <td class="py-1 pe-2 text-right"><TradeProfit :trade="t" /></td>
          <td class="py-1 pe-2 whitespace-nowrap text-xs">
            <DateTimeTZ :date="t.open_timestamp" />
          </td>
          <td class="py-1 pe-1 text-right" @click.stop>
            <TradeActionsPopover
              :id="t.trade_id ?? index"
              :trade="t"
              :bot-features="botStore.activeBot.botFeatures"
              :enable-force-entry="botStore.activeBot.botState.force_entry_enable"
              @delete-trade="removeTradeHandler(t)"
              @force-exit="forceExitHandler"
              @force-exit-partial="forceExitPartialHandler"
              @cancel-open-order="cancelOpenOrderHandler"
              @reload-trade="reloadTradeHandler"
              @force-entry="handleForceEntry"
              @force-dca-entry="handleForceDcaEntry"
            />
          </td>
        </tr>
        <tr v-if="trades.length === 0">
          <td :colspan="multiBotView ? 10 : 9" class="py-3 text-center text-surface-400">
            {{ emptyText }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
