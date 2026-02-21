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

const sortKey = ref<'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error'>('name');
const sortDirection = ref<'asc' | 'desc'>('asc');

function severityByStatus(status: string) {
  if (status === 'online') {
    return 'success';
  }
  if (status === 'offline') {
    return 'danger';
  }
  return 'warn';
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

function sortableValue(item: VpsServer, key: 'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error'): string | number {
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

function toggleSort(key: 'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error') {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
    return;
  }
  sortKey.value = key;
  sortDirection.value = 'asc';
}

function sortIndicator(key: 'name' | 'ip' | 'ssh_user' | 'ssh_port' | 'status' | 'docker' | 'last_error') {
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

    return String(leftValue).localeCompare(String(rightValue), undefined, {
      numeric: true,
      sensitivity: 'base',
    }) * direction;
  });
});
</script>

<template>
  <div class="overflow-auto border border-surface-500 rounded-sm">
    <table class="w-full text-left border-collapse">
      <thead>
        <tr class="border-b border-surface-500">
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('name')">Name{{ sortIndicator('name') }}</button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('ip')">IP{{ sortIndicator('ip') }}</button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('ssh_user')">
              SSH User{{ sortIndicator('ssh_user') }}
            </button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('ssh_port')">Port{{ sortIndicator('ssh_port') }}</button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('status')">Status{{ sortIndicator('status') }}</button>
          </th>
          <th class="p-2">
            <button type="button" class="font-semibold" @click="toggleSort('docker')">Docker{{ sortIndicator('docker') }}</button>
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
        <tr
          v-for="item in sortedItems"
          :key="item.id"
          class="border-b border-surface-500"
        >
          <td class="p-2 align-middle">{{ item.name }}</td>
          <td class="p-2 align-middle">{{ item.ip }}</td>
          <td class="p-2 align-middle">{{ item.ssh_user }}</td>
          <td class="p-2 align-middle">{{ item.ssh_port }}</td>
          <td class="p-2 align-middle">
            <Tag :value="item.status" :severity="severityByStatus(item.status)" />
          </td>
          <td class="p-2 align-middle">
            <Tag v-if="item.docker_available === true" value="Yes" severity="success" />
            <Tag v-else-if="item.docker_available === false" value="No" severity="danger" />
            <Tag v-else value="Unknown" severity="warn" />
          </td>
          <td class="p-2 align-middle">{{ item.last_error || '' }}</td>
          <td class="p-2 align-middle">
            <div class="flex flex-wrap gap-1">
              <Button size="small" severity="secondary" outlined title="Test SSH connection" @click="emit('test', item)">
                <template #icon>
                  <i-mdi-lan-connect />
                </template>
              </Button>
              <Button size="small" severity="secondary" outlined title="Check Docker availability" @click="emit('checkDocker', item)">
                <template #icon>
                  <i-mdi-docker />
                </template>
              </Button>
              <Button size="small" severity="secondary" outlined title="Discover running containers" @click="emit('discover', item)">
                <template #icon>
                  <i-mdi-magnify />
                </template>
              </Button>
              <Button size="small" severity="success" outlined title="Start discovered containers" @click="emit('startAll', item)">
                <template #icon>
                  <i-mdi-play />
                </template>
              </Button>
              <Button size="small" severity="secondary" outlined title="Restart discovered containers" @click="emit('restartAll', item)">
                <template #icon>
                  <i-mdi-restart />
                </template>
              </Button>
              <Button size="small" severity="danger" outlined title="Stop discovered containers" @click="emit('stopAll', item)">
                <template #icon>
                  <i-mdi-stop />
                </template>
              </Button>
              <Button size="small" title="Show containers" @click="emit('showContainers', item)">
                <template #icon>
                  <i-mdi-view-list />
                </template>
              </Button>
              <Button size="small" severity="secondary" outlined title="Edit VPS" @click="emit('edit', item)">
                <template #icon>
                  <i-mdi-pencil />
                </template>
              </Button>
              <Button size="small" severity="danger" outlined title="Delete VPS" @click="emit('delete', item)">
                <template #icon>
                  <i-mdi-delete />
                </template>
              </Button>
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
