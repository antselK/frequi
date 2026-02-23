# FreqUI Handoff — 2026-02-23

## Scope completed in this checkpoint
All work is in `src/views/ReportsView.vue` (Reports → Trades → Trailing entries benefit).

### Implemented
- Added new sub-report: **Trailing entries benefit**.
- Added trailing trigger parsing from DWH anomaly samples (focus on `Printer` trailing messages).
- Added summary chips:
  - trigger count
  - average trailing profit
  - positive-profit share
  - average trailing duration
  - profit buckets: `<0%`, `0-0.2%`, `>0.2%`
- Added filters:
  - Days
  - Bot ID
  - Trade ID
  - Pair
  - VPS
  - Container
  - Side
- Added table fields:
  - Trade ID
  - Match source
  - Triggered at
  - Entered at
  - Bot details (VPS + container + bot id)
  - Pair, side, trailing profit/offset/duration/start/current/limits, logger, message
- Trade matching pipeline (in order):
  1. closed `_trail` trades (`matchSource=closed_trail`)
  2. broad trade-time fallback (`matchSource=trade_fallback`)
  3. rpc manager trade-id hints (`matchSource=rpc_hint`)
  4. if still missing logs but closed `_trail` trade exists, synthetic row (`matchSource=trade_only`)
- Trade ID alignment fix:
  - report now uses **Freqtrade trade ID** (`source_trade_id`), not internal DWH trade row id.
- Profit semantics fix:
  - table column renamed to **Trailing Profit %**
  - `trade_only` synthetic rows do **not** use trade PnL anymore (`Trailing Profit %` is blank there).

## Current behavior notes
- Some rows intentionally remain unmatched (`matchSource=none`) when no confident link exists.
- `trade_only` rows appear for closed `_trail` trades where no trailing `Printer` sample is available in DWH.
- Same `source_trade_id` can appear across different bots/containers/VPS; matching keying is bot-aware.

## Suggested next task (pending)
- Add a `Match source` filter/toggle in the UI to quickly isolate:
  - `none`
  - `closed_trail`
  - `trade_fallback`
  - `rpc_hint`
  - `trade_only`

## Quick validation path
1. Open Reports → Trades → Trailing entries benefit.
2. Refresh.
3. Verify:
   - Trade IDs match Freqtrade Closed Trades IDs.
   - `Trailing Profit %` is populated only from trailing log data.
   - `trade_only` rows are present for closed trades without trailing logs.
