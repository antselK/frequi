<script setup lang="ts">
/**
 * The hand-maintained part of the exclusion set: static blacklist, protected coins and
 * detector exemptions. Stored in the freq-pairlist service since 2026-10-21 — they were
 * the git-tracked `pairlist_overrides.json` before — and shared by every bot that uses
 * the service, the friend tenant's included. Each change needs a reason, and the change
 * log below replaces the file's git history.
 *
 * `text-left` on the root: `App.vue` centres all text globally (see PairlistConfigEditor).
 */
import { vpsApi } from '@/composables/vpsApi';
import type { PairlistOverride, PairlistOverrideChange, PairlistOverrideKind } from '@/types/vps';

const emit = defineEmits<{ changed: [] }>();

const toast = useToast();

interface Section {
  kind: PairlistOverrideKind;
  title: string;
  help: string;
  placeholder: string;
  /** What removing an entry means, shown before it is confirmed. */
  removeEffect: string;
  color: 'neutral' | 'success' | 'info';
}

const SECTIONS: Section[] = [
  {
    kind: 'static_blacklist',
    title: 'Static blacklist',
    help:
      'Coins excluded from every pairlist the service builds (a config can switch the "static" ' +
      "source off). Applies at each config's next build, within 15 minutes. The last entry " +
      'cannot be removed — an empty list stops all builds.',
    placeholder: 'Coin, e.g. BTC',
    removeEffect: 'It can return to every pairlist at the next build.',
    color: 'neutral',
  },
  {
    kind: 'static_whitelist',
    title: 'Protected coins',
    help:
      'Coins the static blacklist, CoinGecko and account-restriction sources never remove. ' +
      'Delistings can still remove them.',
    placeholder: 'Coin, e.g. AR',
    removeEffect: 'Every exclusion source applies to it again.',
    color: 'success',
  },
  {
    kind: 'always_include_pairs',
    title: 'Detector exemptions',
    help:
      "Pairs whose coin the account-restriction detector never blacklists. Despite the key's " +
      'name (always_include_pairs) this does not add the pair to any pairlist.',
    placeholder: 'Pair, e.g. AR/USDT:USDT',
    removeEffect: 'The detector may blacklist its coin again.',
    color: 'info',
  },
];

const KIND_TITLE = Object.fromEntries(SECTIONS.map((s) => [s.kind, s.title])) as Record<
  PairlistOverrideKind,
  string
>;

const entries = ref<PairlistOverride[]>([]);
const history = ref<PairlistOverrideChange[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const showHistory = ref(false);
const drafts = ref<Record<PairlistOverrideKind, { value: string; reason: string }>>({
  static_blacklist: { value: '', reason: '' },
  static_whitelist: { value: '', reason: '' },
  always_include_pairs: { value: '', reason: '' },
});
const removing = ref<{ kind: PairlistOverrideKind; value: string; reason: string } | null>(null);

function entriesOf(kind: PairlistOverrideKind): PairlistOverride[] {
  return entries.value.filter((e) => e.kind === kind);
}

function formatUtc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function entryTitle(entry: PairlistOverride): string {
  const by = entry.added_by ? ` by ${entry.added_by}` : '';
  return `${entry.reason} — added ${formatUtc(entry.added_at)}${by}`;
}

function errorText(err: unknown, action: string): string {
  const e = err as { response?: { status?: number; data?: { detail?: string } }; message?: string };
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail ?? e?.message ?? String(err);
  return `${action} failed${status ? ` · HTTP ${status}` : ''} · ${detail}`;
}

async function load() {
  loading.value = true;
  try {
    const data = await vpsApi.pairlistOverrides();
    entries.value = data.entries;
    history.value = data.history;
  } catch (err) {
    error.value = errorText(err, 'Loading overrides');
  } finally {
    loading.value = false;
  }
}

async function add(kind: PairlistOverrideKind) {
  const draft = drafts.value[kind];
  const value = draft.value.trim();
  const reason = draft.reason.trim();
  if (!value || !reason) return;
  error.value = '';
  busy.value = true;
  try {
    await vpsApi.pairlistAddOverride(kind, value, reason);
    drafts.value[kind] = { value: '', reason: '' };
    toast.add({
      title: `${value.toUpperCase()} added to ${KIND_TITLE[kind]}`,
      description: "Applies at each config's next build.",
      color: 'success',
    });
    await load();
    emit('changed');
  } catch (err) {
    error.value = errorText(err, `Adding ${value}`);
  } finally {
    busy.value = false;
  }
}

function startRemove(entry: PairlistOverride) {
  removing.value = { kind: entry.kind, value: entry.value, reason: '' };
}

async function confirmRemove() {
  const target = removing.value;
  if (!target || !target.reason.trim()) return;
  error.value = '';
  busy.value = true;
  try {
    await vpsApi.pairlistRemoveOverride(target.kind, target.value, target.reason.trim());
    removing.value = null;
    toast.add({
      title: `${target.value} removed from ${KIND_TITLE[target.kind]}`,
      description: "Applies at each config's next build.",
      color: 'success',
    });
    await load();
    emit('changed');
  } catch (err) {
    error.value = errorText(err, `Removing ${target.value}`);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4 text-left">
    <UAlert v-if="error" color="error" variant="subtle" :description="error" />
    <div v-if="loading && !entries.length" class="text-xs text-surface-400">
      <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Loading overrides…
    </div>

    <div v-for="section in SECTIONS" :key="section.kind">
      <h4 class="mb-1 font-semibold">
        {{ section.title }}
        <span class="text-xs font-normal text-surface-400">
          ({{ entriesOf(section.kind).length }})
        </span>
      </h4>
      <p class="mb-2 text-xs text-surface-400">{{ section.help }}</p>

      <div class="flex flex-wrap gap-1">
        <UBadge
          v-for="entry in entriesOf(section.kind)"
          :key="entry.value"
          variant="subtle"
          :color="section.color"
          :title="entryTitle(entry)"
        >
          {{ entry.value }}
          <UButton
            icon="i-mdi-close"
            size="xs"
            color="neutral"
            variant="link"
            class="-me-1 p-0"
            :aria-label="`Remove ${entry.value}`"
            :disabled="busy"
            @click="startRemove(entry)"
          />
        </UBadge>
        <span v-if="!entriesOf(section.kind).length" class="text-xs text-surface-400">none</span>
      </div>

      <div
        v-if="removing && removing.kind === section.kind"
        class="mt-2 flex flex-wrap items-center gap-2 rounded border border-red-500/50 p-2"
      >
        <span class="text-xs">
          Remove <b>{{ removing.value }}</b
          >? {{ section.removeEffect }}
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
        <UInput
          v-model="drafts[section.kind].value"
          size="xs"
          class="w-44"
          :placeholder="section.placeholder"
        />
        <UInput
          v-model="drafts[section.kind].reason"
          size="xs"
          class="w-64"
          placeholder="Reason (required)"
          @keyup.enter="add(section.kind)"
        />
        <UButton
          label="Add"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-mdi-plus"
          :loading="busy"
          :disabled="!drafts[section.kind].value.trim() || !drafts[section.kind].reason.trim()"
          @click="add(section.kind)"
        />
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
      <div v-if="showHistory" class="mt-1 max-h-64 overflow-auto">
        <table class="w-full border-collapse text-xs">
          <thead>
            <tr class="border-b border-surface-600 text-left text-surface-300">
              <th class="py-1 pe-3 whitespace-nowrap">When</th>
              <th class="py-1 pe-3">Change</th>
              <th class="py-1 pe-3">List</th>
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
                {{ row.action === 'add' ? '+' : '−' }} {{ row.value }}
              </td>
              <td class="py-1 pe-3 whitespace-nowrap">{{ KIND_TITLE[row.kind] ?? row.kind }}</td>
              <td class="py-1 pe-3">{{ row.reason }}</td>
              <td class="py-1 pe-3 whitespace-nowrap text-surface-400">{{ row.actor ?? '—' }}</td>
            </tr>
            <tr v-if="!history.length">
              <td colspan="5" class="py-2 text-surface-400">No changes recorded.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
