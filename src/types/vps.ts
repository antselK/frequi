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
  enabled: boolean;
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

export interface BotSummary {
  id: number;
  container_name: string;
  vps_name: string;
  strategy: string | null;
  exchange: string | null;
  enabled: boolean;
  status: string;
}

export interface ContainerStrategies {
  container_name: string;
  current: string | null;
  available: string[];
}

export interface ContainerSetStrategyResult {
  ok: boolean;
  message: string;
  strategy: string | null;
  restarted: boolean;
  config_path: string;
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

export interface DwhBotPurgeResult {
  container_name: string;
  bot_id: number;
  deleted_trades: number;
  deleted_orders: number;
  deleted_log_events: number;
  deleted_anomaly_signatures: number;
  deleted_anomaly_hourly_rollups: number;
  deleted_bot_heartbeats: number;
  deleted_entry_confirmations: number;
  deleted_signal_flashes: number;
  deleted_missed_signals: number;
  deleted_ingestion_checkpoints: number;
}

export interface DwhPurgeExcludedResult {
  rules_applied: number;
  deleted_log_events: number;
  deleted_anomaly_signatures: number;
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
  dca_order_count: number;
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

export interface DwhMissedTradeList {
  total: number;
  items: DwhAnomalySample[];
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
  direction: string | null; // "long" | "short" | null
  // Enriched
  vps_name: string | null;
  container_name: string | null;
  strategy: string | null;
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

export interface DwhMissedSignalParseStatus {
  running: boolean;
  parsed: number;
  skipped_no_pair: number;
  error: string | null;
  finished_at: string | null;
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

export interface DwhSignalIndicatorTradeRow {
  trade_id: number;
  bot_id: number;
  source_trade_id: number;
  vps_name: string | null;
  container_name: string | null;
  pair: string | null;
  enter_tag: string | null;
  exit_reason: string | null;
  is_short: boolean | null;
  is_open: boolean;
  open_date: string | null;
  close_date: string | null;
  profit_pct: number | null;
  profit_abs: number | null;
  duration_hours: number | null;
  dca_order_count: number;
  rsi: number | null;
  hv: number | null;
  rocr_1h: number | null;
  rocr: number | null;
  hh_48_diff: number | null;
  ll_48_diff: number | null;
  chop: number | null;
  bb_pos: string | null;
  bbdelta: number | null;
  closedelta: number | null;
  tail: number | null;
  volume: number | null;
  fisher: number | null;
  regime_score: number | null;
  btc_trend: number | null;
  eth_trend: number | null;
  rel_str: number | null;
  ob_spread_pct: number | null;
  ob_bid_vol: number | null;
  ob_ask_vol: number | null;
  ob_imbalance: number | null;
  adx: number | null;
  adx_1h: number | null;
  quality_score: number | null;
}

export interface DwhSignalIndicatorAnalysis {
  total_trades: number;
  matched_trades: number;
  match_rate_pct: number;
  items: DwhSignalIndicatorTradeRow[];
}

// --- Confluence Score report ---

export interface DwhConfluenceIndicatorSpec {
  lo: number | null;
  hi: number | null;
  sep: number;
  mean_good: number;
  mean_bad: number;
  weight: number;
}

export interface DwhConfluenceBbPosSpec {
  favorable: string;
  good_rate: number;
  rates: Record<string, number>;
}

export interface DwhConfluenceTagModel {
  n: number;
  qs_median: number;
  has_signal: boolean;
  indicators: Record<string, DwhConfluenceIndicatorSpec>;
  bb_pos: DwhConfluenceBbPosSpec | null;
}

export interface DwhConfluenceModel {
  calibrated_at: string | null;
  date_from: string | null;
  date_to: string | null;
  trades_used: number;
  indicators: string[];
  params: Record<string, number>;
  tags: Record<string, DwhConfluenceTagModel>;
}

export interface DwhConfluenceTradeRow extends DwhSignalIndicatorTradeRow {
  confluence_score: number | null;
}

export interface DwhConfluenceBucketStat {
  bucket: string;
  lo: number;
  hi: number;
  trades: number;
  avg_confluence: number | null;
  avg_quality_score: number | null;
  avg_profit_pct: number | null;
  avg_duration_hours: number | null;
  avg_dca_orders: number | null;
  win_rate_pct: number | null;
}

export interface DwhConfluenceAnalysis {
  active_calibrated_at: string | null;
  active_trades_used: number;
  has_model: boolean;
  total_trades: number;
  matched_trades: number;
  scored_trades: number;
  confluence_model: DwhConfluenceModel | null;
  buckets: DwhConfluenceBucketStat[];
  items: DwhConfluenceTradeRow[];
}

export interface DwhOrder {
  id: number;
  bot_id: number;
  source_order_id: string;
  source_trade_id: number | null;
  pair: string | null;
  side: string | null;
  order_type: string | null;
  status: string | null;
  order_date: string | null;
  average: number | null;
  amount: number | null;
  filled: number | null;
  remaining: number | null;
  price: number | null;
  fee_base: number | null;
  order_tag: string | null;
}

export interface DwhBotPerfStat {
  bot_id: number;
  container_name: string | null;
  vps_name: string | null;
  exchange: string | null;
  strategy: string | null;
  total_closed_trades: number;
  total_open_trades: number;
  wins: number;
  losses: number;
  win_rate_pct: number;
  avg_profit_pct: number;
  total_profit_abs: number;
  avg_duration_hours: number | null;
  avg_dca_orders: number;
  trades_per_day: number;
  first_trade_date: string | null;
  last_trade_date: string | null;
  days_active: number | null;
  best_pair: string | null;
  best_pair_profit_abs: number | null;
  daily_profit_usdt: number | null;
  monthly_projected_usdt: number | null;
  yearly_projected_usdt: number | null;
  perf_score: number | null;
  estimated_capital_usdt: number | null;
}

export interface DwhBotPerfRead {
  total_bots: number;
  items: DwhBotPerfStat[];
}

export interface DwhBotPerfHistoryPoint {
  date: string;
  bot_id: number;
  container_name: string | null;
  vps_name: string | null;
  trades: number;
  profit_abs: number;
  cumulative_profit_abs: number;
  avg_profit_pct: number;
}

export interface DwhBotPerfHistoryRead {
  items: DwhBotPerfHistoryPoint[];
}

export interface DwhBotPerfRollingScorePoint {
  date: string;
  bot_id: number;
  container_name: string | null;
  vps_name: string | null;
  score: number;
  trade_count: number;
  avg_profit_pct: number;
  avg_duration_hours: number | null;
  avg_dca_orders: number;
}

export interface DwhBotPerfRollingScoreRead {
  items: DwhBotPerfRollingScorePoint[];
}

export interface DwhTodDurationHourlyStat {
  hour_utc: number;
  total_trades: number;
  avg_duration_min: number;
  median_duration_min: number;
  pct_le_1h: number;
  pct_8h_plus: number;
  avg_profit_pct: number;
  win_rate_pct: number;
}

export interface DwhTodDurationRead {
  total_trades: number;
  items: DwhTodDurationHourlyStat[];
}

// Report layout settings (stored in app_settings under key "report-layout")
export interface ReportSubcategorySettings {
  order: string[];
  hidden: string[];
}

export interface ReportLayoutSettings {
  categoryOrder: string[];
  subcategories: Record<string, ReportSubcategorySettings>;
}

// ---------------------------------------------------------------------------
// freq-pairlist service (self-hosted remotepairlist replacement)
// ---------------------------------------------------------------------------

/** A single handler in a freqtrade-shaped `pairlists` array. */
export interface PairlistChainHandler {
  method: string;
  [key: string]: unknown;
}

export interface PairlistSortSpec {
  key: string;
  order: 'desc' | 'asc' | 'shuffle';
}

/**
 * The filter layer. Booleans are on/off switches; a `[min, max]` tuple is a range
 * where `-1` means unbounded, matching the original remotepairlist UI.
 */
export type PairlistFilters = Record<string, boolean | string | number | [number, number] | null>;

export interface PairlistSpec {
  exchange: string;
  market: 'spot' | 'futures';
  stake: string;
  mode?: 'whitelist' | 'blacklist';
  /** Parity path: the fleet's own selection chain, run verbatim. */
  base_chain?: PairlistChainHandler[];
  /** Build at these minutes past the hour, for candle alignment. */
  cron_minutes?: number[];
  /** Apply the blacklist as config rather than mid-chain — changes what the cap counts. */
  config_blacklist?: boolean;
  filters?: PairlistFilters;
  sort?: PairlistSortSpec | null;
  limit?: number | null;
  sort2?: PairlistSortSpec | null;
  limit2?: number | null;
}

export interface PairlistConfig {
  id: string;
  name: string;
  enabled: boolean;
  spec: PairlistSpec;
  cadence_min: number;
  created_at: string;
  updated_at: string;
  pair_count?: number;
  generated_at?: string | null;
  degraded?: boolean;
}

export interface PairlistConfigList {
  total: number;
  configs: PairlistConfig[];
}

export interface PairlistStageCount {
  stage: string;
  before: number;
  after: number;
  removed: number;
}

export interface PairlistBuild {
  id: number;
  config_id: string;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'refused' | 'failed';
  pair_count: number | null;
  stage_counts: PairlistStageCount[] | null;
  error: string | null;
}

export interface PairlistHealthEntry {
  id: string;
  name: string;
  enabled: boolean;
  status: 'ok' | 'stale' | 'degraded' | 'no_result' | 'disabled';
  pair_count: number;
  generated_at: string | null;
  age_seconds: number | null;
  stale_after_seconds: number;
  note: string | null;
}

export interface PairlistHealth {
  status: 'ok' | 'warning' | 'error';
  checked_at: string;
  configs: PairlistHealthEntry[];
}

export interface PairlistPreview {
  pairs: string[];
  count: number;
  stages: PairlistStageCount[];
  notes: string[];
}

export interface PairlistMetric {
  key: string;
  timeframe: string;
  description: string;
  /** 'indicator' (candle-derived) | 'breadth' | 'external' */
  group?: string;
}

export interface PairlistBlacklistState {
  summary: string;
  counts: Record<string, number>;
  static: string[];
  auto_restricted: string[];
  delistings: string[];
  retired: { symbol: string; removed_at: string; retests: number }[];
}
