<script setup lang="ts">
import type { VpsServer } from '@/types/vps';

const props = defineProps<{
  items: VpsServer[];
  loading?: boolean;
}>();

const emit = defineEmits<{
  (event: 'test', item: VpsServer): void;
  (event: 'checkDocker', item: VpsServer): void;
  (event: 'discover', item: VpsServer): void;
  (event: 'startAll', item: VpsServer): void;
  (event: 'restartAll', item: VpsServer): void;
  (event: 'stopAll', item: VpsServer): void;
  (event: 'showContainers', item: VpsServer): void;
  (event: 'edit', item: VpsServer): void;
  (event: 'delete', item: VpsServer): void;
}>();

const sortKey = ref<'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error'>(
  'name',
);
const sortDirection = ref<'asc' | 'desc'>('asc');

function colorByStatus(status: string) {
  if (status === 'online') {
    return 'success';
  }
  if (status === 'offline') {
    return 'error';
  }
  return 'warning';
}

function dockerSortValue(item: VpsServer): string {
  if (item.docker_available === true) {
    return 'yes';
  }
  if (item.docker_available === false) {
    return 'no';
  }
  return 'unknown';
}

function sortableValue(
  item: VpsServer,
  key: 'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error',
): string | number {
  if (key === 'ssh_port') {
    return item.ssh_port;
  }
  if (key === 'docker') {
    return dockerSortValue(item);
  }
  if (key === 'last_error') {
    return item.last_error || '';
  }
  return item[key] || '';
}

function toggleSort(
  key: 'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error',
) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
    return;
  }
  sortKey.value = key;
  sortDirection.value = 'asc';
}

function sortIndicator(
  key: 'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error',
) {
  if (sortKey.value !== key) {
    return '';
  }
  return sortDirection.value === 'asc' ? ' ↑' : ' ↓';
}

const sortedItems = computed(() => {
  const direction = sortDirection.value === 'asc' ? 1 : -1;
  return [...props.items].sort((left, right) => {
    const leftValue = sortableValue(left, sortKey.value);
    const rightValue = sortableValue(right, sortKey.value);

    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * direction;
    }

    return (
      String(leftValue).localeCompare(String(rightValue), undefined, {
        numeric: true,
        sensitivity: 'base',
      }) * direction
    );
  });
});
</script>

<template>
  <div class="overflow-auto border border-surface-500 rounded-sm">
    <table class="w-full text-left border-collapse">
      <thead>
        <tr class="border-b border-surface-500">
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('name')">
              Name{{ sortIndicator('name') }}
            </button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('ip')">
              IP{{ sortIndicator('ip') }}
            </button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('ssh_user')">
              SSH User{{ sortIndicator('ssh_user') }}
            </button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('ssh_port')">
              Port{{ sortIndicator('ssh_port') }}
            </button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('status')">
              Status{{ sortIndicator('status') }}
            </button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('docker')">
              Docker{{ sortIndicator('docker') }}
            </button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('last_error')">
              Last Error{{ sortIndicator('last_error') }}
            </button>
          </th>
          <th class="p-2 min-w-[220px]">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in sortedItems" :key="item.id" class="border-b border-surface-500">
          <td class="p-2 align-middle">{{ item.name }}</td>
          <td class="p-2 align-middle">{{ item.ip }}</td>
          <td class="p-2 align-middle">{{ item.ssh_user }}</td>
          <td class="p-2 align-middle">{{ item.ssh_port }}</td>
          <td class="p-2 align-middle">
            <UBadge :label="item.status" :color="colorByStatus(item.status)" variant="subtle" />
          </td>
          <td class="p-2 align-middle">
            <UBadge
              v-if="item.docker_available === true"
              label="Yes"
              color="success"
              variant="subtle"
            />
            <UBadge
              v-else-if="item.docker_available === false"
              label="No"
              color="error"
              variant="subtle"
            />
            <UBadge v-else label="Unknown" color="warning" variant="subtle" />
          </td>
          <td class="p-2 align-middle">{{ item.last_error || '' }}</td>
          <td class="p-2 align-middle">
            <div class="flex flex-wrap gap-1">
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                square
                icon="i-mdi-lan-connect"
                title="Test SSH connection"
                @click="emit('test', item)"
              />
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                square
                icon="i-mdi-docker"
                title="Check Docker availability"
                @click="emit('checkDocker', item)"
              />
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                square
                icon="i-mdi-magnify"
                title="Discover running containers"
                @click="emit('discover', item)"
              />
              <UButton
                size="sm"
                color="success"
                variant="outline"
                square
                icon="i-mdi-play"
                title="Start discovered containers"
                @click="emit('startAll', item)"
              />
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                square
                icon="i-mdi-restart"
                title="Restart discovered containers"
                @click="emit('restartAll', item)"
              />
              <UButton
                size="sm"
                color="error"
                variant="outline"
                square
                icon="i-mdi-stop"
                title="Stop discovered containers"
                @click="emit('stopAll', item)"
              />
              <UButton
                size="sm"
                square
                icon="i-mdi-view-list"
                title="Show containers"
                @click="emit('showContainers', item)"
              />
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                square
                icon="i-mdi-pencil"
                title="Edit VPS"
                @click="emit('edit', item)"
              />
              <UButton
                size="sm"
                color="error"
                variant="outline"
                square
                icon="i-mdi-delete"
                title="Delete VPS"
                @click="emit('delete', item)"
              />
            </div>
          </td>
        </tr>
        <tr v-if="loading">
          <td colspan="8" class="p-3 text-center text-surface-400">Loading...</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
