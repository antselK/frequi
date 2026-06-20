<script setup lang="ts">
import type { ForceEnterPayload, Trade } from '@/types';
import { OrderSides } from '@/types';

// Default DCA multipliers — mirror Printer.adjust_trade_position
// (dca_stake_amount for the first DCA, dca_subsequent_multiplier afterwards).
// These are just the pre-filled starting values; the field below is editable.
const FIRST_DCA_MULTIPLIER = 1.27;
const SUBSEQUENT_DCA_MULTIPLIER = 1.1;

export interface ForceDcaFormProps {
  trade: Trade;
  stakeCurrencyDecimals: number;
}

const props = defineProps<ForceDcaFormProps>();
const emit = defineEmits<{
  close: [value: boolean];
}>();

const botStore = useBotStore();

const leverage = computed(() => props.trade.leverage || 1);

// Filled entry orders, oldest first.
const filledEntries = computed(() =>
  (props.trade.orders ?? [])
    .filter((o) => o.ft_is_entry && (o.filled ?? 0) > 0)
    .sort(
      (a, b) =>
        (a.order_filled_timestamp ?? a.order_timestamp ?? 0) -
        (b.order_filled_timestamp ?? b.order_timestamp ?? 0),
    ),
);

const entryCount = computed(
  () => props.trade.nr_of_successful_entries ?? filledEntries.value.length,
);
// Next DCA level number === current successful entry count (mirrors threshold_index + 1).
const nextLevel = computed(() => entryCount.value);
const dcasDone = computed(() => Math.max(entryCount.value - 1, 0));
const isFirstDca = computed(() => nextLevel.value <= 1);

// Strategy multiplies the first entry's stake on the first DCA, else the last entry's stake.
const baseEntry = computed(() =>
  isFirstDca.value ? filledEntries.value[0] : filledEntries.value.at(-1),
);
const baseStake = computed(() => (baseEntry.value ? baseEntry.value.cost / leverage.value : 0));

const multiplier = ref(isFirstDca.value ? FIRST_DCA_MULTIPLIER : SUBSEQUENT_DCA_MULTIPLIER);
const ordertype = ref('');

const hasEntries = computed(() => filledEntries.value.length > 0);
const stakeAmount = computed(() =>
  Number((baseStake.value * (multiplier.value || 0)).toFixed(props.stakeCurrencyDecimals)),
);
const entryTag = computed(
  () => `dca_${nextLevel.value} with multiplier: ${(multiplier.value || 0).toFixed(2)} (force)`,
);
const directionLabel = computed(() => (props.trade.is_short ? 'SHORT' : 'LONG'));

async function handleDca() {
  if (!hasEntries.value || stakeAmount.value <= 0) {
    return;
  }
  const payload: ForceEnterPayload = {
    pair: props.trade.pair,
    stakeamount: stakeAmount.value,
  };
  if (ordertype.value) {
    payload.ordertype = ordertype.value;
  }
  if (botStore.activeBot.botFeatures.forceEnterShort && botStore.activeBot.shortAllowed) {
    payload.side = props.trade.is_short ? OrderSides.short : OrderSides.long;
  }
  if (botStore.activeBot.botFeatures.forceEntryTag) {
    payload.entry_tag = entryTag.value;
  }
  await nextTick();
  botStore.activeBot.forceentry(payload);
  emit('close', true);
}

const orderTypeOptions = [
  { value: 'market', text: 'Market' },
  { value: 'limit', text: 'Limit' },
];

function resetForm() {
  ordertype.value =
    botStore.activeBot.botState?.order_types?.forcebuy ||
    botStore.activeBot.botState?.order_types?.force_entry ||
    botStore.activeBot.botState?.order_types?.buy ||
    botStore.activeBot.botState?.order_types?.entry ||
    'market';
}
resetForm();
</script>

<template>
  <UModal
    :title="`Force DCA increase for ${trade.pair}`"
    description="Add the next DCA entry the way the strategy would — size and direction auto-computed"
  >
    <template #body>
      <form class="space-y-4" @submit.prevent="handleDca">
        <!-- Current-state summary -->
        <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt class="text-surface-400">Trade</dt>
          <dd class="text-end font-mono">#{{ trade.trade_id }} {{ trade.pair }}</dd>

          <dt class="text-surface-400">Direction</dt>
          <dd
            class="text-end font-semibold"
            :class="trade.is_short ? 'text-red-400' : 'text-green-400'"
          >
            {{ directionLabel }}
          </dd>

          <dt class="text-surface-400">DCAs done</dt>
          <dd class="text-end font-mono">{{ dcasDone }} ({{ entryCount }} total entries)</dd>

          <dt class="text-surface-400">Current total stake</dt>
          <dd class="text-end font-mono">
            {{
              formatPriceCurrency(
                trade.stake_amount,
                botStore.activeBot.stakeCurrency,
                stakeCurrencyDecimals,
              )
            }}
          </dd>

          <dt class="text-surface-400">Open / current rate</dt>
          <dd class="text-end font-mono">
            {{ trade.open_rate }}<span v-if="trade.current_rate"> / {{ trade.current_rate }}</span>
          </dd>

          <dt class="text-surface-400">Open profit</dt>
          <dd
            class="text-end font-mono"
            :class="(trade.profit_ratio ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'"
          >
            {{ trade.profit_pct !== null ? trade.profit_pct.toFixed(2) + '%' : '—' }}
          </dd>

          <dt class="text-surface-400">
            Base stake ({{ isFirstDca ? 'initial entry' : 'last entry' }})
          </dt>
          <dd class="text-end font-mono">
            {{
              formatPriceCurrency(
                baseStake,
                botStore.activeBot.stakeCurrency,
                stakeCurrencyDecimals,
              )
            }}
          </dd>
        </dl>

        <UAlert
          v-if="!hasEntries"
          color="warning"
          variant="subtle"
          title="No filled entry orders"
          description="This trade has no filled entry order to size the DCA from."
        />

        <template v-else>
          <UFormField
            :label="`Multiplier (× base stake) — default ${isFirstDca ? FIRST_DCA_MULTIPLIER : SUBSEQUENT_DCA_MULTIPLIER}`"
          >
            <UInputNumber
              v-model="multiplier"
              :min="0.01"
              :step="0.01"
              :format-options="{ maximumFractionDigits: 2 }"
              class="w-full"
            />
          </UFormField>

          <UFormField label="OrderType">
            <USegmentedControl
              v-model="ordertype"
              :items="orderTypeOptions"
              label-key="text"
              value-key="value"
              size="sm"
              class="w-full"
            />
          </UFormField>

          <!-- Resulting order preview -->
          <div class="rounded border border-surface-600 px-3 py-2 text-sm space-y-1">
            <div class="flex justify-between">
              <span class="text-surface-400">Adds stake</span>
              <span class="font-mono font-semibold">
                {{
                  formatPriceCurrency(
                    stakeAmount,
                    botStore.activeBot.stakeCurrency,
                    stakeCurrencyDecimals,
                  )
                }}
              </span>
            </div>
            <div class="flex justify-between">
              <span class="text-surface-400">Entry tag</span>
              <span class="font-mono text-xs">{{ entryTag }}</span>
            </div>
          </div>
        </template>
      </form>
    </template>
    <template #footer>
      <div class="ms-auto flex justify-end gap-2">
        <UButton color="neutral" icon="mdi:close" @click="$emit('close', false)">Cancel</UButton>
        <UButton icon="mdi:plus-box-multiple" :disabled="!hasEntries" @click="handleDca">
          Confirm DCA increase
        </UButton>
      </div>
    </template>
  </UModal>
</template>
