<script setup lang="ts">
/**
 * One config's whitelist: coin symbols it always serves, first in its list and on top
 * of its limit (added 2026-10-29). Unlike the exclusion set's overrides, these belong
 * to this config alone. Each change needs a reason, is logged, and makes the service
 * rebuild this config at once.
 *
 * `text-left` on the root: `App.vue` centres all text globally (see PairlistConfigEditor).
 */
import { vpsApi } from '@/composables/vpsApi';
import type { PairlistResult, PairlistWhitelistChange, PairlistWhitelistEntry } from '@/types/vps';

const props = defineProps<{
  configId: string;
  exchange?: string;
  stake?: string;
  enabled: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const toast = useToast();

const entries = ref<PairlistWhitelistEntry[]>([]);
const history = ref<PairlistWhitelistChange[]>([]);
const result = ref<PairlistResult | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const showHistory = ref(false);
const newEntry = ref({ symbol: '', reason: '' });
const removing = ref<{ symbol: string; reason: string } | null>(null);

/** The build notes about whitelisted coins the last build could not serve. */
const skipped = computed(() =>
  (result.value?.note ?? '')
    .split('; ')
    .filter((n) => n.startsWith('whitelist: skipped '))
    .map((n) => n.slice('whitelist: skipped '.length)),
);

function formatUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function entryTitle(entry: PairlistWhitelistEntry): string {
  const by = entry.added_by ? ` by ${entry.added_by}` : '';
  return `${entry.reason} — added ${formatUtc(entry.added_at)}${by}`;
}

function errorText(err: unknown, action: string): string {
  const e = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail ?? e?.message ?? String(err);
  return `${action} failed${status ? ` · HTTP ${status}` : ''} · ${detail}`;
}

function appliedText(rebuild: boolean): string {
  return rebuild
    ? 'Rebuilding this pairlist now — press Refresh in a minute or two to see what it serves.'
    : 'This config is disabled, so it applies once the config is enabled.';
}

async function load() {
  loading.value = true;
  try {
    const [whitelist, config] = await Promise.all([
      vpsApi.pairlistWhitelist(props.configId),
      vpsApi.pairlistConfig(props.configId),
    ]);
    entries.value = whitelist.entries;
    history.value = whitelist.history;
    result.value = config.result ?? null;
  } catch (err) {
    error.value = errorText(err, 'Loading the whitelist');
  } finally {
    loading.value = false;
  }
}

async function add() {
  const symbol = newEntry.value.symbol.trim();
  const reason = newEntry.value.reason.trim();
  if (!symbol || !reason) return;
  error.value = '';
  busy.value = true;
  try {
    const out = await vpsApi.pairlistAddWhitelist(props.configId, symbol, reason);
    newEntry.value = { symbol: '', reason: '' };
    toast.add({
      title: `${out.symbol} whitelisted on ${props.configId}`,
      description: appliedText(out.rebuild),
      color: 'success',
    });
    await load();
    emit('changed');
  } catch (err) {
    error.value = errorText(err, `Adding ${symbol}`);
  } finally {
    busy.value = false;
  }
}

async function confirmRemove() {
  const target = removing.value;
  if (!target || !target.reason.trim()) return;
  error.value = '';
  busy.value = true;
  try {
    const out = await vpsApi.pairlistRemoveWhitelist(
      props.configId,
      target.symbol,
      target.reason.trim(),
    );
    removing.value = null;
    toast.add({
      title: `${out.symbol} removed from the whitelist of ${props.configId}`,
      description: appliedText(out.rebuild),
      color: 'success',
    });
    await load();
    emit('changed');
  } catch (err) {
    error.value = errorText(err, `Removing ${target.symbol}`);
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.configId,
  () => {
    removing.value = null;
    load();
  },
);
onMounted(load);
</script>

<template>
  <div class="space-y-4 text-left">
    <UAlert v-if="error" color="error" variant="subtle" :description="error" />

    <div>
      <div class="mb-1 flex items-center justify-between gap-2">
        <h4 class="font-semibold">
          Whitelist
          <span class="text-xs font-normal text-surface-400">({{ entries.length }})</span>
        </h4>
        <UButton
          label="Refresh"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-mdi-refresh"
          :loading="loading"
          @click="load"
        />
      </div>
      <p class="mb-2 text-xs text-surface-400">
        Coins this pairlist always serves, first in its list and on top of its limit, so the bots'
        45-pair cut never drops them. Enter a coin symbol: it is resolved on
        {{ exchange ?? 'the venue' }} to its {{ stake ?? '' }} pair, including bundled listings
        (PEPE → 1000PEPE on Bybit, kPEPE on Hyperliquid). It overrides every filter, cooling-off,
        the static blacklist and the CoinGecko lists. Only a coin being delisted, or one this
        account cannot trade, is skipped. Applies to this config only; each change rebuilds it.
      </p>

      <div class="flex flex-wrap gap-1">
        <UBadge
          v-for="entry in entries"
          :key="entry.symbol"
          variant="subtle"
          color="success"
          :title="entryTitle(entry)"
        >
          {{ entry.symbol }}
          <UButton
            icon="i-mdi-close"
            size="xs"
            color="neutral"
            variant="link"
            class="-me-1 p-0"
            :aria-label="`Remove ${entry.symbol}`"
            :disabled="busy"
            @click="removing = { symbol: entry.symbol, reason: '' }"
          />
        </UBadge>
        <span v-if="!entries.length && !loading" class="text-xs text-surface-400">none</span>
      </div>

      <div
        v-if="removing"
        class="mt-2 flex flex-wrap items-center gap-2 rounded border border-red-500/50 p-2"
      >
        <span class="text-xs">
          Remove <b>{{ removing.symbol }}</b
          >? It stays in the list only if the selection chain picks it.
        </span>
        <UInput
          v-model="removing.reason"
          size="xs"
          class="w-64"
          placeholder="Reason (required)"
          @keyup.enter="confirmRemove"
        />
        <UButton
          label="Remove"
          size="xs"
          color="error"
          :loading="busy"
          :disabled="!removing.reason.trim()"
          @click="confirmRemove"
        />
        <UButton
          label="Cancel"
          size="xs"
          color="neutral"
          variant="ghost"
          @click="removing = null"
        />
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <UInput v-model="newEntry.symbol" size="xs" class="w-44" placeholder="Coin, e.g. SOL" />
        <UInput
          v-model="newEntry.reason"
          size="xs"
          class="w-64"
          placeholder="Reason (required)"
          @keyup.enter="add"
        />
        <UButton
          label="Add"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-mdi-plus"
          :loading="busy"
          :disabled="!newEntry.symbol.trim() || !newEntry.reason.trim()"
          @click="add"
        />
      </div>
      <p v-if="!enabled" class="mt-2 text-xs text-amber-400">
        This config is disabled: it serves nothing, so the whitelist applies once it is enabled.
      </p>
    </div>

    <div v-if="result" class="space-y-1 text-xs">
      <div>
        <span class="text-surface-400"
          >Served by the last build ({{ formatUtc(result.generated_at) }}):</span
        >
        <span v-if="result.whitelisted.length" class="font-mono">
          {{ result.whitelisted.join(', ') }}
        </span>
        <span v-else class="text-surface-400">none</span>
      </div>
      <div v-for="line in skipped" :key="line" class="flex gap-2 text-amber-400">
        <UIcon name="i-mdi-alert" class="mt-0.5 shrink-0" />
        <span>Skipped {{ line }}</span>
      </div>
    </div>

    <div>
      <UButton
        :label="showHistory ? 'Hide change log' : `Change log (${history.length})`"
        size="xs"
        color="neutral"
        variant="link"
        :icon="showHistory ? 'i-mdi-chevron-up' : 'i-mdi-chevron-down'"
        @click="showHistory = !showHistory"
      />
      <div v-if="showHistory" class="mt-1 max-h-[28rem] overflow-auto">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="border-b border-surface-600 text-left text-surface-300">
              <th class="py-1 pe-3 whitespace-nowrap">When</th>
              <th class="py-1 pe-3">Change</th>
              <th class="py-1 pe-3">Reason</th>
              <th class="py-1 pe-3">By</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in history" :key="row.id" class="border-b border-surface-700/70">
              <td class="py-1 pe-3 whitespace-nowrap font-mono">{{ formatUtc(row.at) }}</td>
              <td
                class="py-1 pe-3 whitespace-nowrap font-mono"
                :class="row.action === 'add' ? 'text-green-400' : 'text-red-400'"
              >
                {{ row.action === 'add' ? '+' : '−' }} {{ row.symbol }}
              </td>
              <td class="py-1 pe-3">{{ row.reason }}</td>
              <td class="py-1 pe-3 whitespace-nowrap text-surface-400">{{ row.actor ?? '—' }}</td>
            </tr>
            <tr v-if="!history.length">
              <td colspan="4" class="py-2 text-surface-400">No changes recorded.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
