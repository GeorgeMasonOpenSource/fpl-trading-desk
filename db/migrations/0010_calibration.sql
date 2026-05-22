-- =============================================================================
-- 0010 — Position calibration + manual benchmark overrides.
--
-- Two tables let us correct the engine's output AFTER the fact:
--
--  1. `model_calibration` — auto-computed per-position multipliers. After
--     each finished GW we compare projection_snapshots to actuals; if our
--     FWD predictions averaged 3.0 xPts but the actuals averaged 4.2, the
--     multiplier is 4.2/3.0 = 1.4. The projection-read path multiplies
--     every player's xpts_total by their position's multiplier before
--     surfacing it. Self-correcting: as the model improves, the
--     multipliers converge to 1.0.
--
--  2. `player_benchmark_overrides` — manual entries where you paste an
--     external xPts number (e.g. from FPLReview). The blend layer mixes
--     our number with the benchmark at a configurable weight. Useful for
--     specific players where we know the model is off and we have a
--     better external source.
--
-- Both tables are READ at projection-display time, not at projection-COMPUTE
-- time, so they don't affect the raw engine output. That keeps the audit
-- trail (model-audit page) clean — you can always see what the engine said
-- vs what we showed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS model_calibration (
  position           TEXT PRIMARY KEY,          -- GKP, DEF, MID, FWD
  -- Multiplier on xpts_total. 1.0 = no correction. > 1.0 = scale up.
  multiplier         NUMERIC(5,3) NOT NULL DEFAULT 1.0,
  -- Confidence (0..1) — how reliable this multiplier is. Higher = computed
  -- from more sample data. The blend with raw model output uses this as
  -- a weight: corrected = raw × ((1 - conf) × 1.0 + conf × multiplier).
  -- Lets us not over-correct on noisy single-GW samples.
  confidence         NUMERIC(4,3) NOT NULL DEFAULT 0.0,
  sample_gws         INT NOT NULL DEFAULT 0,
  mean_predicted     NUMERIC(6,3),
  mean_actual        NUMERIC(6,3),
  last_recomputed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO model_calibration (position, multiplier, confidence)
VALUES ('GKP', 1.0, 0.0), ('DEF', 1.0, 0.0), ('MID', 1.0, 0.0), ('FWD', 1.0, 0.0)
ON CONFLICT (position) DO NOTHING;

CREATE TABLE IF NOT EXISTS player_benchmark_overrides (
  player_id           INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  gameweek_id         INT NOT NULL REFERENCES gameweeks(id) ON DELETE CASCADE,
  -- Source identifier — "fplreview", "fanteam", "twitter:user", etc.
  -- Lets us track which manual signals we're blending in.
  source              TEXT NOT NULL DEFAULT 'fplreview',
  benchmark_xpts      NUMERIC(6,3) NOT NULL,
  -- How much weight to give the benchmark vs our model output.
  -- 0.0 = ignore benchmark, 1.0 = trust benchmark fully. Default 0.5.
  blend_weight        NUMERIC(4,3) NOT NULL DEFAULT 0.500,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, gameweek_id, source)
);

CREATE INDEX IF NOT EXISTS pbo_gw_idx ON player_benchmark_overrides (gameweek_id);

INSERT INTO schema_migrations (version) VALUES ('0010_calibration')
  ON CONFLICT (version) DO NOTHING;
