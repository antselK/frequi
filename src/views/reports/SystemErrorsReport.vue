<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useReportsContext } from '@/composables/useReportsContext';
import { vpsApi } from '@/composables/vpsApi';
import { todayStr, dateFromToDays } from '@/utils/reportDates';
import { formatDate } from '@/utils/reportParsers';
import { logsChartLayout } from '@/utils/reportCharts';
import { timestampShort } from '@/utils/formatters/timeformat';
import type { DwhLogCauseSummary } from '@/types/vps';

const { reportsError, showChartTooltip, hideChartTooltip } = useReportsContext();

interface TimelinePoint {
  ts: string;
  at: string;
  count: number;
}

const systemErrorTimelinePoints = ref<TimelinePoint[]>([]);
const systemSpikeSummary = ref<DwhLogCauseSummary | null>(null);
const systemDateFrom = ref(todayStr());
const systemDateTo = ref(todayStr());
const systemSpikeFromLocal = ref('');
const systemSpikeToLocal = ref('');
const systemSpikeLevels = ref('ERROR,WARNING');
const systemSpikeLimit = ref(20);

const loadingSystemTimeline = ref(false);
const loadingSystemSpikeSummary = ref(false);

const systemLoaded = ref(false);
const systemSpikeLoaded = ref(false);

const maxSystemErrorCount = computed(() => {
  return Math.max(...systemErrorTimelinePoints.value.map((point) => point.count), 1);
});

const systemChartPolyline = computed(() => {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return '';
  }
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(points.length - 1, 1);
  const maxY = Math.max(maxSystemErrorCount.value, 1);

  return points
    .map((point, idx) => {
      const x = leftPad + (idx / denominator) * plotWidth;
      const y = topPad + (1 - point.count / maxY) * plotHeight;
      return `${x},${y}`;
    })
    .join(' ');
});

const systemChartAreaPolyline = computed(() => {
  const line = systemChartPolyline.value;
  if (!line) {
    return '';
  }
  const first = line.split(' ')[0];
  const last = line.split(' ').slice(-1)[0];
  if (!first || !last) {
    return '';
  }
  return `${first} ${line} ${last.split(',')[0]},230 ${first.split(',')[0]},230`;
});

const systemChartCoordinates = computed(() => {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return [] as { x: number; y: number; at: string; count: number }[];
  }
  const { width, height, leftPad, rightPad, topPad, bottomPad } = logsChartLayout;
  const plotWidth = width - leftPad - rightPad;
  const plotHeight = height - topPad - bottomPad;
  const denominator = Math.max(points.length - 1, 1);
  const maxY = Math.max(maxSystemErrorCount.value, 1);

  return points.map((point, idx) => {
    const x = leftPad + (idx / denominator) * plotWidth;
    const y = topPad + (1 - point.count / maxY) * plotHeight;
    return { x, y, at: point.at, count: point.count };
  });
});

const systemChartYTicks = computed(() => {
  const ticks = 5;
  const maxY = Math.max(maxSystemErrorCount.value, 1);
  const { topPad, height, bottomPad } = logsChartLayout;
  const plotHeight = height - topPad - bottomPad;
  return Array.from({ length: ticks + 1 }, (_, i) => {
    const ratio = i / ticks;
    const value = Math.round((1 - ratio) * maxY);
    const y = topPad + ratio * plotHeight;
    return { y, value };
  });
});

const systemChartXTicks = computed(() => {
  const coords = systemChartCoordinates.value;
  if (!coords.length) {
    return [] as { x: number; label: string }[];
  }
  const indexes = new Set<number>([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map((index) => {
      const point = coords[index];
      const date = new Date(systemErrorTimelinePoints.value[index]?.ts ?? '');
      const label = Number.isNaN(date.getTime()) ? (point?.at ?? '') : timestampShort(date);
      return { x: point?.x ?? 0, label };
    });
});

const systemChartDateRangeLabel = computed(() => {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return 'Date / Time: n/a';
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return 'Date / Time: n/a';
  }
  return `Date / Time: ${first.at} → ${last.at}`;
});

const totalSystemErrorCount = computed(() => {
  return systemErrorTimelinePoints.value.reduce((sum, point) => sum + point.count, 0);
});

const systemSpikeTopOccurrences = computed(() => {
  return (systemSpikeSummary.value?.buckets ?? []).reduce((sum, item) => sum + item.occurrences, 0);
});

function normalizeIntInput(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.floor(parsed);
  if (normalized < min || normalized > max) {
    return fallback;
  }
  return normalized;
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function buildSpikeWindowFromPeak() {
  const points = systemErrorTimelinePoints.value;
  if (!points.length) {
    return;
  }

  let peak = points[0];
  for (const point of points) {
    if (point.count > (peak?.count ?? 0)) {
      peak = point;
    }
  }

  if (!peak) {
    return;
  }

  const peakTs = new Date(peak.ts);
  if (Number.isNaN(peakTs.getTime())) {
    return;
  }
  const from = new Date(peakTs.getTime() - 60 * 60 * 1000);
  const to = new Date(peakTs.getTime() + 60 * 60 * 1000);
  systemSpikeFromLocal.value = toLocalDateTimeInput(from.toISOString());
  systemSpikeToLocal.value = toLocalDateTimeInput(to.toISOString());
}

async function loadSystemSpikeSummary() {
  loadingSystemSpikeSummary.value = true;
  reportsError.value = '';
  try {
    const fromDate = new Date(systemSpikeFromLocal.value);
    const toDate = new Date(systemSpikeToLocal.value);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new Error('Please select a valid From and To datetime for spike analysis.');
    }
    if (fromDate >= toDate) {
      throw new Error('Spike analysis window must have From earlier than To.');
    }

    systemSpikeLimit.value = normalizeIntInput(systemSpikeLimit.value, 20, 1, 200);
    systemSpikeSummary.value = await vpsApi.dwhLogCauseSummary({
      from_ts: fromDate.toISOString(),
      to_ts: toDate.toISOString(),
      levels: systemSpikeLevels.value.trim() || undefined,
      limit: systemSpikeLimit.value,
    });
    systemSpikeLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    systemSpikeSummary.value = null;
  } finally {
    loadingSystemSpikeSummary.value = false;
  }
}

async function loadSystemErrorsTimeline() {
  loadingSystemTimeline.value = true;
  reportsError.value = '';
  try {
    if (!systemDateFrom.value) systemDateFrom.value = todayStr();
    if (!systemDateTo.value) systemDateTo.value = todayStr();
    const systemDaysComputed = dateFromToDays(systemDateFrom.value);
    const anomalies = await vpsApi.dwhAnomalies(systemDaysComputed, 30);
    const targetAnomalies = anomalies
      .filter((item) => ['error', 'warning'].includes(item.level.toLowerCase()))
      .slice(0, 8);

    if (!targetAnomalies.length) {
      systemErrorTimelinePoints.value = [];
      systemLoaded.value = true;
      return;
    }

    const trends = await Promise.all(
      targetAnomalies.map((item) =>
        vpsApi.dwhAnomalyTrend(item.signature_hash, systemDaysComputed),
      ),
    );

    const bucketMap = new Map<string, number>();
    for (const trend of trends) {
      for (const point of trend) {
        bucketMap.set(point.bucket_ts, (bucketMap.get(point.bucket_ts) ?? 0) + point.occurrences);
      }
    }

    // Trends are anchored at now over the computed day-span; honor the To-date by
    // dropping buckets after it (exclusive next-day UTC midnight).
    const systemToMs = new Date(`${systemDateTo.value}T00:00:00Z`).getTime() + 24 * 3600 * 1000;
    systemErrorTimelinePoints.value = Array.from(bucketMap.entries())
      .map(([at, count]) => ({ ts: at, at: formatDate(at), count }))
      .filter((p) => new Date(p.ts).getTime() < systemToMs)
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    if (!systemSpikeFromLocal.value || !systemSpikeToLocal.value) {
      buildSpikeWindowFromPeak();
    }

    if (!systemSpikeLoaded.value && systemSpikeFromLocal.value && systemSpikeToLocal.value) {
      await loadSystemSpikeSummary();
    }

    systemLoaded.value = true;
  } catch (error) {
    reportsError.value = String(error);
    systemErrorTimelinePoints.value = [];
  } finally {
    loadingSystemTimeline.value = false;
  }
}

onMounted(() => {
  if (!systemLoaded.value) {
    void loadSystemErrorsTimeline();
  }
});
</script>

<template>
  <div class="border border-surface-400 rounded-sm p-4 space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h5 class="font-semibold">System Errors Timeline (DWH)</h5>
      <div class="flex items-center gap-2">
        <UInput v-model="systemDateFrom" type="date" size="sm" class="w-36" />
        <UInput v-model="systemDateTo" type="date" size="sm" class="w-36" />
        <UButton
          label="Refresh"
          size="sm"
          color="neutral"
          variant="outline"
          :loading="loadingSystemTimeline"
          @click="loadSystemErrorsTimeline"
        />
      </div>
    </div>
    <p class="text-sm text-surface-400">
      Total events in selected window: {{ totalSystemErrorCount }}
    </p>
    <div v-if="!systemErrorTimelinePoints.length" class="text-sm text-surface-400">
      {{ loadingSystemTimeline ? 'Loading timeline...' : 'No error timeline data available.' }}
    </div>
    <div v-else class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-surface-400">
        <div class="flex items-center gap-2">
          <span class="inline-block w-7 h-0.5 bg-red-500" />
          <span>System errors (Count)</span>
        </div>
        <span>{{ systemChartDateRangeLabel }}</span>
      </div>

      <div class="rounded border border-surface-700 bg-surface-900/40 p-2">
        <svg viewBox="0 0 920 260" class="w-full h-72">
          <defs>
            <linearGradient id="systemErrorsAreaGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#ef4444" stop-opacity="0.35" />
              <stop offset="100%" stop-color="#ef4444" stop-opacity="0.03" />
            </linearGradient>
          </defs>
          <g>
            <line
              v-for="(tick, idx) in systemChartYTicks"
              :key="`sys-y-grid-${idx}`"
              x1="40"
              :y1="tick.y"
              x2="900"
              :y2="tick.y"
              stroke="#334155"
              stroke-width="0.5"
              stroke-dasharray="3 3"
            />
            <text
              v-for="(tick, idx) in systemChartYTicks"
              :key="`sys-y-label-${idx}`"
              x="36"
              :y="tick.y + 3"
              text-anchor="end"
              fill="#94a3b8"
              font-size="10"
            >
              {{ tick.value }}
            </text>
          </g>
          <line x1="40" y1="230" x2="900" y2="230" stroke="#475569" stroke-width="1" />
          <line x1="40" y1="14" x2="40" y2="230" stroke="#475569" stroke-width="1" />
          <text x="8" y="24" fill="#94a3b8" font-size="11">Count</text>
          <text x="450" y="252" text-anchor="middle" fill="#94a3b8" font-size="11">
            Date / Time
          </text>
          <text
            v-for="(tick, idx) in systemChartXTicks"
            :key="`sys-x-label-${idx}`"
            :x="tick.x"
            y="244"
            text-anchor="middle"
            fill="#94a3b8"
            font-size="10"
          >
            {{ tick.label }}
          </text>
          <polygon :points="systemChartAreaPolyline" fill="url(#systemErrorsAreaGradient)" />
          <polyline
            :points="systemChartPolyline"
            fill="none"
            stroke="#ef4444"
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <circle
            v-for="(point, idx) in systemChartCoordinates"
            :key="`system-point-${idx}`"
            :cx="point.x"
            :cy="point.y"
            r="5"
            fill="#fecaca"
            class="cursor-pointer"
            @mousemove="showChartTooltip($event, [point.at, `System errors: ${point.count}`])"
            @mouseleave="hideChartTooltip"
          >
            <title>
              {{ point.at }}
              {{ `System errors: ${point.count}` }}
            </title>
          </circle>
        </svg>
      </div>

      <div class="rounded border border-surface-700 bg-surface-900/40 p-3 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h6 class="font-semibold">Spike Cause Summary</h6>
          <div class="flex flex-wrap items-center gap-2">
            <UInput v-model="systemSpikeFromLocal" type="datetime-local" size="sm" class="w-56" />
            <UInput v-model="systemSpikeToLocal" type="datetime-local" size="sm" class="w-56" />
            <UInput v-model="systemSpikeLevels" size="sm" class="w-40" placeholder="Levels" />
            <UInputNumber v-model="systemSpikeLimit" :min="1" :max="200" size="sm" class="w-16" />
            <UButton
              label="Use Peak"
              size="sm"
              color="neutral"
              variant="outline"
              @click="buildSpikeWindowFromPeak"
            />
            <UButton
              label="Analyze"
              size="sm"
              color="neutral"
              variant="outline"
              :loading="loadingSystemSpikeSummary"
              @click="loadSystemSpikeSummary"
            />
          </div>
        </div>

        <p class="text-xs text-surface-400">
          Top repeated log messages for selected window (default levels: ERROR,WARNING).
          <template v-if="systemSpikeSummary">
            Window total events: {{ systemSpikeSummary.total_events }}.
          </template>
        </p>

        <div v-if="!systemSpikeSummary?.buckets?.length" class="text-sm text-surface-400">
          {{
            loadingSystemSpikeSummary
              ? 'Analyzing spike window...'
              : 'No grouped causes found for this timeframe.'
          }}
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="border-b border-surface-600 text-left">
                <th class="py-2 pe-2">Occurrences</th>
                <th class="py-2 pe-2">Share</th>
                <th class="py-2 pe-2">Logger</th>
                <th class="py-2 pe-2">Level</th>
                <th class="py-2">Message</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, idx) in systemSpikeSummary.buckets"
                :key="`spike-cause-${idx}`"
                class="border-b border-surface-700/70 align-top"
              >
                <td class="py-2 pe-2 whitespace-nowrap">{{ item.occurrences }}</td>
                <td class="py-2 pe-2 whitespace-nowrap">
                  {{
                    systemSpikeSummary.total_events
                      ? ((item.occurrences / systemSpikeSummary.total_events) * 100).toFixed(1)
                      : '0.0'
                  }}%
                </td>
                <td class="py-2 pe-2 whitespace-nowrap">{{ item.logger }}</td>
                <td class="py-2 pe-2 whitespace-nowrap">{{ item.level }}</td>
                <td class="py-2 break-words">{{ item.message }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="border-t border-surface-600">
                <td class="py-2 pe-2 font-semibold">{{ systemSpikeTopOccurrences }}</td>
                <td class="py-2 pe-2 text-surface-400" colspan="4">
                  Covered by top causes:
                  {{
                    systemSpikeSummary.total_events
                      ? (
                          (systemSpikeTopOccurrences / systemSpikeSummary.total_events) *
                          100
                        ).toFixed(1)
                      : '0.0'
                  }}%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-surface-600 text-left">
              <th class="py-2 pe-2">Time</th>
              <th class="py-2">Errors</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(point, idx) in systemErrorTimelinePoints.slice(-24)"
              :key="`sys-row-${point.ts}-${idx}`"
              class="border-b border-surface-700/70 align-top"
            >
              <td class="py-2 pe-2 whitespace-nowrap">{{ point.at }}</td>
              <td class="py-2 whitespace-nowrap">{{ point.count }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
