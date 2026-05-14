<script setup lang="ts">
import { ensureBotLoginInfo, useLoginInfo } from '@/composables/loginInfo';
import { vpsApi } from '@/composables/vpsApi';
import type { VpsContainer, VpsServer } from '@/types/vps';

const toast = useToast();
const botStore = useBotStore();
const vpsStore = useVpsStore();
const loading = ref(false);
const importLoading = ref(false);
const showOnlyFreqtrade = ref(true);
const selectedRowsMap = ref<Record<string, boolean>>({});
const importedStatusByBotId = ref<Record<string, 'auto-logged' | 'manual-login'>>({});

interface DiscoveredBotRow {
  key: string;
  vpsId: number;
  vpsName: string;
  vpsIp: string;
  containerName: string;
  status: string;
  strategy: string;
  exchange: string;
  pairlist: string;
  isFreqtrade: boolean;
  apiPort: number | null;
  suggestedUrl: string;
  importEligible: boolean;
  eligibilityReason: string;
}

function buildSuggestedUrl(vpsIp: string, apiPort: number | null): string {
  if (!apiPort) {
    return '';
  }
  return `http://${vpsIp}:${apiPort}`;
}

function toDiscoveredRow(vps: VpsServer, container: VpsContainer): DiscoveredBotRow {
  const suggestedUrl = buildSuggestedUrl(vps.ip, container.api_port);
  const importEligible = container.is_freqtrade && Boolean(container.api_port);

  let eligibilityReason = 'Ready';
  if (!container.is_freqtrade) {
    eligibilityReason = 'Not freqtrade';
  } else if (!container.api_port) {
    eligibilityReason = 'Missing api_port';
  }

  return {
    key: `${vps.id}:${container.container_name}`,
    vpsId: vps.id,
    vpsName: vps.name,
    vpsIp: vps.ip,
    containerName: container.container_name,
    status: container.status,
    strategy: container.strategy || '—',
    exchange: container.exchange || '—',
    pairlist: container.pairlist || '—',
    isFreqtrade: container.is_freqtrade,
    apiPort: container.api_port,
    suggestedUrl,
    importEligible,
    eligibilityReason,
  };
}

const rows = computed<DiscoveredBotRow[]>(() => {
  const result: DiscoveredBotRow[] = [];

  for (const server of vpsStore.servers) {
    const containers = vpsStore.getContainersForVps(server.id);
    for (const container of containers) {
      if (!container.enabled) {
        continue;
      }
      result.push(toDiscoveredRow(server, container));
    }
  }

  return result.sort((a, b) => {
    if (a.vpsName === b.vpsName) {
      return a.containerName.localeCompare(b.containerName);
    }
    return a.vpsName.localeCompare(b.vpsName);
  });
});

const filteredRows = computed<DiscoveredBotRow[]>(() => {
  if (!showOnlyFreqtrade.value) {
    return rows.value;
  }
  return rows.value.filter((item) => item.isFreqtrade);
});

const selectedRows = computed<DiscoveredBotRow[]>(() => {
  return filteredRows.value.filter((row) => selectedRowsMap.value[row.key]);
});

const eligibleRows = computed<DiscoveredBotRow[]>(() => {
  return filteredRows.value.filter((row) => row.importEligible);
});

const eligibleSelectedCount = computed(() => {
  return eligibleRows.value.filter((row) => selectedRowsMap.value[row.key]).length;
});

const allEligibleSelected = computed(() => {
  return eligibleRows.value.length > 0 && eligibleSelectedCount.value === eligibleRows.value.length;
});

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function buildImportedBotId(row: DiscoveredBotRow): string {
  const slug = slugify(row.containerName) || 'container';
  return `vps.${row.vpsId}.container.${slug}`;
}

function isImported(row: DiscoveredBotRow): boolean {
  return Boolean(botStore.availableBots[buildImportedBotId(row)]);
}

function hasStoredAuth(botId: string): boolean {
  const bot = botStore.botStores[botId];
  if (!bot) {
    return false;
  }
  const loginInfo = bot.getLoginInfo();
  const accessToken = String(loginInfo?.accessToken || '').trim();
  const refreshToken = String(loginInfo?.refreshToken || '').trim();
  return Boolean(accessToken || refreshToken);
}

function loginStatus(row: DiscoveredBotRow): 'auto-logged' | 'manual-login' | 'not-imported' {
  const botId = buildImportedBotId(row);
  if (!botStore.availableBots[botId]) {
    return 'not-imported';
  }

  if (hasStoredAuth(botId)) {
    return 'auto-logged';
  }

  return importedStatusByBotId.value[botId] || 'manual-login';
}

function loginStatusLabel(row: DiscoveredBotRow): string {
  const status = loginStatus(row);
  if (status === 'auto-logged') {
    return 'Auto-logged';
  }
  if (status === 'manual-login') {
    return 'Needs manual login';
  }
  return 'Not imported';
}

function loginStatusColor(row: DiscoveredBotRow): 'success' | 'warning' | 'neutral' {
  const status = loginStatus(row);
  if (status === 'auto-logged') {
    return 'success';
  }
  if (status === 'manual-login') {
    return 'warning';
  }
  return 'neutral';
}

function toggleAllEligible() {
  const nextValue = !allEligibleSelected.value;
  const nextMap = { ...selectedRowsMap.value };

  for (const row of eligibleRows.value) {
    nextMap[row.key] = nextValue;
  }

  selectedRowsMap.value = nextMap;
}

function clearSelection() {
  selectedRowsMap.value = {};
}

async function importSelected() {
  const selected = selectedRows.value;
  if (!selected.length) {
    toast.add({
      color: 'warning',
      title: 'Nothing selected',
      description: 'Select one or more discovered bots to import.',
      duration: 4000,
    });
    return;
  }

  let added = 0;
  let skippedNotEligible = 0;
  let skippedById = 0;
  let skippedByUrl = 0;
  let autoLogged = 0;
  let autoLoginFailed = 0;

  importLoading.value = true;
  try {
    for (const row of selected) {
      if (!row.importEligible || !row.suggestedUrl) {
        skippedNotEligible += 1;
        continue;
      }

      const botId = buildImportedBotId(row);
      if (botStore.availableBots[botId]) {
        skippedById += 1;
        continue;
      }

      const urlExists = Object.values(botStore.availableBots).some(
        (bot) => bot.botUrl === row.suggestedUrl,
      );
      if (urlExists) {
        skippedByUrl += 1;
        continue;
      }

      const existingSortIds = Object.values(botStore.availableBots).map((b) => b.sortId ?? 0);
      const sortId = (existingSortIds.length > 0 ? Math.max(...existingSortIds) : 0) + added + 1;
      const botName = `${row.vpsName}:${row.containerName}`;

      let resolvedUrl = row.suggestedUrl;
      let hintUsername = '';
      let hintPassword = '';
      try {
        const authHint = await vpsApi.containerAuthHint(row.vpsId, row.containerName);
        resolvedUrl = authHint.url || resolvedUrl;
        hintUsername = authHint.username || '';
        hintPassword = authHint.password || '';
      } catch {
        // Ignore hint failures and keep import fallback behavior.
      }

      ensureBotLoginInfo(botId, {
        botName,
        botUrl: resolvedUrl,
        sortId,
      });

      if (hintUsername && hintPassword) {
        try {
          // useLoginInfo is a factory (not lifecycle-bound) — safe to call per-bot
          const { login } = useLoginInfo(botId);
          await login({
            botName,
            url: resolvedUrl,
            username: hintUsername,
            password: hintPassword,
          });
          autoLogged += 1;
          importedStatusByBotId.value[botId] = 'auto-logged';
        } catch {
          autoLoginFailed += 1;
          importedStatusByBotId.value[botId] = 'manual-login';
        }
      } else {
        importedStatusByBotId.value[botId] = 'manual-login';
      }

      botStore.addBot({
        botId,
        botName,
        botUrl: resolvedUrl,
        sortId,
      });
      added += 1;
    }
  } finally {
    importLoading.value = false;
  }

  clearSelection();

  const detail = `Added ${added} | Auto-login ${autoLogged}${autoLoginFailed ? ` (failed: ${autoLoginFailed})` : ''} | Skipped (not eligible: ${skippedNotEligible}, duplicate id: ${skippedById}, duplicate url: ${skippedByUrl})`;
  toast.add({
    color: added > 0 ? 'success' : 'warning',
    title: 'Import completed',
    description: detail,
    duration: 6000,
  });
}

watch(
  filteredRows,
  (nextRows) => {
    const validKeys = new Set(nextRows.map((row) => row.key));
    const nextMap: Record<string, boolean> = {};
    Object.entries(selectedRowsMap.value).forEach(([key, selected]) => {
      if (selected && validKeys.has(key)) {
        nextMap[key] = true;
      }
    });
    selectedRowsMap.value = nextMap;
  },
  { immediate: true },
);

async function loadData() {
  loading.value = true;
  try {
    await vpsStore.loadServers();
    await Promise.all(
      vpsStore.servers.map((server) => vpsStore.loadContainers(server.id).catch(() => undefined)),
    );
  } catch (err) {
    toast.add({
      color: 'error',
      title: 'Failed to load VPS data',
      description: String(err),
      duration: 5000,
    });
  } finally {
    loading.value = false;
  }
}

async function discoverAll() {
  loading.value = true;
  try {
    await vpsStore.loadServers();
    await Promise.all(
      vpsStore.servers.map((server) => vpsApi.discover(server.id).catch(() => undefined)),
    );
    await Promise.all([
      vpsStore.loadServers(),
      ...vpsStore.servers.map((server) =>
        vpsStore.loadContainers(server.id).catch(() => undefined),
      ),
    ]);
  } catch (err) {
    toast.add({
      color: 'error',
      title: 'Discovery failed',
      description: String(err),
      duration: 5000,
    });
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadData();
});
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-semibold">Discovered Bots from VPS</span>
        <div class="flex items-center gap-2 flex-wrap">
          <BaseCheckbox v-model="showOnlyFreqtrade">Freqtrade only</BaseCheckbox>
          <UButton
            :label="allEligibleSelected ? 'Unselect Eligible' : 'Select Eligible'"
            color="neutral"
            variant="outline"
            @click="toggleAllEligible"
          />
          <UButton
            label="Import Selected"
            :disabled="selectedRows.length === 0"
            :loading="importLoading"
            @click="importSelected"
          />
          <UButton
            label="Discover All"
            color="neutral"
            variant="outline"
            :loading="loading"
            @click="discoverAll"
          />
          <UButton
            label="Refresh"
            color="neutral"
            variant="outline"
            :loading="loading"
            @click="loadData"
          />
        </div>
      </div>
    </template>
    <div class="overflow-auto border border-surface-500 rounded-sm">
      <table class="w-full text-left border-collapse text-sm">
        <thead class="bg-surface-100 dark:bg-surface-800">
          <tr class="border-b border-surface-500">
            <th class="p-2 font-semibold">Select</th>
            <th class="p-2 font-semibold">VPS</th>
            <th class="p-2 font-semibold">Container</th>
            <th class="p-2 font-semibold">Status</th>
            <th class="p-2 font-semibold">Strategy</th>
            <th class="p-2 font-semibold">Exchange</th>
            <th class="p-2 font-semibold">Pairlist</th>
            <th class="p-2 font-semibold">Imported</th>
            <th class="p-2 font-semibold">Freqtrade</th>
            <th class="p-2 font-semibold">API Port</th>
            <th class="p-2 font-semibold">Suggested URL</th>
            <th class="p-2 font-semibold">Eligible</th>
            <th class="p-2 font-semibold">Login</th>
            <th class="p-2 font-semibold">Reason</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="row.key" class="border-b border-surface-500">
            <td class="p-2 align-middle">
              <BaseCheckbox
                :model-value="Boolean(selectedRowsMap[row.key])"
                :disabled="!row.importEligible"
                @update:model-value="selectedRowsMap[row.key] = $event"
              />
            </td>
            <td class="p-2 align-middle">{{ row.vpsName }}</td>
            <td class="p-2 align-middle">{{ row.containerName }}</td>
            <td class="p-2 align-middle">{{ row.status }}</td>
            <td class="p-2 align-middle">{{ row.strategy }}</td>
            <td class="p-2 align-middle">{{ row.exchange }}</td>
            <td class="p-2 align-middle">{{ row.pairlist }}</td>
            <td class="p-2 align-middle">
              <UBadge
                :label="isImported(row) ? 'Yes' : 'No'"
                :color="isImported(row) ? 'success' : 'neutral'"
                variant="subtle"
              />
            </td>
            <td class="p-2 align-middle">
              <UBadge
                :label="row.isFreqtrade ? 'Yes' : 'No'"
                :color="row.isFreqtrade ? 'success' : 'neutral'"
                variant="subtle"
              />
            </td>
            <td class="p-2 align-middle">{{ row.apiPort ?? '—' }}</td>
            <td class="p-2 align-middle">{{ row.suggestedUrl }}</td>
            <td class="p-2 align-middle">
              <UBadge
                :label="row.importEligible ? 'Yes' : 'No'"
                :color="row.importEligible ? 'success' : 'warning'"
                variant="subtle"
              />
            </td>
            <td class="p-2 align-middle">
              <UBadge
                :label="loginStatusLabel(row)"
                :color="loginStatusColor(row)"
                variant="subtle"
              />
            </td>
            <td class="p-2 align-middle">{{ row.eligibilityReason }}</td>
          </tr>
          <tr v-if="loading && !filteredRows.length">
            <td colspan="14" class="p-3 text-center text-surface-400">Loading...</td>
          </tr>
          <tr v-else-if="!filteredRows.length">
            <td colspan="14" class="p-3 text-center text-surface-400">No discovered bots</td>
          </tr>
        </tbody>
      </table>
    </div>
  </UCard>
</template>
