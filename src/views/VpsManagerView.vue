<script setup lang="ts">
import VpsLogsPanel from '@/components/vps/VpsLogsPanel.vue';
import VpsOnboardDialog from '@/components/vps/VpsOnboardDialog.vue';
import VpsTable from '@/components/vps/VpsTable.vue';
import {
  getControlPlaneActor,
  getControlPlaneActorPermissions,
  getControlPlaneActorOptions,
  getVpsStatusStreamUrl,
  setControlPlaneActor,
} from '@/composables/vpsApi';
import type { DropdownMenuItem } from '@nuxt/ui';
import type {
  AuditLogEntry,
  VpsContainer,
  VpsCreatePayload,
  VpsServer,
  VpsStatusStreamPayload,
  VpsUpdatePayload,
} from '@/types/vps';

const toast = useToast();
const vpsStore = useVpsStore();

const showOnboardDialog = ref(false);
const showEditDialog = ref(false);
const editingVps = ref<VpsServer | null>(null);
const selectedVpsId = ref<number | null>(null);
// Guards the bulk start/restart/stop-all loop (can run for minutes with a 2-min
// stagger) against being re-triggered while already in flight.
const bulkActionInFlight = ref(false);
const logsVisible = ref(false);
const selectedContainerName = ref('');
const logsText = ref('');
const logsLoading = ref(false);
const strategyModalVisible = ref(false);
const strategyContainerName = ref('');
const strategyOptions = ref<string[]>([]);
const strategyCurrent = ref<string | null>(null);
const strategySelected = ref<string | undefined>(undefined);
const strategyRestart = ref(true);
const strategyLoading = ref(false);
const strategyApplying = ref(false);
const streamConnected = ref(false);
const streamStatusText = computed(() => (streamConnected.value ? 'Live' : 'Polling'));
const actorOptions = getControlPlaneActorOptions();
const selectedActor = ref(getControlPlaneActor());
const actorPermissionBadges = computed(() => getControlPlaneActorPermissions(selectedActor.value));
let statusEventSource: EventSource | null = null;
let pollTimer: number | null = null;
let isStreaming = false;

function permissionColor(permission: string) {
  if (permission.endsWith(':admin')) {
    return 'error';
  }
  if (permission.endsWith(':manage')) {
    return 'warning';
  }
  return 'info';
}

const selectedVps = computed(() =>
  vpsStore.servers.find((item) => item.id === selectedVpsId.value),
);
const vpsNameById = computed<Map<string, string>>(
  () => new Map(vpsStore.servers.map((server) => [String(server.id), server.name])),
);
const selectedContainers = computed<VpsContainer[]>(() => {
  if (!selectedVpsId.value) {
    return [];
  }
  return vpsStore.getContainersForVps(selectedVpsId.value);
});
const auditEntries = computed<AuditLogEntry[]>(() => vpsStore.auditEntries);
const selectedAuditTime = ref('Today');
const selectedAuditActor = ref('all');
const selectedAuditResult = ref('all');
const selectedAuditAction = ref('all');
const selectedAuditTargetId = ref('all');
const auditTimeOptions = ['All', 'Today', 'Yesterday', 'This week', 'Last week'];
const auditActorOptions = computed<string[]>(() => {
  const options = new Set<string>(['all']);
  for (const entry of auditEntries.value) {
    const value = String(entry.actor || '').trim();
    if (value) {
      options.add(value);
    }
  }
  return Array.from(options);
});
const auditResultOptions = computed<string[]>(() => {
  const options = new Set<string>(['all']);
  for (const entry of auditEntries.value) {
    const value = String(entry.result || '').trim();
    if (value) {
      options.add(value);
    }
  }
  return Array.from(options);
});
const auditActionOptions = computed<string[]>(() => {
  const options = new Set<string>(['all']);
  for (const entry of auditEntries.value) {
    const value = String(entry.action || '').trim();
    if (value) {
      options.add(value);
    }
  }
  return Array.from(options);
});

function resolveAuditTarget(entry: AuditLogEntry): string {
  const target = String(entry.target_id || '').trim();
  if (!target) {
    return '—';
  }

  if (entry.target_type === 'vps') {
    return vpsNameById.value.get(target) || target;
  }

  return target;
}

const auditTargetIdOptions = computed<string[]>(() => {
  const options = new Set<string>(['all']);
  for (const entry of auditEntries.value) {
    const value = resolveAuditTarget(entry);
    if (value) {
      options.add(value);
    }
  }
  return Array.from(options);
});

function getWeekStart(date: Date): Date {
  const start = new Date(date);
  const day = start.getDay();
  const daysSinceMonday = (day + 6) % 7;
  start.setDate(start.getDate() - daysSinceMonday);
  start.setHours(0, 0, 0, 0);
  return start;
}

function auditTimeMatches(createdAt: string, selectedRange: string): boolean {
  if (selectedRange === 'All') {
    return true;
  }

  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime())) {
    return false;
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  if (selectedRange === 'Today') {
    return timestamp >= todayStart;
  }

  if (selectedRange === 'Yesterday') {
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    return timestamp >= yesterdayStart && timestamp < todayStart;
  }

  const thisWeekStart = getWeekStart(now);
  if (selectedRange === 'This week') {
    return timestamp >= thisWeekStart;
  }

  if (selectedRange === 'Last week') {
    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    return timestamp >= lastWeekStart && timestamp < thisWeekStart;
  }

  return true;
}

const filteredAuditEntries = computed<AuditLogEntry[]>(() => {
  return auditEntries.value.filter((entry) => {
    const actorMatches =
      selectedAuditActor.value === 'all' || entry.actor === selectedAuditActor.value;
    const resultMatches =
      selectedAuditResult.value === 'all' || entry.result === selectedAuditResult.value;
    const actionMatches =
      selectedAuditAction.value === 'all' || entry.action === selectedAuditAction.value;
    const targetIdMatches =
      selectedAuditTargetId.value === 'all' ||
      resolveAuditTarget(entry) === selectedAuditTargetId.value;
    const timeMatches = auditTimeMatches(entry.created_at, selectedAuditTime.value);
    return actorMatches && resultMatches && actionMatches && targetIdMatches && timeMatches;
  });
});

async function loadServers() {
  try {
    await vpsStore.loadServers();
  } catch (error) {
    toast.add({
      color: 'error',
      title: 'Load Failed',
      description: String(error),
      duration: 5000,
    });
  }
}

async function loadAudit() {
  try {
    await vpsStore.loadAudit(100);
  } catch (error) {
    toast.add({
      color: 'error',
      title: 'Audit Load Failed',
      description: String(error),
      duration: 5000,
    });
  }
}

function startPollingFallback() {
  if (pollTimer || isStreaming) {
    return;
  }
  pollTimer = window.setInterval(() => {
    // Silent polling: log failures instead of the toasting loadServers/loadAudit
    // wrappers, which otherwise spam an error-toast pair every 20s while the
    // backend is unreachable. Manual/initial loads still use the toasting paths.
    vpsStore.loadServers().catch((err) => console.warn('Polling: failed to load servers', err));
    vpsStore.loadAudit(100).catch((err) => console.warn('Polling: failed to load audit', err));
    if (selectedVpsId.value) {
      vpsStore.loadContainers(selectedVpsId.value).catch((err) => {
        console.warn('Polling: failed to load containers', err);
      });
    }
  }, 20000);
}

function stopPollingFallback() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function connectStatusStream() {
  if (statusEventSource) {
    statusEventSource.close();
    statusEventSource = null;
  }
  isStreaming = false;

  const streamUrl = getVpsStatusStreamUrl();
  const eventSource = new EventSource(streamUrl);
  statusEventSource = eventSource;

  eventSource.addEventListener('status', (event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as VpsStatusStreamPayload;
      vpsStore.applyStatusSnapshot(payload);
      isStreaming = true;
      streamConnected.value = true;
      stopPollingFallback();
    } catch {
      isStreaming = false;
      streamConnected.value = false;
      startPollingFallback();
    }
  });

  eventSource.onerror = () => {
    isStreaming = false;
    streamConnected.value = false;
    startPollingFallback();
  };
}

async function handleActorChange(newActorValue: string) {
  const actor = String(newActorValue || '')
    .trim()
    .toLowerCase();
  if (!actor || actor === getControlPlaneActor()) {
    return;
  }

  setControlPlaneActor(actor);
  selectedActor.value = getControlPlaneActor();
  streamConnected.value = false;
  connectStatusStream();
  startPollingFallback();

  await Promise.all([loadServers(), loadAudit()]);
  if (selectedVpsId.value) {
    await vpsStore.loadContainers(selectedVpsId.value).catch((err) => {
      console.warn('Actor change: failed to load containers', err);
    });
  }

  handleActionToast('Actor Changed', `Using ${selectedActor.value}`);
}

function handleActionToast(summary: string, message: string, ok = true) {
  toast.add({
    color: ok ? 'success' : 'warning',
    title: summary,
    description: message,
    duration: 5000,
  });
}

async function handleAddServer(payload: VpsUpdatePayload | VpsCreatePayload) {
  try {
    await vpsStore.addServer(payload as VpsCreatePayload);
    showOnboardDialog.value = false;
    handleActionToast('VPS Added', `Added ${payload.name}`);
  } catch (error) {
    handleActionToast('Add VPS Failed', String(error), false);
  }
}

async function handleEditServer(payload: VpsUpdatePayload | VpsCreatePayload) {
  if (!editingVps.value) {
    return;
  }

  try {
    await vpsStore.updateServer(editingVps.value.id, payload as VpsUpdatePayload);
    showEditDialog.value = false;
    editingVps.value = null;
    handleActionToast('VPS Updated', 'Saved VPS changes');
  } catch (error) {
    handleActionToast('Edit VPS Failed', String(error), false);
  }
}

async function handleTest(item: VpsServer) {
  try {
    const result = await vpsStore.testServer(item.id);
    handleActionToast(`Test ${item.name}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Test ${item.name}`, String(error), false);
  }
}

async function handleCheckDocker(item: VpsServer) {
  try {
    const result = await vpsStore.checkDocker(item.id);
    handleActionToast(`Docker ${item.name}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Docker ${item.name}`, String(error), false);
  }
}

async function handleDiscover(item: VpsServer) {
  try {
    const result = await vpsStore.discover(item.id);
    selectedVpsId.value = item.id;
    handleActionToast(`Discover ${item.name}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Discover ${item.name}`, String(error), false);
  }
}

async function handleShowContainers(item: VpsServer) {
  selectedVpsId.value = item.id;
  try {
    await vpsStore.loadContainers(item.id);
  } catch (error) {
    handleActionToast(`Containers ${item.name}`, String(error), false);
  }
}

async function runContainerActionForVps(item: VpsServer, action: 'start' | 'restart' | 'stop') {
  if (bulkActionInFlight.value) {
    return;
  }
  bulkActionInFlight.value = true;
  try {
    await vpsStore.loadContainers(item.id);
    // Only ever act on freqtrade bot containers, never other infra containers
    // discovered on the host. For 'start', also skip deliberately-disabled bots
    // so a bulk start doesn't resume a container that was parked on purpose.
    let containers = vpsStore.getContainersForVps(item.id).filter((c) => c.is_freqtrade);
    if (action === 'start') {
      containers = containers.filter((c) => c.enabled);
    }
    if (!containers.length) {
      handleActionToast(
        `${action} ${item.name}`,
        'No eligible freqtrade containers for this action.',
        false,
      );
      return;
    }

    const RESTART_DELAY_MS = 120_000;
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < containers.length; i++) {
      const container = containers[i];
      try {
        if (action === 'start') {
          await vpsStore.startContainer(item.id, container.container_name);
        } else if (action === 'restart') {
          await vpsStore.restartContainer(item.id, container.container_name);
        } else {
          await vpsStore.stopContainer(item.id, container.container_name);
        }
        okCount += 1;
      } catch {
        failCount += 1;
      }
      // Stagger restarts to avoid simultaneous boot-up causing exchange rate limits
      if (action === 'restart' && i < containers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      }
    }

    handleActionToast(
      `${action[0].toUpperCase()}${action.slice(1)} ${item.name}`,
      `Success: ${okCount}, Failed: ${failCount}`,
      failCount === 0,
    );
  } catch (error) {
    handleActionToast(`${action} ${item.name}`, String(error), false);
  } finally {
    bulkActionInFlight.value = false;
  }
}

async function handleStartAll(item: VpsServer) {
  await runContainerActionForVps(item, 'start');
}

async function handleRestartAll(item: VpsServer) {
  if (
    !window.confirm(
      `Restart ALL containers on "${item.name}"?\n\nBots are restarted one at a time with a 2-minute stagger, so this takes several minutes; each bot briefly stops trading as it restarts.`,
    )
  ) {
    return;
  }
  await runContainerActionForVps(item, 'restart');
}

async function handleStopAll(item: VpsServer) {
  if (
    !window.confirm(
      `Stop ALL containers on "${item.name}"?\n\nEvery bot on this VPS will stop trading and any open leveraged positions will be left unmanaged (no ROI exits or trailing) until restarted.`,
    )
  ) {
    return;
  }
  await runContainerActionForVps(item, 'stop');
}

async function handleRebootVps(item: VpsServer) {
  const confirmed = window.confirm(
    `Restart VPS "${item.name}"?\n\nThis will reboot the entire server. All bots will be offline for 1–2 minutes.`,
  );
  if (!confirmed) {
    return;
  }
  try {
    const result = await vpsApi.rebootVps(item.id);
    handleActionToast(`Restart VPS — ${item.name}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Restart VPS — ${item.name}`, String(error), false);
  }
}

function handleEdit(item: VpsServer) {
  editingVps.value = item;
  showEditDialog.value = true;
}

async function handleDelete(item: VpsServer) {
  const confirmed = window.confirm(`Delete VPS ${item.name}?`);
  if (!confirmed) {
    return;
  }

  try {
    await vpsStore.deleteServer(item.id);
    if (selectedVpsId.value === item.id) {
      selectedVpsId.value = null;
    }
    handleActionToast('VPS Deleted', `Deleted ${item.name}`);
  } catch (error) {
    handleActionToast(`Delete ${item.name}`, String(error), false);
  }
}

async function handleRestart(containerName: string) {
  if (!selectedVpsId.value) {
    return;
  }
  try {
    const result = await vpsStore.restartContainer(selectedVpsId.value, containerName);
    handleActionToast(`Restart ${containerName}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Restart ${containerName}`, String(error), false);
  }
}

async function handleStart(containerName: string) {
  if (!selectedVpsId.value) {
    return;
  }
  try {
    const result = await vpsStore.startContainer(selectedVpsId.value, containerName);
    handleActionToast(`Start ${containerName}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Start ${containerName}`, String(error), false);
  }
}

async function handleStop(containerName: string) {
  if (!selectedVpsId.value) {
    return;
  }
  if (
    !window.confirm(
      `Stop container "${containerName}"?\n\nThe bot will stop trading and any open leveraged positions will be left unmanaged (no ROI exits or trailing) until it is started again.`,
    )
  ) {
    return;
  }
  try {
    const result = await vpsStore.stopContainer(selectedVpsId.value, containerName);
    handleActionToast(`Stop ${containerName}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Stop ${containerName}`, String(error), false);
  }
}

async function handlePurgeDwh(containerName: string, enabled: boolean) {
  if (!selectedVpsId.value) {
    return;
  }
  const warning = enabled
    ? `⚠️ WARNING: "${containerName}" is still enabled.\n\nPurge ALL DWH data for this container? This cannot be undone.`
    : `Purge ALL DWH data for "${containerName}"? This cannot be undone.`;
  if (!window.confirm(warning)) {
    return;
  }
  try {
    const result = await vpsApi.purgeContainerDwhData(selectedVpsId.value, containerName);
    handleActionToast(
      `Purge DWH — ${containerName}`,
      `Deleted: ${result.deleted_trades} trades, ${result.deleted_orders} orders, ${result.deleted_log_events} log events`,
      true,
    );
  } catch (error) {
    handleActionToast(`Purge DWH — ${containerName}`, String(error), false);
  }
}

async function handleToggleEnabled(containerName: string, currentEnabled: boolean) {
  if (!selectedVpsId.value) {
    return;
  }
  try {
    const result = await vpsStore.setContainerEnabled(
      selectedVpsId.value,
      containerName,
      !currentEnabled,
    );
    handleActionToast(
      `${!currentEnabled ? 'Enable' : 'Disable'} ${containerName}`,
      result.message,
      result.ok,
    );
  } catch (error) {
    handleActionToast(`Toggle ${containerName}`, String(error), false);
  }
}

async function openLogs(containerName: string) {
  if (!selectedVpsId.value) {
    return;
  }
  selectedContainerName.value = containerName;
  logsVisible.value = true;
  await refreshLogs();
}

async function openStrategyModal(containerName: string) {
  if (!selectedVpsId.value) {
    return;
  }
  strategyContainerName.value = containerName;
  strategyOptions.value = [];
  strategyCurrent.value = null;
  strategySelected.value = undefined;
  strategyRestart.value = true;
  strategyModalVisible.value = true;
  strategyLoading.value = true;
  try {
    const result = await vpsStore.loadContainerStrategies(selectedVpsId.value, containerName);
    strategyOptions.value = result.available;
    strategyCurrent.value = result.current;
    strategySelected.value = result.current ?? undefined;
  } catch (error) {
    handleActionToast(`Strategies — ${containerName}`, String(error), false);
    strategyModalVisible.value = false;
  } finally {
    strategyLoading.value = false;
  }
}

const strategyCanApply = computed(
  () =>
    !!strategySelected.value &&
    (strategySelected.value !== strategyCurrent.value || strategyRestart.value),
);

async function applyStrategy() {
  if (!selectedVpsId.value || !strategySelected.value) {
    return;
  }
  strategyApplying.value = true;
  try {
    const result = await vpsStore.setContainerStrategy(
      selectedVpsId.value,
      strategyContainerName.value,
      strategySelected.value,
      strategyRestart.value,
    );
    handleActionToast(`Strategy — ${strategyContainerName.value}`, result.message, result.ok);
    if (result.ok) {
      strategyModalVisible.value = false;
    }
  } catch (error) {
    handleActionToast(`Strategy — ${strategyContainerName.value}`, String(error), false);
  } finally {
    strategyApplying.value = false;
  }
}

function containerActionItems(container: VpsContainer): DropdownMenuItem[][] {
  const groups: DropdownMenuItem[][] = [
    [
      {
        label: 'Start',
        icon: 'i-mdi-play',
        color: 'success',
        onSelect: () => handleStart(container.container_name),
      },
      {
        label: 'Restart',
        icon: 'i-mdi-restart',
        onSelect: () => handleRestart(container.container_name),
      },
      {
        label: 'Stop',
        icon: 'i-mdi-stop',
        color: 'error',
        onSelect: () => handleStop(container.container_name),
      },
    ],
    [
      {
        label: 'Logs',
        icon: 'i-mdi-text-box-outline',
        onSelect: () => openLogs(container.container_name),
      },
      {
        label: container.enabled ? 'Disable' : 'Enable',
        icon: container.enabled ? 'i-mdi-eye-off' : 'i-mdi-eye',
        color: container.enabled ? 'warning' : 'success',
        onSelect: () => handleToggleEnabled(container.container_name, container.enabled),
      },
    ],
  ];
  if (container.is_freqtrade) {
    groups.push([
      {
        label: 'Change strategy',
        icon: 'i-mdi-swap-horizontal',
        onSelect: () => openStrategyModal(container.container_name),
      },
      {
        label: 'Purge DWH',
        icon: 'i-mdi-delete-sweep',
        color: 'error',
        onSelect: () => handlePurgeDwh(container.container_name, container.enabled),
      },
    ]);
  }
  return groups;
}

async function refreshLogs() {
  if (!selectedVpsId.value || !selectedContainerName.value) {
    return;
  }
  logsLoading.value = true;
  try {
    const result = await vpsStore.loadContainerLogs(
      selectedVpsId.value,
      selectedContainerName.value,
      200,
    );
    logsText.value = result.logs;
  } catch (error) {
    logsText.value = '[Error] Failed to fetch logs. Check VPS connectivity.';
  } finally {
    logsLoading.value = false;
  }
}

onMounted(async () => {
  await loadServers();
  await loadAudit();
  connectStatusStream();
  startPollingFallback();
});

onBeforeUnmount(() => {
  if (statusEventSource) {
    statusEventSource.close();
    statusEventSource = null;
  }
  stopPollingFallback();
});
</script>

<template>
  <div class="mx-auto mt-3 p-4 w-[98vw] max-w-[98vw] flex flex-col gap-4">
    <UCard>
      <template #header>
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="font-semibold">VPS Manager</span>
            <div class="flex items-center gap-2 flex-wrap">
              <USelect
                :model-value="selectedActor"
                :items="actorOptions"
                size="sm"
                class="min-w-36"
                @update:model-value="handleActorChange"
              />
              <UBadge
                v-for="permission in actorPermissionBadges"
                :key="permission"
                :label="permission"
                :color="permissionColor(permission)"
                variant="subtle"
              />
              <UBadge
                :label="streamStatusText"
                :color="streamConnected ? 'success' : 'warning'"
                variant="subtle"
              />
              <UButton
                label="Refresh"
                color="neutral"
                variant="outline"
                @click="
                  () => {
                    loadServers();
                    loadAudit();
                  }
                "
              />
              <UButton label="Add VPS" @click="showOnboardDialog = true" />
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span>Legend:</span>
            <UBadge label="read" color="info" variant="subtle" />
            <UBadge label="manage" color="warning" variant="subtle" />
            <UBadge label="admin" color="error" variant="subtle" />
          </div>
        </div>
      </template>
      <VpsTable
        :items="vpsStore.servers"
        :loading="vpsStore.loadingServers || vpsStore.actionLoading"
        @test="handleTest"
        @check-docker="handleCheckDocker"
        @discover="handleDiscover"
        @start-all="handleStartAll"
        @restart-all="handleRestartAll"
        @stop-all="handleStopAll"
        @reboot-vps="handleRebootVps"
        @show-containers="handleShowContainers"
        @edit="handleEdit"
        @delete="handleDelete"
      />
    </UCard>

    <UCard v-if="selectedVpsId">
      <template #header>
        <div class="font-semibold">Containers — {{ selectedVps?.name }}</div>
      </template>
      <div class="overflow-auto border border-surface-500 rounded-sm">
        <table class="w-full text-left border-collapse text-sm">
          <thead class="bg-surface-100 dark:bg-surface-800">
            <tr class="border-b border-surface-500">
              <th class="p-2 font-semibold">Container</th>
              <th class="p-2 font-semibold">Image</th>
              <th class="p-2 font-semibold">Status</th>
              <th class="p-2 font-semibold">Strategy</th>
              <th class="p-2 font-semibold">Freqtrade</th>
              <th class="p-2 font-semibold">Mismatch</th>
              <th class="p-2 font-semibold">Enabled</th>
              <th class="p-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="container in selectedContainers"
              :key="container.id"
              class="border-b border-surface-500"
            >
              <td class="p-2 align-middle">{{ container.container_name }}</td>
              <td class="p-2 align-middle">{{ container.image }}</td>
              <td class="p-2 align-middle">{{ container.status }}</td>
              <td class="p-2 align-middle font-mono text-xs">{{ container.strategy ?? '—' }}</td>
              <td class="p-2 align-middle">
                <UBadge
                  :label="container.is_freqtrade ? 'Yes' : 'No'"
                  :color="container.is_freqtrade ? 'success' : 'neutral'"
                  variant="subtle"
                />
              </td>
              <td class="p-2 align-middle">
                <UBadge
                  :label="container.config_mismatch ? 'Mismatch' : 'No mismatch'"
                  :color="container.config_mismatch ? 'warning' : 'success'"
                  variant="subtle"
                />
              </td>
              <td class="p-2 align-middle">
                <UBadge
                  :label="container.enabled ? 'Active' : 'Disabled'"
                  :color="container.enabled ? 'success' : 'neutral'"
                  variant="subtle"
                />
              </td>
              <td class="p-2 align-middle">
                <UDropdownMenu :items="containerActionItems(container)" size="sm" :modal="false">
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="outline"
                    square
                    icon="i-mdi-dots-vertical"
                    title="Actions"
                  />
                </UDropdownMenu>
              </td>
            </tr>
            <tr v-if="!selectedContainers.length">
              <td colspan="8" class="p-3 text-center text-surface-400">No containers</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-semibold">Recent Audit</span>
          <div class="flex flex-wrap items-center gap-2">
            <USelect
              v-model="selectedAuditTime"
              :items="auditTimeOptions"
              size="sm"
              class="min-w-40"
            />
            <USelect
              v-model="selectedAuditActor"
              :items="auditActorOptions"
              size="sm"
              class="min-w-36"
            />
            <USelect
              v-model="selectedAuditResult"
              :items="auditResultOptions"
              size="sm"
              class="min-w-36"
            />
            <USelect
              v-model="selectedAuditAction"
              :items="auditActionOptions"
              size="sm"
              class="min-w-44"
            />
            <USelect
              v-model="selectedAuditTargetId"
              :items="auditTargetIdOptions"
              size="sm"
              class="min-w-44"
            />
            <UButton
              label="Refresh Audit"
              size="sm"
              color="neutral"
              variant="outline"
              :loading="vpsStore.loadingAudit"
              @click="loadAudit"
            />
          </div>
        </div>
      </template>
      <div class="overflow-auto border border-surface-500 rounded-sm max-h-96">
        <table class="w-full text-left border-collapse text-sm">
          <thead class="bg-surface-100 dark:bg-surface-800 sticky top-0">
            <tr class="border-b border-surface-500">
              <th class="p-2 w-44 font-semibold">Time</th>
              <th class="p-2 w-24 font-semibold">Actor</th>
              <th class="p-2 w-28 font-semibold">Source IP</th>
              <th class="p-2 w-48 font-semibold">Action</th>
              <th class="p-2 w-20 font-semibold">Target</th>
              <th class="p-2 w-32 font-semibold">Target ID</th>
              <th class="p-2 w-24 font-semibold text-center">Result</th>
              <th class="p-2 font-semibold">Message</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in filteredAuditEntries"
              :key="entry.id"
              class="border-b border-surface-500"
            >
              <td class="p-2 align-top whitespace-normal break-words">
                {{ timestampmsWithTimezone(new Date(entry.created_at)) }}
              </td>
              <td class="p-2 align-top whitespace-nowrap">{{ entry.actor }}</td>
              <td class="p-2 align-top whitespace-nowrap">{{ entry.source_ip }}</td>
              <td class="p-2 align-top whitespace-normal break-words">{{ entry.action }}</td>
              <td class="p-2 align-top whitespace-nowrap">{{ entry.target_type }}</td>
              <td class="p-2 align-top whitespace-normal break-words">
                {{ resolveAuditTarget(entry) }}
              </td>
              <td class="p-2 align-top text-center">
                <UBadge
                  :label="entry.result"
                  :color="entry.result === 'success' ? 'success' : 'error'"
                  variant="subtle"
                />
              </td>
              <td class="p-2 align-top whitespace-normal break-words">
                {{ entry.message || '—' }}
              </td>
            </tr>
            <tr v-if="vpsStore.loadingAudit && !filteredAuditEntries.length">
              <td colspan="8" class="p-3 text-center text-surface-400">Loading...</td>
            </tr>
            <tr v-else-if="!filteredAuditEntries.length">
              <td colspan="8" class="p-3 text-center text-surface-400">No audit entries</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <VpsOnboardDialog
      v-model:visible="showOnboardDialog"
      :loading="vpsStore.actionLoading"
      @submit="handleAddServer"
    />

    <VpsOnboardDialog
      v-model:visible="showEditDialog"
      mode="edit"
      :initial-values="editingVps || undefined"
      :loading="vpsStore.actionLoading"
      @submit="handleEditServer"
    />

    <VpsLogsPanel
      v-model:visible="logsVisible"
      :title="`Logs — ${selectedContainerName}`"
      :logs="logsText"
      :loading="logsLoading"
      @refresh="refreshLogs"
    />

    <UModal
      v-model:open="strategyModalVisible"
      :title="`Change strategy — ${strategyContainerName}`"
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <div v-if="strategyLoading" class="flex items-center gap-2 text-sm text-surface-400">
            <UIcon name="i-lucide-loader-circle" class="animate-spin" />
            Loading available strategies…
          </div>
          <template v-else>
            <div class="text-sm">
              Current strategy:
              <span class="font-mono">{{ strategyCurrent ?? '—' }}</span>
            </div>
            <USelect
              v-model="strategySelected"
              :items="strategyOptions"
              placeholder="Select a strategy"
            />
            <UCheckbox v-model="strategyRestart" label="Restart bot now to apply" />
            <UAlert
              v-if="!strategyRestart"
              color="warning"
              variant="subtle"
              title="Restart required"
              description="The new strategy is written to the config but only takes effect after the bot restarts."
            />
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton
            label="Cancel"
            color="neutral"
            variant="outline"
            @click="strategyModalVisible = false"
          />
          <UButton
            label="Apply"
            :loading="strategyApplying"
            :disabled="strategyLoading || !strategyCanApply"
            @click="applyStrategy"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
