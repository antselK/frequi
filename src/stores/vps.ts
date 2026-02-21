import axios from 'axios';

import type {
  AuditLogEntry,
  VpsActionResult,
  VpsContainer,
  VpsCreatePayload,
  VpsDiscoverResult,
  VpsDockerCheckResult,
  VpsLogsResult,
  VpsStatusStreamPayload,
  VpsServer,
  VpsUpdatePayload,
} from '@/types/vps';
import { vpsApi } from '@/composables/vpsApi';

export const useVpsStore = defineStore('vpsStore', {
  state: () => {
    return {
      servers: [] as VpsServer[],
      auditEntries: [] as AuditLogEntry[],
      containersByVps: {} as Record<number, VpsContainer[]>,
      loadingServers: false,
      loadingContainers: false,
      loadingAudit: false,
      actionLoading: false,
      lastError: '',
    };
  },
  getters: {
    hasServers: (state) => state.servers.length > 0,
    getContainersForVps: (state) => {
      return (vpsId: number) => state.containersByVps[vpsId] || [];
    },
  },
  actions: {
    applyStatusSnapshot(snapshot: VpsStatusStreamPayload) {
      this.servers = snapshot.vps;
    },
    setError(error: unknown) {
      if (axios.isAxiosError(error)) {
        const detail = error.response?.data?.detail;
        if (typeof detail === 'string' && detail.trim()) {
          this.lastError = detail;
          return this.lastError;
        }
      }

      this.lastError = error instanceof Error ? error.message : String(error);
      return this.lastError;
    },
    async loadServers() {
      this.loadingServers = true;
      this.lastError = '';
      try {
        this.servers = await vpsApi.listVps();
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.loadingServers = false;
      }
    },
    async loadAudit(limit = 100) {
      this.loadingAudit = true;
      this.lastError = '';
      try {
        this.auditEntries = await vpsApi.audit(limit);
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.loadingAudit = false;
      }
    },
    async addServer(payload: VpsCreatePayload) {
      this.actionLoading = true;
      this.lastError = '';
      try {
        await vpsApi.createVps(payload);
        await this.loadServers();
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async deleteServer(vpsId: number) {
      this.actionLoading = true;
      this.lastError = '';
      try {
        await vpsApi.deleteVps(vpsId);
        await this.loadServers();
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async updateServer(vpsId: number, payload: VpsUpdatePayload) {
      this.actionLoading = true;
      this.lastError = '';
      try {
        await vpsApi.updateVps(vpsId, payload);
        await this.loadServers();
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async reorderServers(orderedIds: number[]) {
      this.actionLoading = true;
      this.lastError = '';
      try {
        await vpsApi.reorderVps(orderedIds);
        await this.loadServers();
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async testServer(vpsId: number): Promise<VpsActionResult> {
      this.actionLoading = true;
      this.lastError = '';
      try {
        const result = await vpsApi.testVps(vpsId);
        await this.loadServers();
        return result;
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async checkDocker(vpsId: number): Promise<VpsDockerCheckResult> {
      this.actionLoading = true;
      this.lastError = '';
      try {
        const result = await vpsApi.checkDocker(vpsId);
        await this.loadServers();
        return result;
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async discover(vpsId: number): Promise<VpsDiscoverResult> {
      this.actionLoading = true;
      this.lastError = '';
      try {
        const result = await vpsApi.discover(vpsId);
        await Promise.all([this.loadServers(), this.loadContainers(vpsId)]);
        return result;
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async loadContainers(vpsId: number) {
      this.loadingContainers = true;
      this.lastError = '';
      try {
        this.containersByVps[vpsId] = await vpsApi.containers(vpsId);
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.loadingContainers = false;
      }
    },
    async startContainer(vpsId: number, containerName: string): Promise<VpsActionResult> {
      this.actionLoading = true;
      this.lastError = '';
      try {
        const result = await vpsApi.startContainer(vpsId, containerName);
        await this.loadContainers(vpsId);
        await this.loadServers();
        return result;
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async restartContainer(vpsId: number, containerName: string): Promise<VpsActionResult> {
      this.actionLoading = true;
      this.lastError = '';
      try {
        const result = await vpsApi.restartContainer(vpsId, containerName);
        await this.loadContainers(vpsId);
        await this.loadServers();
        return result;
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async stopContainer(vpsId: number, containerName: string): Promise<VpsActionResult> {
      this.actionLoading = true;
      this.lastError = '';
      try {
        const result = await vpsApi.stopContainer(vpsId, containerName);
        await this.loadContainers(vpsId);
        await this.loadServers();
        return result;
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
    async loadContainerLogs(vpsId: number, containerName: string, tail = 200): Promise<VpsLogsResult> {
      this.actionLoading = true;
      this.lastError = '';
      try {
        return await vpsApi.containerLogs(vpsId, containerName, tail);
      } catch (error) {
        this.setError(error);
        throw error;
      } finally {
        this.actionLoading = false;
      }
    },
  },
});
