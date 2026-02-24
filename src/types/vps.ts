export interface VpsServer {
  id: number;
  name: string;
  ip: string;
  ssh_user: string;
  ssh_port: number;
  dwh_log_fetch_timeout_seconds?: number | null;
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
  dwh_log_fetch_timeout_seconds?: number | null;
  private_key: string;
}

export interface VpsUpdatePayload {
  name?: string;
  ip?: string;
  ssh_user?: string;
  ssh_port?: number;
  dwh_log_fetch_timeout_seconds?: number | null;
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
  source_ip: string | null;
  result: string;
  message: string | null;
  created_at: string;
}

export interface DwhTopAnomaly {
  bot_id: number;
  level: string;
  logger: string;
  occurrences: number;
  signature: string;
}

export interface DwhCheckpoint {
  bot_id: number;
  vps_name: string;
  container_name: string;
  strategy: string | null;
  exchange: string | null;
  last_trade_id: number;
  last_order_id: number;
  last_status: string;
  last_error: string | null;
  last_synced_at: string | null;
}

export interface DwhSummary {
  bots_total: number;
  checkpoints_total: number;
  checkpoints_success: number;
  trade_rows: number;
  order_rows: number;
  log_event_rows: number;
  anomaly_rows: number;
  last_synced_at: string | null;
  top_anomalies: DwhTopAnomaly[];
  checkpoints: DwhCheckpoint[];
}

export interface DwhAuditMode {
  enabled: boolean;
}

export interface DwhAuditSummaryBucket {
  logger: string;
  level: string;
  total: number;
  selected: boolean;
  excluded: boolean;
}

export interface DwhAuditSummary {
  since_hours: number;
  total_events: number;
  buckets: DwhAuditSummaryBucket[];
}

export interface DwhAuditMessage {
  event_ts: string;
  bot_id: number;
  vps_name: string | null;
  container_name: string | null;
  logger: string;
  level: string;
  message: string;
}

export interface DwhAuditMessageList {
  total: number;
  items: DwhAuditMessage[];
}

export interface DwhLogCumulativePoint {
  bucket_ts: string;
  log_count: number;
  cumulative_count: number;
}

export interface DwhLogCauseBucket {
  logger: string;
  level: string;
  message: string;
  occurrences: number;
}

export interface DwhLogCauseSummary {
  from_ts: string;
  to_ts: string;
  total_events: number;
  buckets: DwhLogCauseBucket[];
}

export interface DwhLogCaptureRule {
  id: number;
  logger_name: string | null;
  level: string | null;
  rule_type: 'include' | 'exclude';
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface DwhIngestionRunResult {
  bots_scanned: number;
  bots_synced: number;
  bots_failed: number;
  inserted_trades: number;
  updated_trades: number;
  inserted_orders: number;
  updated_orders: number;
  inserted_log_events: number;
  inserted_error_logs: number;
  inserted_strategy_logs: number;
  log_rows_scanned: number;
  high_volume_warning: boolean;
  updated_anomalies: number;
  errors: string[];
}

export interface DwhIngestionUnstickResult {
  updated_runs: number;
  message: string;
}

export interface DwhIngestionConfig {
  log_fetch_timeout_seconds: number;
}

export interface DwhIngestionAsyncStart {
  accepted: boolean;
  status: 'running' | 'finished' | 'failed' | 'idle';
}

export interface DwhIngestionStatus {
  status: 'running' | 'finished' | 'failed' | 'idle';
  started_at: string | null;
  finished_at: string | null;
  result: DwhIngestionRunResult | null;
  error: string | null;
  current_vps_name?: string | null;
  current_container_name?: string | null;
  current_bot_index?: number | null;
  current_bots_total?: number | null;
}

export interface DwhIngestionRun {
  id: number;
  mode: string;
  status: 'running' | 'finished' | 'failed';
  actor: string | null;
  started_at: string;
  finished_at: string | null;
  result: DwhIngestionRunResult | null;
  error: string | null;
}

export interface DwhRunAnomaly {
  level: string;
  logger: string;
  signature: string;
  occurrences: number;
}

export interface DwhRetentionRunResult {
  days: number;
  deleted_trades: number;
  deleted_orders: number;
  deleted_log_events: number;
  deleted_anomalies: number;
  deleted_runs: number;
}

export interface DwhRetentionConfig {
  enabled: boolean;
  days: number;
  interval_minutes: number;
  startup_delay_seconds: number;
  last_auto_run_at: string | null;
  next_auto_run_at: string | null;
}

export interface DwhTrade {
  id: number;
  bot_id: number;
  vps_name: string | null;
  container_name: string | null;
  source_trade_id: number;
  pair: string | null;
  is_short: boolean | null;
  enter_tag: string | null;
  strategy: string | null;
  exit_reason: string | null;
  is_open: boolean;
  open_date: string | null;
  close_date: string | null;
  open_rate: number | null;
  close_rate: number | null;
  profit_ratio: number | null;
  profit_abs: number | null;
  anomaly_count: number;
}

export interface DwhTradeQuery {
  days?: number;
  date_from?: string;
  date_to?: string;
  bot_id?: number;
  pair?: string;
  strategy?: string;
  entry_reason?: string;
  exit_reason?: string;
  is_short?: boolean;
  limit?: number;
  offset?: number;
}

export interface DwhTradeList {
  total: number;
  items: DwhTrade[];
}

export interface DwhTradeTimelineItem {
  ts: string;
  kind: 'order' | 'log';
  confidence: 'high' | 'medium' | 'low';
  title: string;
  details: string | null;
}

export interface DwhTradeTimeline {
  trade_id: number;
  bot_id: number;
  source_trade_id: number;
  pair: string | null;
  open_date: string | null;
  close_date: string | null;
  items: DwhTradeTimelineItem[];
}

export interface DwhAnomaly {
  signature_hash: string;
  signature: string;
  logger: string;
  level: string;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface DwhAnomalyTrendPoint {
  bucket_ts: string;
  occurrences: number;
}

export interface DwhAnomalySample {
  event_ts: string;
  bot_id: number;
  logger: string;
  level: string;
  message: string;
}

export interface DwhRollupCompactionRunResult {
  rollup_days: number;
  compact_log_days: number;
  message_max_len: number;
  upserted_rollup_rows: number;
  deleted_rollup_rows: number;
  compacted_log_events: number;
}

export interface DwhRollupCompactionConfig {
  enabled: boolean;
  rollup_days: number;
  compact_log_days: number;
  message_max_len: number;
  interval_minutes: number;
  startup_delay_seconds: number;
  last_auto_run_at: string | null;
  next_auto_run_at: string | null;
}

export interface DwhAlertItem {
  key: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  value: number;
}

export interface DwhAlertStatus {
  enabled: boolean;
  evaluated_at: string;
  triggered_count: number;
  alerts: DwhAlertItem[];
}

export interface DwhAlertConfig {
  enabled: boolean;
  interval_minutes: number;
  startup_delay_seconds: number;
  bots_failed_threshold: number;
  anomaly_occurrences_threshold: number;
  anomaly_window_minutes: number;
  last_auto_run_at: string | null;
  next_auto_run_at: string | null;
}

export interface DwhMissedSignal {
  id: number;
  bot_id: number;
  source_log_event_id: number | null;
  pair: string;
  signal_ts: string;
  block_reason: string;
  signal_price: number | null;
  price_source: string | null; // "log" | "candle_open"
  // Outcome (null until 24h have elapsed and fetch has run)
  outcome_fetched_at: string | null;
  outcome_window_hours: number;
  candle_open_at_signal: number | null;
  high_in_window: number | null;
  low_in_window: number | null;
  close_at_window_end: number | null;
  max_gain_pct: number | null;
  max_loss_pct: number | null;
  close_pct: number | null;
  fetch_error: string | null;
  ingested_at: string;
  // Enriched
  vps_name: string | null;
  container_name: string | null;
}

export interface DwhMissedSignalList {
  total: number;
  pending_outcomes: number;
  items: DwhMissedSignal[];
}

export interface DwhMissedSignalParseResult {
  parsed: number;
  skipped_no_pair: number;
}

export interface DwhMissedSignalOutcomeFetchResult {
  fetched: number;
  errors: number;
  pending: number;
}

export interface DwhEntryTagStat {
  enter_tag: string | null;
  trades: number;
  wins: number;
  win_rate_pct: number;
  avg_profit_pct: number;
  avg_duration_hours: number | null;
  total_profit_abs: number;
}

export interface DwhEntryTagPerformanceList {
  total_tags: number;
  items: DwhEntryTagStat[];
}

export interface DwhDcaStat {
  order_count: number;
  trades: number;
  wins: number;
  win_rate_pct: number;
  avg_profit_pct: number;
  avg_duration_hours: number | null;
  total_profit_abs: number;
}

export interface DwhDcaAnalysisList {
  total_closed_trades: number;
  trades_with_orders: number;
  items: DwhDcaStat[];
}
