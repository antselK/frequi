import axios from 'axios';

import type {
  AuditLogEntry,
  DwhAlertConfig,
  DwhAlertStatus,
  DwhAuditMessageList,
  DwhAuditMode,
  DwhAuditSummary,
  DwhLogCumulativePoint,
  DwhAnomaly,
  DwhAnomalySample,
  DwhAnomalyTrendPoint,
  DwhIngestionAsyncStart,
  DwhIngestionRun,
  DwhIngestionRunResult,
  DwhIngestionConfig,
  DwhIngestionUnstickResult,
  DwhRunAnomaly,
  DwhTradeList,
  DwhTradeQuery,
  DwhTradeTimeline,
  DwhIngestionStatus,
  DwhRetentionConfig,
  DwhRetentionRunResult,
  DwhRollupCompactionConfig,
  DwhRollupCompactionRunResult,
  DwhLogCaptureRule,
  DwhSummary,
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

function resolveControlPlaneBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  return 'http://127.0.0.1:3000';
}

const controlPlaneBaseUrl = resolveControlPlaneBaseUrl();
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
  const actor = encodeURIComponent(getControlPlaneActor());
  return `${controlPlaneBaseUrl}/api/v1/stream/status?actor=${actor}`;
}

const vpsApiClient = axios.create({
  baseURL: `${controlPlaneBaseUrl}/api/v1`,
  timeout: 30000,
});

vpsApiClient.interceptors.request.use((config) => {
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
  async dwhSummary(): Promise<DwhSummary> {
    const { data } = await vpsApiClient.get<DwhSummary>('/dwh/summary');
    return data;
  },
  async dwhAuditMode(): Promise<DwhAuditMode> {
    const { data } = await vpsApiClient.get<DwhAuditMode>('/dwh/audit-mode');
    return data;
  },
  async dwhAuditSummary(hours = 24, limit = 200, botId?: number): Promise<DwhAuditSummary> {
    const { data } = await vpsApiClient.get<DwhAuditSummary>('/dwh/audit/summary', {
      params: {
        hours,
        limit,
        bot_id: botId,
      },
    });
    return data;
  },
  async dwhAuditMessages(params: {
    hours?: number;
    bot_id?: number;
    logger?: string;
    level?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<DwhAuditMessageList> {
    const { data } = await vpsApiClient.get<DwhAuditMessageList>('/dwh/audit/messages', { params });
    return data;
  },
  async dwhLogsCumulative(params: {
    hours?: number;
    bot_id?: number;
    logger?: string;
    level?: string;
  } = {}): Promise<DwhLogCumulativePoint[]> {
    const { data } = await vpsApiClient.get<DwhLogCumulativePoint[]>('/dwh/reports/logs-cumulative', { params });
    return data;
  },
  async dwhAuditRules(): Promise<DwhLogCaptureRule[]> {
    const { data } = await vpsApiClient.get<DwhLogCaptureRule[]>('/dwh/audit/rules');
    return data;
  },
  async upsertDwhAuditRule(payload: {
    logger_name?: string;
    level?: string;
    rule_type?: 'include' | 'exclude';
    enabled?: boolean;
  }): Promise<DwhLogCaptureRule> {
    const { data } = await vpsApiClient.post<DwhLogCaptureRule>('/dwh/audit/rules', payload);
    return data;
  },
  async deleteDwhAuditRule(ruleId: number): Promise<void> {
    await vpsApiClient.delete(`/dwh/audit/rules/${ruleId}`);
  },
  async runDwhIngestion(): Promise<DwhIngestionRunResult> {
    const { data } = await vpsApiClient.post<DwhIngestionRunResult>(
      '/dwh/ingestion/run',
      undefined,
      { timeout: 180000 },
    );
    return data;
  },
  async runDwhIngestionAsync(): Promise<DwhIngestionAsyncStart> {
    const { data } = await vpsApiClient.post<DwhIngestionAsyncStart>('/dwh/ingestion/run-async');
    return data;
  },
  async unstickDwhIngestion(staleMinutes = 15, force = false): Promise<DwhIngestionUnstickResult> {
    const { data } = await vpsApiClient.post<DwhIngestionUnstickResult>('/dwh/ingestion/unstick', undefined, {
      params: { stale_minutes: staleMinutes, force },
    });
    return data;
  },
  async dwhIngestionConfig(): Promise<DwhIngestionConfig> {
    const { data } = await vpsApiClient.get<DwhIngestionConfig>('/dwh/ingestion/config');
    return data;
  },
  async updateDwhIngestionConfig(payload: { log_fetch_timeout_seconds: number }): Promise<DwhIngestionConfig> {
    const { data } = await vpsApiClient.post<DwhIngestionConfig>('/dwh/ingestion/config', payload);
    return data;
  },
  async dwhIngestionStatus(): Promise<DwhIngestionStatus> {
    const { data } = await vpsApiClient.get<DwhIngestionStatus>('/dwh/ingestion/status');
    return data;
  },
  async dwhIngestionRuns(limit = 20): Promise<DwhIngestionRun[]> {
    const { data } = await vpsApiClient.get<DwhIngestionRun[]>('/dwh/ingestion/runs', { params: { limit } });
    return data;
  },
  async dwhRunAnomalies(runId: number, limit = 20): Promise<DwhRunAnomaly[]> {
    const { data } = await vpsApiClient.get<DwhRunAnomaly[]>(`/dwh/ingestion/runs/${runId}/anomalies`, {
      params: { limit },
    });
    return data;
  },
  async runDwhRetention(days = 180): Promise<DwhRetentionRunResult> {
    const { data } = await vpsApiClient.post<DwhRetentionRunResult>('/dwh/retention/run', undefined, {
      params: { days },
      timeout: 120000,
    });
    return data;
  },
  async dwhRetentionConfig(): Promise<DwhRetentionConfig> {
    const { data } = await vpsApiClient.get<DwhRetentionConfig>('/dwh/retention/config');
    return data;
  },
  async dwhTrades(params: DwhTradeQuery = {}): Promise<DwhTradeList> {
    const { data } = await vpsApiClient.get<DwhTradeList>('/dwh/trades', { params });
    return data;
  },
  async dwhTradeTimeline(tradeId: number, limit = 200): Promise<DwhTradeTimeline> {
    const { data } = await vpsApiClient.get<DwhTradeTimeline>(`/dwh/trades/${tradeId}/timeline`, {
      params: { limit },
    });
    return data;
  },
  async dwhAnomalies(days = 30, limit = 50, botId?: number): Promise<DwhAnomaly[]> {
    const { data } = await vpsApiClient.get<DwhAnomaly[]>('/dwh/anomalies', {
      params: {
        days,
        limit,
        bot_id: botId,
      },
    });
    return data;
  },
  async dwhAnomalyTrend(signatureHash: string, days = 7): Promise<DwhAnomalyTrendPoint[]> {
    const { data } = await vpsApiClient.get<DwhAnomalyTrendPoint[]>(`/dwh/anomalies/${signatureHash}/trend`, {
      params: { days },
    });
    return data;
  },
  async dwhAnomalySamples(signatureHash: string, limit = 20): Promise<DwhAnomalySample[]> {
    const { data } = await vpsApiClient.get<DwhAnomalySample[]>(`/dwh/anomalies/${signatureHash}/samples`, {
      params: { limit },
    });
    return data;
  },
  async runDwhRollupCompaction(
    rollupDays = 30,
    compactLogDays = 14,
    messageMaxLen = 240,
  ): Promise<DwhRollupCompactionRunResult> {
    const { data } = await vpsApiClient.post<DwhRollupCompactionRunResult>('/dwh/rollup-compaction/run', undefined, {
      params: {
        rollup_days: rollupDays,
        compact_log_days: compactLogDays,
        message_max_len: messageMaxLen,
      },
      timeout: 180000,
    });
    return data;
  },
  async dwhRollupCompactionConfig(): Promise<DwhRollupCompactionConfig> {
    const { data } = await vpsApiClient.get<DwhRollupCompactionConfig>('/dwh/rollup-compaction/config');
    return data;
  },
  async dwhAlertStatus(): Promise<DwhAlertStatus> {
    const { data } = await vpsApiClient.get<DwhAlertStatus>('/dwh/alerts/status');
    return data;
  },
  async dwhAlertConfig(): Promise<DwhAlertConfig> {
    const { data } = await vpsApiClient.get<DwhAlertConfig>('/dwh/alerts/config');
    return data;
  },
};
