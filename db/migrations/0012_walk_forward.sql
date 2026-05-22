-- =============================================================================
-- 0012 — Walk-forward backtest infrastructure.
--
-- `walk_forward_runs` records each backtest experiment (name, parameter
-- config used, season-wide metrics). `walk_forward_predictions` stores
-- the per-(player, gw) predictions a given run produced.
--
-- The grid-search workflow:
--   1. Pick a parameter config (e.g. recencyDecay=0.65, ensembleBlend=0.30)
--   2. Loop GW = 1..38: rebuild engine state from data available BEFORE
--      that GW, run engine forward, store predictions for the GW.
--   3. After all GWs, JOIN to player_gameweek_history actuals and compute
--      RMSE/MAE/bias per position and overall.
--   4. Record summary in walk_forward_runs.
--   5. Repeat with next config.
--
-- The best config (lowest season-wide RMSE) becomes our production
-- engine_params for the new season.
-- =============================================================================

CREATE TABLE IF NOT EXISTS walk_forward_runs (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  -- The full parameter config as JSONB so we can sweep many dimensions.
  params          JSONB NOT NULL,
  -- Headline metrics.
  total_rows      INT NOT NULL,
  rmse            NUMERIC(6,3) NOT NULL,
  mae             NUMERIC(6,3) NOT NULL,
  bias            NUMERIC(6,3) NOT NULL,
  -- Per-position metrics as JSONB { GKP: { rmse, mae, bias, n }, ... }
  per_position    JSONB NOT NULL,
  -- Per-GW RMSE as JSONB { 1: 2.34, 2: 1.92, ... } so we can see drift.
  per_gw_rmse     JSONB NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  notes           TEXT
);

CREATE TABLE IF NOT EXISTS walk_forward_predictions (
  run_id          BIGINT NOT NULL REFERENCES walk_forward_runs(id) ON DELETE CASCADE,
  player_id       INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  gameweek_id     INT NOT NULL REFERENCES gameweeks(id) ON DELETE CASCADE,
  -- Sum across fixtures (single-GW players just have one row).
  predicted       NUMERIC(6,3) NOT NULL,
  actual          NUMERIC(6,3),
  -- Save key engine inputs so we can re-debug without re-running.
  expected_minutes NUMERIC(6,2),
  team_xg_for      NUMERIC(5,3),
  PRIMARY KEY (run_id, player_id, gameweek_id)
);
CREATE INDEX IF NOT EXISTS wfp_gw_idx ON walk_forward_predictions (gameweek_id);

INSERT INTO schema_migrations (version) VALUES ('0012_walk_forward')
  ON CONFLICT (version) DO NOTHING;
