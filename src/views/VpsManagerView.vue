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
const logsVisible = ref(false);
const selectedContainerName = ref('');
const logsText = ref('');
const logsLoading = ref(false);
const streamConnected = ref(false);
const streamStatusText = computed(() => (streamConnected.value ? 'Live' : 'Polling'));
const actorOptions = getControlPlaneActorOptions();
const selectedActor = ref(getControlPlaneActor());
const actorPermissionBadges = computed(() => getControlPlaneActorPermissions(selectedActor.value));
let statusEventSource: EventSource | null = null;
let pollTimer: number | null = null;

function permissionSeverity(permission: string) {
  if (permission.endsWith(':admin')) {
    return 'danger';
  }
  if (permission.endsWith(':manage')) {
    return 'warn';
  }
  return 'info';
}

const selectedVps = computed(() => vpsStore.servers.find((item) => item.id === selectedVpsId.value));
const orderedServers = computed<VpsServer[]>(() => vpsStore.servers);
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
    const actorMatches = selectedAuditActor.value === 'all' || entry.actor === selectedAuditActor.value;
    const resultMatches = selectedAuditResult.value === 'all' || entry.result === selectedAuditResult.value;
    const actionMatches = selectedAuditAction.value === 'all' || entry.action === selectedAuditAction.value;
    const targetIdMatches = selectedAuditTargetId.value === 'all' || resolveAuditTarget(entry) === selectedAuditTargetId.value;
    const timeMatches = auditTimeMatches(entry.created_at, selectedAuditTime.value);
    return actorMatches && resultMatches && actionMatches && targetIdMatches && timeMatches;
  });
});

async function loadServers() {
  try {
    await vpsStore.loadServers();
  } catch (error) {
    toast.add({
      severity: 'error',
      summary: 'Load Failed',
      detail: String(error),
      life: 5000,
    });
  }
}

async function loadAudit() {
  try {
    await vpsStore.loadAudit(100);
  } catch (error) {
    toast.add({
      severity: 'error',
      summary: 'Audit Load Failed',
      detail: String(error),
      life: 5000,
    });
  }
}

function startPollingFallback() {
  if (pollTimer) {
    return;
  }
  pollTimer = window.setInterval(() => {
    loadServers();
    loadAudit();
    if (selectedVpsId.value) {
      vpsStore.loadContainers(selectedVpsId.value).catch(() => undefined);
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

  const streamUrl = getVpsStatusStreamUrl();
  const eventSource = new EventSource(streamUrl);
  statusEventSource = eventSource;

  eventSource.addEventListener('status', (event: MessageEvent) => {
    try {
      const payload = JSON.parse(event.data) as VpsStatusStreamPayload;
      vpsStore.applyStatusSnapshot(payload);
      streamConnected.value = true;
      stopPollingFallback();
    } catch {
      streamConnected.value = false;
      startPollingFallback();
    }
  });

  eventSource.onerror = () => {
    streamConnected.value = false;
    startPollingFallback();
  };
}

async function handleActorChange(newActorValue: string) {
  const actor = String(newActorValue || '').trim().toLowerCase();
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
    await vpsStore.loadContainers(selectedVpsId.value).catch(() => undefined);
  }

  handleActionToast('Actor Changed', `Using ${selectedActor.value}`);
}

function handleActionToast(summary: string, message: string, ok = true) {
  toast.add({
    severity: ok ? 'success' : 'warn',
    summary,
    detail: message,
    life: 5000,
  });
}

async function handleAddServer(payload: VpsCreatePayload) {
  try {
    await vpsStore.addServer(payload);
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

async function runContainerActionForVps(
  item: VpsServer,
  action: 'start' | 'restart' | 'stop',
) {
  try {
    await vpsStore.loadContainers(item.id);
    const containers = vpsStore.getContainersForVps(item.id);
    if (!containers.length) {
      handleActionToast(`${action} ${item.name}`, 'No discovered containers for this VPS.', false);
      return;
    }

    let okCount = 0;
    let failCount = 0;
    for (const container of containers) {
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
    }

    handleActionToast(
      `${action[0].toUpperCase()}${action.slice(1)} ${item.name}`,
      `Success: ${okCount}, Failed: ${failCount}`,
      failCount === 0,
    );
  } catch (error) {
    handleActionToast(`${action} ${item.name}`, String(error), false);
  }
}

async function handleStartAll(item: VpsServer) {
  await runContainerActionForVps(item, 'start');
}

async function handleRestartAll(item: VpsServer) {
  await runContainerActionForVps(item, 'restart');
}

async function handleStopAll(item: VpsServer) {
  await runContainerActionForVps(item, 'stop');
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
  try {
    const result = await vpsStore.stopContainer(selectedVpsId.value, containerName);
    handleActionToast(`Stop ${containerName}`, result.message, result.ok);
  } catch (error) {
    handleActionToast(`Stop ${containerName}`, String(error), false);
  }
}

async function handleToggleEnabled(containerName: string, currentEnabled: boolean) {
  if (!selectedVpsId.value) {
    return;
  }
  try {
    const result = await vpsStore.setContainerEnabled(selectedVpsId.value, containerName, !currentEnabled);
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

async function refreshLogs() {
  if (!selectedVpsId.value || !selectedContainerName.value) {
    return;
  }
  logsLoading.value = true;
  try {
    const result = await vpsStore.loadContainerLogs(selectedVpsId.value, selectedContainerName.value, 200);
    logsText.value = result.logs;
  } catch (error) {
    logsText.value = String(error);
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
    <Card>
      <template #title>
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span>VPS Manager</span>
            <div class="flex items-center gap-2">
              <Select
                :model-value="selectedActor"
                :options="actorOptions"
                size="small"
                class="min-w-36"
                @update:model-value="handleActorChange"
              />
              <Tag
                v-for="permission in actorPermissionBadges"
                :key="permission"
                :value="permission"
                :severity="permissionSeverity(permission)"
              />
              <Tag :value="streamStatusText" :severity="streamConnected ? 'success' : 'warn'" />
              <Button
                label="Refresh"
                severity="secondary"
                outlined
                @click="
                  () => {
                    loadServers();
                    loadAudit();
                  }
                "
              />
              <Button label="Add VPS" @click="showOnboardDialog = true" />
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span>Legend:</span>
            <Tag value="read" severity="info" />
            <Tag value="manage" severity="warn" />
            <Tag value="admin" severity="danger" />
          </div>
        </div>
      </template>
      <template #content>
        <VpsTable
          :items="orderedServers"
          :loading="vpsStore.loadingServers || vpsStore.actionLoading"
          @test="handleTest"
          @check-docker="handleCheckDocker"
          @discover="handleDiscover"
          @start-all="handleStartAll"
          @restart-all="handleRestartAll"
          @stop-all="handleStopAll"
          @show-containers="handleShowContainers"
          @edit="handleEdit"
          @delete="handleDelete"
        />
      </template>
    </Card>

    <Card>
      <template #title>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span>Recent Audit</span>
          <div class="flex flex-wrap items-center gap-2">
            <Select
              v-model="selectedAuditTime"
              :options="auditTimeOptions"
              size="small"
              class="min-w-40"
            />
            <Select
              v-model="selectedAuditActor"
              :options="auditActorOptions"
              size="small"
              class="min-w-36"
            />
            <Select
              v-model="selectedAuditResult"
              :options="auditResultOptions"
              size="small"
              class="min-w-36"
            />
            <Select
              v-model="selectedAuditAction"
              :options="auditActionOptions"
              size="small"
              class="min-w-44"
            />
            <Select
              v-model="selectedAuditTargetId"
              :options="auditTargetIdOptions"
              size="small"
              class="min-w-44"
            />
            <Button
              label="Refresh Audit"
              size="small"
              severity="secondary"
              outlined
              :loading="vpsStore.loadingAudit"
              @click="loadAudit"
            />
          </div>
        </div>
      </template>
      <template #content>
        <DataTable
          :value="filteredAuditEntries"
          data-key="id"
          size="small"
          show-gridlines
          scrollable
          scroll-height="24rem"
          table-style="table-layout: fixed; width: 100%"
          class="text-sm"
          :loading="vpsStore.loadingAudit"
        >
          <Column header="Time" header-style="width: 11rem" body-class="align-top whitespace-normal break-words">
            <template #body="slotProps">
              {{ timestampmsWithTimezone(new Date(slotProps.data.created_at)) }}
            </template>
          </Column>
          <Column field="actor" header="Actor" header-style="width: 6rem" body-class="align-top whitespace-nowrap" />
          <Column field="source_ip" header="Source IP" header-style="width: 7rem" body-class="align-top whitespace-nowrap" />
          <Column field="action" header="Action" header-style="width: 12rem" body-class="align-top whitespace-normal break-words" />
          <Column field="target_type" header="Target" header-style="width: 5rem" body-class="align-top whitespace-nowrap" />
          <Column header="Target ID" header-style="width: 8rem" body-class="align-top whitespace-normal break-words">
            <template #body="slotProps">
              {{ resolveAuditTarget(slotProps.data) }}
            </template>
          </Column>
          <Column header="Result" header-style="width: 6rem" body-class="align-top text-center">
            <template #body="slotProps">
              <Tag
                :value="slotProps.data.result"
                :severity="slotProps.data.result === 'success' ? 'success' : 'danger'"
              />
            </template>
          </Column>
          <Column field="message" header="Message" body-class="align-top whitespace-normal break-words">
            <template #body="slotProps">
              <span class="block whitespace-normal break-words">{{ slotProps.data.message || '—' }}</span>
            </template>
          </Column>
        </DataTable>
      </template>
    </Card>

    <Card v-if="selectedVpsId">
      <template #title>
        <div class="text-left">Containers — {{ selectedVps?.name }}</div>
      </template>
      <template #content>
        <DataTable
          :value="selectedContainers"
          data-key="id"
          size="small"
          show-gridlines
          :loading="vpsStore.loadingContainers || vpsStore.actionLoading"
        >
          <Column field="container_name" header="Container" />
          <Column field="image" header="Image" />
          <Column field="status" header="Status" />
          <Column header="Freqtrade">
            <template #body="slotProps">
              <Tag
                :value="slotProps.data.is_freqtrade ? 'Yes' : 'No'"
                :severity="slotProps.data.is_freqtrade ? 'success' : 'secondary'"
              />
            </template>
          </Column>
          <Column header="Mismatch">
            <template #body="slotProps">
              <Tag
                :value="slotProps.data.config_mismatch ? 'Mismatch' : 'No mismatch'"
                :severity="slotProps.data.config_mismatch ? 'warn' : 'success'"
              />
            </template>
          </Column>
          <Column header="Enabled">
            <template #body="slotProps">
              <Tag
                :value="slotProps.data.enabled ? 'Active' : 'Disabled'"
                :severity="slotProps.data.enabled ? 'success' : 'secondary'"
              />
            </template>
          </Column>
          <Column header="Actions" style="min-width: 240px">
            <template #body="slotProps">
              <div class="flex gap-2 flex-wrap">
                <Button
                  label="Start"
                  size="small"
                  severity="success"
                  outlined
                  @click="handleStart(slotProps.data.container_name)"
                />
                <Button
                  label="Restart"
                  size="small"
                  severity="secondary"
                  outlined
                  @click="handleRestart(slotProps.data.container_name)"
                />
                <Button
                  label="Stop"
                  size="small"
                  severity="danger"
                  outlined
                  @click="handleStop(slotProps.data.container_name)"
                />
                <Button
                  label="Logs"
                  size="small"
                  @click="openLogs(slotProps.data.container_name)"
                />
                <Button
                  :label="slotProps.data.enabled ? 'Disable' : 'Enable'"
                  size="small"
                  :severity="slotProps.data.enabled ? 'warn' : 'success'"
                  outlined
                  :title="slotProps.data.enabled ? 'Exclude from DWH ingestion and Console' : 'Include in DWH ingestion and Console'"
                  @click="handleToggleEnabled(slotProps.data.container_name, slotProps.data.enabled)"
                />
              </div>
            </template>
          </Column>
        </DataTable>
      </template>
    </Card>

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
  </div>
</template>
