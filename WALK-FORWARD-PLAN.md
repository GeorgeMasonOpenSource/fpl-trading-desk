# Walk-forward refactor plan (off-season work)

Goal: a single function `runEngineAtCutoff(cutoffGw)` that produces the
projection for GW `cutoffGw` using ONLY data available before that GW.
Then for each GW 5..38 we re-run the current engine, score predicted vs
actual, get a real RMSE we can use for feature ablation.

Today we can already measure something via `npm run rmse:baseline` —
that scores the SNAPSHOTS we recorded at the time. But snapshots reflect
whatever engine version was deployed back then, not today's code. So:

- `rmse:baseline` → "how well has the model done over the season so far?"
- `runEngineAtCutoff` (this plan) → "how well does today's code do?"

Without #2 we can't ablate features. Build it.

---

## Per-file changes

Every query in these files needs a `cutoffGameweek` parameter that, when
set, filters historical aggregates to `gameweek_id < cutoff`. When NULL
the query behaves as today (uses everything).

### src/lib/projections/team-rating.ts — Bayesian Kalman
- `recomputeAllTeams(cutoff)` → only consume fixtures with `f.gameweek_id < cutoff`
- `loadTeamRating(teamId, cutoff)` for the engine to read the right rating

### src/lib/minutes/engine.ts
- All `player_gameweek_history` aggregates: `WHERE gameweek_id < ${cutoff}`
- `season_xg` and friends from players table → recompute from history per cutoff
  - Add helper `playerSeasonTotalsAtCutoff(playerId, cutoff)`

### src/lib/projections/engine.ts
- Main query: filter `player_gameweek_history` joined for current_minutes,
  current_xg, current_xa, current_bonus by `gameweek_id < cutoff`
- `team_xg_total`, `team_xa_total` need to be recomputed from team aggregates
  at the cutoff — not pulled from `players` (which is current snapshot)
- Recency-weighted form (`recency_minutes`, `recency_xg`, `recency_xa`):
  the recency decay window already lives in the query, just needs the
  upper bound filter

### src/lib/projections/hierarchical.ts
- Position priors recomputed from `player_gameweek_history WHERE gameweek_id < cutoff`

### src/lib/projections/per-position-defence.ts
- Same — uses fixtures.finished + gameweek_id

### src/lib/projections/calibration.ts
- The model_calibration table is fitted on past actuals. For walk-forward,
  fit it from `gameweek_id < cutoff` only.
- Easier: skip calibration during walk-forward (use multiplier=1.0)

### src/lib/projections/set-piece-roles.ts
- `player_shot_history WHERE match_date < cutoff_date`
- Need cutoff_gw → match_date mapping (look up `gameweeks.deadline_time`)

### Understat aggregates
- `player_shot_aggregates` is a flat current-season snapshot — no GW info.
- For walk-forward, either:
  (a) Skip Understat during walk-forward (engine falls back to season_xg heuristic)
  (b) Re-aggregate from `player_shot_history` per cutoff (which DOES have match_date)
- Option (b) is correct; we already have the data.

---

## Harness changes

`src/lib/backtest/walk-forward.ts`:
- Replace `applyParams()` stub with `await runEngineAtCutoff(cutoffGw, params)`
- Loop over GW window, store one row per (player, gw, predicted, actual)
- Compute headline RMSE/MAE/bias + per-position breakdown

`scripts/grid-search.ts`:
- For each param combo, full season walk-forward (38 × engine run = ~3 min)
- Save to `walk_forward_runs` so we can rank ex-post

---

## Estimate
- team-rating: 0.5 day
- minutes engine: 0.5 day
- main engine + helpers: 1 day
- hierarchical + defence + set-piece: 0.5 day
- harness wiring + grid search: 0.5 day
- Total: ~3 days focused

After this, we can run an ablation: turn each feature on/off, measure
RMSE delta on the 37-GW season, keep only what beats baseline.
