<script setup lang="ts">
import { ensureBotLoginInfo } from '@/composables/loginInfo';
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

function loginStatusSeverity(row: DiscoveredBotRow): 'success' | 'warn' | 'secondary' {
  const status = loginStatus(row);
  if (status === 'auto-logged') {
    return 'success';
  }
  if (status === 'manual-login') {
    return 'warn';
  }
  return 'secondary';
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
      severity: 'warn',
      summary: 'Nothing selected',
      detail: 'Select one or more discovered bots to import.',
      life: 4000,
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

      const urlExists = Object.values(botStore.availableBots).some((bot) => bot.botUrl === row.suggestedUrl);
      if (urlExists) {
        skippedByUrl += 1;
        continue;
      }

      const sortId = Object.keys(botStore.availableBots).length + added + 1;
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
    severity: added > 0 ? 'success' : 'warn',
    summary: 'Import completed',
    detail,
    life: 6000,
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
      vpsStore.servers.map((server) =>
        vpsStore.loadContainers(server.id).catch(() => undefined),
      ),
    );
  } finally {
    loading.value = false;
  }
}

async function discoverAll() {
  loading.value = true;
  try {
    await vpsStore.loadServers();
    for (const server of vpsStore.servers) {
      await vpsStore.discover(server.id).catch(() => undefined);
    }
    await Promise.all(
      vpsStore.servers.map((server) =>
        vpsStore.loadContainers(server.id).catch(() => undefined),
      ),
    );
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadData();
});
</script>

<template>
  <Card>
    <template #title>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span>Discovered Bots from VPS</span>
        <div class="flex items-center gap-2">
          <BaseCheckbox v-model="showOnlyFreqtrade">Freqtrade only</BaseCheckbox>
          <Button
            :label="allEligibleSelected ? 'Unselect Eligible' : 'Select Eligible'"
            severity="secondary"
            outlined
            @click="toggleAllEligible"
          />
          <Button
            label="Import Selected"
            :disabled="selectedRows.length === 0"
            :loading="importLoading"
            @click="importSelected"
          />
          <Button
            label="Discover All"
            severity="secondary"
            outlined
            :loading="loading"
            @click="discoverAll"
          />
          <Button
            label="Refresh"
            severity="secondary"
            outlined
            :loading="loading"
            @click="loadData"
          />
        </div>
      </div>
    </template>
    <template #content>
      <DataTable :value="filteredRows" data-key="key" size="small" show-gridlines :loading="loading">
        <Column header="Select">
          <template #body="slotProps">
            <BaseCheckbox
              :model-value="Boolean(selectedRowsMap[slotProps.data.key])"
              :disabled="!slotProps.data.importEligible"
              @update:model-value="selectedRowsMap[slotProps.data.key] = $event"
            />
          </template>
        </Column>
        <Column field="vpsName" header="VPS" />
        <Column field="containerName" header="Container" />
        <Column field="status" header="Status" />
        <Column field="strategy" header="Strategy" />
        <Column field="exchange" header="Exchange" />
        <Column field="pairlist" header="Pairlist" />
        <Column header="Imported">
          <template #body="slotProps">
            <Tag :value="isImported(slotProps.data) ? 'Yes' : 'No'" :severity="isImported(slotProps.data) ? 'success' : 'secondary'" />
          </template>
        </Column>
        <Column header="Freqtrade">
          <template #body="slotProps">
            <Tag
              :value="slotProps.data.isFreqtrade ? 'Yes' : 'No'"
              :severity="slotProps.data.isFreqtrade ? 'success' : 'secondary'"
            />
          </template>
        </Column>
        <Column header="API Port">
          <template #body="slotProps">
            {{ slotProps.data.apiPort ?? '—' }}
          </template>
        </Column>
        <Column field="suggestedUrl" header="Suggested URL" />
        <Column header="Eligible">
          <template #body="slotProps">
            <Tag
              :value="slotProps.data.importEligible ? 'Yes' : 'No'"
              :severity="slotProps.data.importEligible ? 'success' : 'warn'"
            />
          </template>
        </Column>
        <Column header="Login">
          <template #body="slotProps">
            <Tag :value="loginStatusLabel(slotProps.data)" :severity="loginStatusSeverity(slotProps.data)" />
          </template>
        </Column>
        <Column field="eligibilityReason" header="Reason" />
      </DataTable>
    </template>
  </Card>
</template>
