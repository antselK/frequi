export interface VpsServer {
  id: number;
  name: string;
  ip: string;
  ssh_user: string;
  ssh_port: number;
  display_order: number | null;
  status: string;
  docker_available: boolean | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  bot_count?: number;
}

export interface VpsCreatePayload {
  name: string;
  ip: string;
  ssh_user: string;
  ssh_port: number;
  private_key: string;
}

export interface VpsUpdatePayload {
  name?: string;
  ip?: string;
  ssh_user?: string;
  ssh_port?: number;
  private_key?: string;
}

export interface VpsActionResult {
  ok: boolean;
  message: string;
}

export interface VpsDockerCheckResult extends VpsActionResult {
  docker_available: boolean;
}

export interface VpsDiscoverResult extends VpsActionResult {
  discovered: number;
  freqtrade_discovered: number;
}

export interface VpsContainer {
  id: number;
  vps_id: number;
  container_name: string;
  image: string;
  status: string;
  strategy: string | null;
  exchange: string | null;
  pairlist: string | null;
  trading_mode: string | null;
  api_port: number | null;
  source_runtime: boolean;
  config_mismatch: boolean;
  is_freqtrade: boolean;
  created_at: string;
  updated_at: string;
}

export interface VpsOpenTradesSummary {
  vps_id: number;
  total_open_trades: number;
  containers_checked: number;
  containers_with_open_trades: number;
  errors: number;
}

export interface VpsLogsResult {
  container: string;
  tail: number;
  logs: string;
}

export interface VpsContainerAuthHint {
  found: boolean;
  config_path: string;
  url: string | null;
  username: string | null;
  password: string | null;
  message: string;
}

export interface VpsStatusStreamPayload {
  timestamp: string;
  vps: VpsServer[];
}

export interface AuditLogEntry {
  id: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string | null;
  result: string;
  message: string | null;
  created_at: string;
}
