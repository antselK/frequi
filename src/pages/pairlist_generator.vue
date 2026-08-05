<script setup lang="ts">
/**
 * Pairlist Generator — the UI for the self-hosted freq-pairlist service that
 * replaced remotepairlist.com after its domain expired on 2026-07-12.
 *
 * Named `pairlist_generator` because `/pairlist` and `/pairlist_config` are
 * upstream freqtrade routes (the bot's own live pairlist and its configurator).
 * Under file-based routing the filename *is* the route, so a collision would
 * shadow them.
 *
 * Data goes through the control-plane proxy (`/api/v1/pairlist/*`) so this page
 * uses the same `vpsApi` composable and `X-Admin-Token` as the DWH and Reports
 * pages — no CORS, no second auth scheme.
 */
import PairlistConfigEditor from '@/components/pairlist/PairlistConfigEditor.vue';
import { vpsApi } from '@/composables/vpsApi';
import type {
  PairlistBlacklistState,
  PairlistBuild,
  PairlistConfig,
  PairlistHealth,
  PairlistMetric,
  PairlistPreview,
  PairlistSpec,
} from '@/types/vps';

definePage({
  meta: {
    allowAnonymous: true,
  },
});

const toast = useToast();

const loading = ref(false);
const error = ref('');
const configs = ref<PairlistConfig[]>([]);
const health = ref<PairlistHealth | null>(null);
const metrics = ref<PairlistMetric[]>([]);
const blacklist = ref<PairlistBlacklistState | null>(null);

const selectedId = ref<string | null>(null);
const builds = ref<PairlistBuild[]>([]);
const preview = ref<PairlistPreview | null>(null);
const previewing = ref(false);
const building = ref(false);
const showBlacklist = ref(false);
const activeTab = ref<'pairs' | 'filters' | 'builds' | 'edit'>('pairs');
const saving = ref(false);
// A blank draft for 'New config'. Kept separate from the list so creating one
// never mutates an existing config.
const draft = ref<PairlistConfig | null>(null);

const selected = computed(
  () => draft.value ?? configs.value.find((c) => c.id === selectedId.value) ?? null,
);

const healthById = computed(() => {
  const map: Record<string, PairlistHealth['configs'][number]> = {};
  for (const entry of health.value?.configs ?? []) map[entry.id] = entry;
  return map;
});

/**
 * The bot-facing URL. Bots reach the service directly over Tailscale rather than
 * through control-plane — one less hop in the trading path, and the proxy exists
 * only for this page.
 */
const serviceBase = 'http://100.112.155.89:8787';
function pairlistUrl(id: string): string {
  return `${serviceBase}/?q=${id}`;
}

function statusColor(status?: string): 'success' | 'warning' | 'error' | 'neutral' {
  if (status === 'ok') return 'success';
  if (status === 'degraded') return 'warning';
  if (status === 'stale' || status === 'no_result') return 'error';
  return 'neutral';
}

function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${(seconds / 3600).toFixed(1)}h ago`;
}

function formatTs(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ') + 'Z';
}

/**
 * A useful error string.
 *
 * `String(err)` yields "AxiosError: Request failed with status code 404" — no URL,
 * no method, no server detail. Chasing one of those through the whole stack is what
 * prompted this: include what actually failed so the next one is self-diagnosing.
 */
function describeError(err: unknown, action: string): string {
  const e = err as {
    response?: { status?: number; data?: { detail?: string } };
    config?: { method?: string; url?: string };
    message?: string;
  };
  const status = e?.response?.status;
  const detail = e?.response?.data?.detail;
  const where = e?.config ? `${(e.config.method ?? '').toUpperCase()} ${e.config.url ?? ''}` : '';
  return [
    `${action} failed`,
    status ? `HTTP ${status}` : null,
    where || null,
    detail ?? e?.message ?? String(err),
  ]
    .filter(Boolean)
    .join(' · ');
}

async function loadAll() {
  loading.value = true;
  error.value = '';
  try {
    const [configList, healthState, metricList] = await Promise.all([
      vpsApi.pairlistConfigs(),
      vpsApi.pairlistHealth(),
      vpsApi.pairlistMetrics(),
    ]);
    configs.value = configList.configs;
    health.value = healthState;
    metrics.value = metricList.metrics;
    if (!selectedId.value && configs.value.length) {
      selectedId.value = configs.value[0].id;
    }
    if (selectedId.value) await loadBuilds(selectedId.value);
  } catch (err) {
    error.value = describeError(err, 'Loading pairlist configs');
  } finally {
    loading.value = false;
  }
}

async function loadBuilds(id: string) {
  try {
    const { builds: rows } = await vpsApi.pairlistBuilds(id, 20);
    builds.value = rows;
  } catch (err) {
    error.value = describeError(err, 'Loading build history');
  }
}

async function loadBlacklist() {
  error.value = '';
  try {
    blacklist.value = await vpsApi.pairlistBlacklist();
    showBlacklist.value = true;
  } catch (err) {
    error.value = describeError(err, 'Loading blacklist');
  }
}

async function runPreview() {
  if (!selected.value) return;
  error.value = '';
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await vpsApi.pairlistPreview(selected.value.spec);
  } catch (err) {
    error.value = describeError(err, 'Preview');
  } finally {
    previewing.value = false;
  }
}

async function triggerBuild() {
  if (!selected.value) return;
  error.value = '';
  building.value = true;
  try {
    await vpsApi.pairlistTriggerBuild(selected.value.id);
    toast.add({
      title: 'Build started',
      description: 'Runs in the background — Hyperliquid takes ~16 minutes.',
      color: 'info',
    });
  } catch (err) {
    error.value = describeError(err, 'Build');
  } finally {
    building.value = false;
  }
}

async function copyUrl(id: string) {
  await navigator.clipboard.writeText(pairlistUrl(id));
  toast.add({ title: 'Copied', description: pairlistUrl(id), color: 'success' });
}

function duplicateConfig() {
  const source = selected.value;
  if (!source) return;
  // A copy WITHOUT `source`, so its selection chain becomes editable. That is the
  // whole point: fleet chains are owned by their file, a duplicate is owned here.
  const spec = { ...source.spec } as PairlistSpec;
  delete (spec as Record<string, unknown>).source;
  draft.value = {
    ...source,
    id: '',
    name: `${source.name} (copy)`,
    created_at: '',
    updated_at: '',
    spec,
  };
  activeTab.value = 'edit';
  preview.value = null;
  toast.add({
    title: 'Duplicated',
    description: 'Give it an id, tune the Selection fields, then Preview or Save.',
    color: 'info',
  });
}

function newConfig() {
  draft.value = {
    id: '',
    name: '',
    enabled: true,
    cadence_min: 15,
    created_at: '',
    updated_at: '',
    spec: {
      exchange: 'bybit',
      market: 'futures',
      stake: 'USDT',
      mode: 'whitelist',
      filters: {},
      sort: null,
      sort2: null,
    },
  };
  activeTab.value = 'edit';
  preview.value = null;
}

async function saveConfig(payload: {
  id: string;
  name: string;
  spec: PairlistSpec;
  cadenceMin: number;
  enabled: boolean;
}) {
  error.value = '';
  saving.value = true;
  try {
    await vpsApi.pairlistSaveConfig(
      payload.id,
      payload.name,
      payload.spec,
      payload.cadenceMin,
      payload.enabled,
    );
    toast.add({
      title: 'Saved',
      description: `${payload.name} — builds on its next slot; use Build now to run immediately.`,
      color: 'success',
    });
    draft.value = null;
    await loadAll();
    selectedId.value = payload.id;
    activeTab.value = 'pairs';
  } catch (err) {
    error.value = describeError(err, 'Saving config');
  } finally {
    saving.value = false;
  }
}

async function previewSpec(spec: PairlistSpec) {
  error.value = '';
  previewing.value = true;
  preview.value = null;
  try {
    preview.value = await vpsApi.pairlistPreview(spec);
    activeTab.value = 'pairs';
  } catch (err) {
    error.value = describeError(err, 'Preview');
  } finally {
    previewing.value = false;
  }
}

function cancelEdit() {
  draft.value = null;
  activeTab.value = 'pairs';
}

watch(selectedId, (id) => {
  draft.value = null;
  preview.value = null;
  activeTab.value = 'pairs';
  if (id) loadBuilds(id);
});

onMounted(loadAll);
</script>

<template>
  <div class="p-4 space-y-4 text-left">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Pairlist Generator</h1>
        <p class="text-sm text-surface-400">
          Self-hosted replacement for remotepairlist.com. Bots fetch their whitelist directly from
          this service over Tailscale.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UBadge
          v-if="health"
          :label="`service: ${health.status}`"
          :color="
            health.status === 'ok' ? 'success' : health.status === 'warning' ? 'warning' : 'error'
          "
          variant="subtle"
        />
        <UButton
          label="New config"
          size="sm"
          color="primary"
          variant="outline"
          icon="i-mdi-plus"
          @click="newConfig"
        />
        <UButton
          label="Blacklist"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-mdi-cancel"
          @click="loadBlacklist"
        />
        <UButton
          label="Refresh"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-mdi-refresh"
          :loading="loading"
          @click="loadAll"
        />
      </div>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="Request failed"
      :description="error"
      close
      @update:open="error = ''"
    />

    <!-- Config cards. Staleness is the headline number: a frozen pairlist is the
         failure that went unnoticed for 15 days when the old service died. -->
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <UCard
        v-for="cfg in configs"
        :key="cfg.id"
        class="cursor-pointer transition"
        :class="cfg.id === selectedId ? 'ring-2 ring-primary-500' : 'hover:bg-surface-800/40'"
        @click="selectedId = cfg.id"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="font-medium truncate">{{ cfg.name }}</div>
            <div class="font-mono text-xs text-surface-400 truncate">{{ cfg.id }}</div>
          </div>
          <UBadge
            :label="healthById[cfg.id]?.status ?? (cfg.enabled ? 'unknown' : 'disabled')"
            :color="statusColor(healthById[cfg.id]?.status)"
            variant="subtle"
          />
        </div>

        <div class="mt-3 flex items-baseline gap-2">
          <span class="text-2xl font-bold">{{ cfg.pair_count ?? 0 }}</span>
          <span class="text-xs text-surface-400">pairs</span>
        </div>

        <div class="mt-1 text-xs text-surface-400">
          built {{ formatAge(healthById[cfg.id]?.age_seconds) }} · every {{ cfg.cadence_min }}m
          <span v-if="cfg.spec.cron_minutes?.length">
            (:{{ cfg.spec.cron_minutes.join(', :') }})
          </span>
        </div>

        <div v-if="healthById[cfg.id]?.note" class="mt-2 text-xs text-amber-400">
          {{ healthById[cfg.id]?.note }}
        </div>

        <div class="mt-3 flex items-center gap-2" @click.stop>
          <code class="flex-1 truncate rounded bg-surface-800/60 px-2 py-1 text-xs">
            {{ pairlistUrl(cfg.id) }}
          </code>
          <UButton
            icon="i-mdi-content-copy"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="copyUrl(cfg.id)"
          />
        </div>
      </UCard>
    </div>

    <!-- Selected config -->
    <UCard v-if="selected">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-3">
            <h2 class="font-semibold">
              {{ selected.name || (draft ? 'New config' : selected.id) }}
            </h2>
            <UBadge :label="selected.spec.exchange" variant="subtle" color="neutral" />
            <UBadge :label="selected.spec.stake" variant="subtle" color="neutral" />
            <UBadge :label="selected.spec.market" variant="subtle" color="neutral" />
          </div>
          <div class="flex items-center gap-2">
            <UButton
              label="Preview"
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-mdi-eye"
              :loading="previewing"
              @click="runPreview"
            />
            <UButton
              label="Build now"
              size="sm"
              color="primary"
              variant="outline"
              icon="i-mdi-play"
              :loading="building"
              @click="triggerBuild"
            />
          </div>
        </div>
      </template>

      <div class="mb-3 flex gap-2">
        <UButton
          v-for="tab in ['pairs', 'filters', 'builds', 'edit'] as const"
          :key="tab"
          :label="
            tab === 'pairs'
              ? 'Pairs'
              : tab === 'filters'
                ? 'Chain & filters'
                : tab === 'builds'
                  ? 'Build history'
                  : 'Configure'
          "
          size="xs"
          :color="activeTab === tab ? 'primary' : 'neutral'"
          :variant="activeTab === tab ? 'solid' : 'ghost'"
          @click="activeTab = tab"
        />
      </div>

      <!-- Pairs -->
      <div v-if="activeTab === 'pairs'">
        <div v-if="previewing" class="flex items-center gap-2 text-sm text-surface-400">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" />
          Running the chain live — Hyperliquid is rate-limited to 1 req/s and can take ~16 minutes.
        </div>

        <div v-else-if="preview">
          <div class="mb-2 text-sm">
            Preview: <span class="font-bold">{{ preview.count }}</span> pairs
            <span class="text-surface-400">(not saved — bots still serve the stored list)</span>
          </div>
          <div v-if="preview.notes.length" class="mb-2 text-xs text-amber-400">
            {{ preview.notes.join('; ') }}
          </div>
          <div class="flex flex-wrap gap-1">
            <UBadge
              v-for="(pair, i) in preview.pairs"
              :key="pair"
              :label="`${i + 1}. ${pair}`"
              variant="subtle"
              color="neutral"
            />
          </div>
          <div class="mt-4 overflow-x-auto">
            <table class="w-full text-sm border-collapse">
              <thead>
                <tr class="border-b border-surface-600 text-left text-surface-300">
                  <th class="py-2 pe-3">Stage</th>
                  <th class="py-2 pe-3 text-right">In</th>
                  <th class="py-2 pe-3 text-right">Out</th>
                  <th class="py-2 pe-3 text-right">Removed</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(stage, i) in preview.stages"
                  :key="i"
                  class="border-b border-surface-700/70 hover:bg-surface-700/30"
                >
                  <td class="py-1.5 pe-3 font-mono text-xs">{{ stage.stage }}</td>
                  <td class="py-1.5 pe-3 text-right">{{ stage.before }}</td>
                  <td class="py-1.5 pe-3 text-right">{{ stage.after }}</td>
                  <td
                    class="py-1.5 pe-3 text-right font-mono"
                    :class="stage.removed > 0 ? 'text-red-400' : 'text-surface-500'"
                  >
                    {{ stage.removed > 0 ? `-${stage.removed}` : '0' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-else class="text-sm text-surface-400">
          Showing the stored result of the last build. Press <strong>Preview</strong> to run the
          chain live without touching what the bots are served.
          <div class="mt-3 text-surface-200">
            Last build produced <strong>{{ selected.pair_count ?? 0 }}</strong> pairs at
            {{ formatTs(selected.generated_at) }}.
          </div>
        </div>
      </div>

      <!-- Chain & filters -->
      <div v-else-if="activeTab === 'filters'" class="space-y-4">
        <div>
          <h3 class="mb-2 text-sm font-semibold">Selection chain</h3>
          <p class="mb-2 text-xs text-surface-400">
            Run verbatim by the service. These are the fleet's own chain files, which is what keeps
            the generated universe identical to what <code>test-pairlist</code> produces.
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-sm border-collapse">
              <thead>
                <tr class="border-b border-surface-600 text-left text-surface-300">
                  <th class="py-2 pe-3">#</th>
                  <th class="py-2 pe-3">Handler</th>
                  <th class="py-2 pe-3">Parameters</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(handler, i) in selected.spec.base_chain ?? []"
                  :key="i"
                  class="border-b border-surface-700/70"
                >
                  <td class="py-1.5 pe-3 text-surface-500">{{ i + 1 }}</td>
                  <td class="py-1.5 pe-3 font-mono text-xs">{{ handler.method }}</td>
                  <td class="py-1.5 pe-3 font-mono text-xs text-surface-400">
                    {{
                      Object.entries(handler)
                        .filter(([k]) => k !== 'method')
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' · ')
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">Extended filters</h3>
          <div
            v-if="!selected.spec.filters || !Object.keys(selected.spec.filters).length"
            class="text-xs text-surface-400"
          >
            None. This config uses the selection chain only — the same universe the fleet generates
            today.
          </div>
          <div v-else class="flex flex-wrap gap-1">
            <UBadge
              v-for="(value, key) in selected.spec.filters"
              :key="key"
              :label="`${key}: ${Array.isArray(value) ? value.join('–') : value}`"
              variant="subtle"
              color="primary"
            />
          </div>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">
            Available metrics
            <span class="font-normal text-surface-400">({{ metrics.length }})</span>
          </h3>
          <div class="flex flex-wrap gap-1">
            <UBadge
              v-for="metric in metrics"
              :key="metric.key"
              :label="`${metric.key} (${metric.timeframe})`"
              :title="metric.description"
              variant="subtle"
              color="neutral"
            />
          </div>
        </div>
      </div>

      <!-- Configure -->
      <PairlistConfigEditor
        v-else-if="activeTab === 'edit'"
        :config="selected"
        :metrics="metrics"
        :class-counts="preview?.class_counts"
        :saving="saving"
        :previewing="previewing"
        @save="saveConfig"
        @preview="previewSpec"
        @duplicate="duplicateConfig"
        @cancel="cancelEdit"
      />

      <!-- Build history -->
      <div v-else-if="activeTab === 'builds'" class="overflow-x-auto">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-surface-600 text-left text-surface-300">
              <th class="py-2 pe-3">Started</th>
              <th class="py-2 pe-3">Status</th>
              <th class="py-2 pe-3 text-right">Pairs</th>
              <th class="py-2 pe-3">Detail</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="build in builds"
              :key="build.id"
              class="border-b border-surface-700/70 hover:bg-surface-700/30"
            >
              <td class="py-1.5 pe-3 font-mono text-xs">{{ formatTs(build.started_at) }}</td>
              <td class="py-1.5 pe-3">
                <UBadge
                  :label="build.status"
                  :color="
                    build.status === 'ok'
                      ? 'success'
                      : build.status === 'running'
                        ? 'neutral'
                        : build.status === 'refused'
                          ? 'warning'
                          : 'error'
                  "
                  variant="subtle"
                />
              </td>
              <td class="py-1.5 pe-3 text-right">{{ build.pair_count ?? '—' }}</td>
              <td class="py-1.5 pe-3 text-xs text-surface-400">
                {{
                  build.error ??
                  (build.stage_counts?.length ? `${build.stage_counts.length} stages` : '')
                }}
              </td>
            </tr>
            <tr v-if="!builds.length">
              <td colspan="4" class="py-3 text-sm text-surface-400">No builds recorded yet.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- Blacklist -->
    <UModal v-model:open="showBlacklist" title="Exclusion set">
      <template #body>
        <div v-if="blacklist" class="space-y-3 text-sm">
          <p class="text-surface-300">{{ blacklist.summary }}</p>
          <div class="flex flex-wrap gap-3">
            <div
              v-for="(count, key) in blacklist.counts"
              :key="key"
              class="rounded border border-surface-600 px-3 py-2 min-w-24 text-center"
            >
              <div class="text-lg font-bold">{{ count }}</div>
              <div class="text-xs text-surface-400">{{ key }}</div>
            </div>
          </div>

          <div>
            <h4 class="mb-1 font-semibold">Account-restricted (auto-detected)</h4>
            <p class="mb-1 text-xs text-surface-400">
              Symbols the live account cannot trade. Detected from bot rejections; entries age out
              after 30 days as a retest, doubling on each failure.
            </p>
            <div class="flex flex-wrap gap-1">
              <UBadge
                v-for="sym in blacklist.auto_restricted"
                :key="sym"
                :label="sym"
                variant="subtle"
                color="warning"
              />
              <span v-if="!blacklist.auto_restricted.length" class="text-xs text-surface-400">
                none
              </span>
            </div>
          </div>

          <div>
            <h4 class="mb-1 font-semibold">Delistings (Binance + Bybit, 90d)</h4>
            <div class="flex flex-wrap gap-1">
              <UBadge
                v-for="sym in blacklist.delistings"
                :key="sym"
                :label="sym"
                variant="subtle"
                color="error"
              />
            </div>
          </div>

          <div>
            <h4 class="mb-1 font-semibold">Static (hand-maintained)</h4>
            <div class="flex flex-wrap gap-1">
              <UBadge
                v-for="sym in blacklist.static"
                :key="sym"
                :label="sym"
                variant="subtle"
                color="neutral"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
