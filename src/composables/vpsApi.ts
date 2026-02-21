import axios from 'axios';

import type {
  AuditLogEntry,
  VpsActionResult,
  VpsContainer,
  VpsContainerAuthHint,
  VpsCreatePayload,
  VpsUpdatePayload,
  VpsDiscoverResult,
  VpsDockerCheckResult,
  VpsLogsResult,
  VpsOpenTradesSummary,
  VpsServer,
} from '@/types/vps';

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function resolveControlPlaneBaseUrl(): string {
  const configured = String(import.meta.env.VITE_CONTROL_PLANE_URL || '').trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (typeof window !== 'undefined' && isLoopbackHost(parsed.hostname) && !isLoopbackHost(window.location.hostname)) {
        const protocol = parsed.protocol || window.location.protocol;
        const port = parsed.port || '8000';
        return `${protocol}//${window.location.hostname}:${port}`;
      }
      return parsed.origin;
    } catch {
      return configured;
    }
  }

  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }

  return 'http://127.0.0.1:8000';
}

const controlPlaneBaseUrl = resolveControlPlaneBaseUrl();
const controlPlaneAdminToken = import.meta.env.VITE_CONTROL_PLANE_ADMIN_TOKEN || 'change-me';
const ACTOR_STORAGE_KEY = 'vps_control_plane_actor';
const actorOptions = ['admin', 'operator', 'readonly'] as const;
type ControlPlaneActor = (typeof actorOptions)[number];
const actorPermissionLabels: Record<ControlPlaneActor, string[]> = {
  admin: ['vps:manage', 'bot:manage', 'logs:read', 'system:admin'],
  operator: ['vps:read', 'bot:manage', 'logs:read'],
  readonly: ['vps:read', 'bot:read', 'logs:read'],
};

function normalizeActor(value: string): ControlPlaneActor {
  const candidate = value.trim().toLowerCase();
  if (candidate === 'operator' || candidate === 'readonly') {
    return candidate;
  }
  return 'admin';
}

function readStoredActor(): ControlPlaneActor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const stored = window.localStorage.getItem(ACTOR_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  return normalizeActor(stored);
}

let controlPlaneActor: ControlPlaneActor = normalizeActor(import.meta.env.VITE_CONTROL_PLANE_ACTOR || 'admin');
const storedActor = readStoredActor();
if (storedActor) {
  controlPlaneActor = storedActor;
}

export function getControlPlaneBaseUrl() {
  return controlPlaneBaseUrl;
}

export function getControlPlaneAdminToken() {
  return controlPlaneAdminToken;
}

export function getControlPlaneActor() {
  return controlPlaneActor;
}

export function getControlPlaneActorOptions(): ControlPlaneActor[] {
  return [...actorOptions];
}

export function getControlPlaneActorPermissions(actor: string = getControlPlaneActor()): string[] {
  return [...actorPermissionLabels[normalizeActor(actor)]];
}

export function setControlPlaneActor(actor: string) {
  controlPlaneActor = normalizeActor(actor);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(ACTOR_STORAGE_KEY, controlPlaneActor);
  }
}

export function getVpsStatusStreamUrl() {
  const token = encodeURIComponent(controlPlaneAdminToken);
  const actor = encodeURIComponent(getControlPlaneActor());
  return `${controlPlaneBaseUrl}/api/v1/stream/status?admin_token=${token}&actor=${actor}`;
}

const vpsApiClient = axios.create({
  baseURL: `${controlPlaneBaseUrl}/api/v1`,
  timeout: 30000,
});

vpsApiClient.interceptors.request.use((config) => {
  config.headers.set('X-Admin-Token', controlPlaneAdminToken);
  config.headers.set('X-Actor', getControlPlaneActor());
  return config;
});

export const vpsApi = {
  async listVps(): Promise<VpsServer[]> {
    const { data } = await vpsApiClient.get<VpsServer[]>('/vps');
    return data;
  },
  async createVps(payload: VpsCreatePayload): Promise<VpsServer> {
    const { data } = await vpsApiClient.post<VpsServer>('/vps', payload);
    return data;
  },
  async deleteVps(vpsId: number): Promise<void> {
    await vpsApiClient.delete(`/vps/${vpsId}`);
  },
  async reorderVps(orderedIds: number[]): Promise<void> {
    await vpsApiClient.post('/vps/reorder', { ordered_ids: orderedIds });
  },
  async updateVps(vpsId: number, payload: VpsUpdatePayload): Promise<VpsServer> {
    const { data } = await vpsApiClient.patch<VpsServer>(`/vps/${vpsId}`, payload);
    return data;
  },
  async testVps(vpsId: number): Promise<VpsActionResult> {
    const { data } = await vpsApiClient.post<VpsActionResult>(`/vps/${vpsId}/test`);
    return data;
  },
  async checkDocker(vpsId: number): Promise<VpsDockerCheckResult> {
    const { data } = await vpsApiClient.post<VpsDockerCheckResult>(`/vps/${vpsId}/check-docker`);
    return data;
  },
  async discover(vpsId: number): Promise<VpsDiscoverResult> {
    const { data } = await vpsApiClient.post<VpsDiscoverResult>(`/vps/${vpsId}/discover`);
    return data;
  },
  async containers(vpsId: number): Promise<VpsContainer[]> {
    const { data } = await vpsApiClient.get<VpsContainer[]>(`/vps/${vpsId}/containers`);
    return data;
  },
  async openTradesSummary(vpsId: number): Promise<VpsOpenTradesSummary> {
    const { data } = await vpsApiClient.get<VpsOpenTradesSummary>(`/vps/${vpsId}/open-trades`);
    return data;
  },
  async startContainer(vpsId: number, containerName: string): Promise<VpsActionResult> {
    const { data } = await vpsApiClient.post<VpsActionResult>(
      `/vps/${vpsId}/containers/${encodeURIComponent(containerName)}/start`,
    );
    return data;
  },
  async restartContainer(vpsId: number, containerName: string): Promise<VpsActionResult> {
    const { data } = await vpsApiClient.post<VpsActionResult>(
      `/vps/${vpsId}/containers/${encodeURIComponent(containerName)}/restart`,
    );
    return data;
  },
  async stopContainer(vpsId: number, containerName: string): Promise<VpsActionResult> {
    const { data } = await vpsApiClient.post<VpsActionResult>(
      `/vps/${vpsId}/containers/${encodeURIComponent(containerName)}/stop`,
    );
    return data;
  },
  async containerLogs(vpsId: number, containerName: string, tail = 200): Promise<VpsLogsResult> {
    const { data } = await vpsApiClient.get<VpsLogsResult>(
      `/vps/${vpsId}/containers/${encodeURIComponent(containerName)}/logs`,
      { params: { tail } },
    );
    return data;
  },
  async containerAuthHint(vpsId: number, containerName: string): Promise<VpsContainerAuthHint> {
    const { data } = await vpsApiClient.get<VpsContainerAuthHint>(
      `/vps/${vpsId}/containers/${encodeURIComponent(containerName)}/auth-hint`,
    );
    return data;
  },
  async audit(limit = 100): Promise<AuditLogEntry[]> {
    const { data } = await vpsApiClient.get<AuditLogEntry[]>('/audit', { params: { limit } });
    return data;
  },
};
