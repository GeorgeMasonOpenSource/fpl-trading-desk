-- =============================================================================
-- 0014 — Per-player Bayesian priors (conversion + bonus).
--
-- The position-level calibration corrects average bias but doesn't capture
-- WHO converts xG into goals at a higher-than-average rate. Haaland scores
-- more than his xG suggests; some attacking mids over/under-perform their
-- xA; some players bonus-up far more than their BPS would imply.
--
-- We fit per-player multipliers from the full season's actuals, then
-- Bayesian-shrink them toward 1.0 based on sample size. Players with
-- limited minutes get small adjustments (high prior weight). Elites with
-- 30+ starts get something close to their raw multiplier.
--
-- Formula (log-space, symmetric):
--   raw     = log(actual_goals + 0.5) - log(expected_goals + 0.5)
--   shrunk  = (n × raw) / (n + prior_weight)
--   mult    = exp(shrunk),  clamped to [0.7, 1.4]
--
-- prior_weight tuned to give ~ 50% weight to a player at ~ 8 starts and
-- ~ 95% weight at 30 starts. n is the player's effective sample (90s).
-- =============================================================================

CREATE TABLE IF NOT EXISTS player_priors (
  player_id              INT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  goal_conversion_mult   NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  assist_conversion_mult NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  bonus_per_90_mult      NUMERIC(4,3) NOT NULL DEFAULT 1.0,
  -- The Bayesian "n" — effective number of 90s the prior was fit on.
  -- 0 = no data (multipliers stay 1.0).
  sample_90s             NUMERIC(6,2) NOT NULL DEFAULT 0,
  -- Confidence in the multiplier (0..1). Used by engine to blend toward
  -- 1.0 for low-confidence priors.
  confidence             NUMERIC(4,3) NOT NULL DEFAULT 0,
  computed_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('0014_player_priors')
  ON CONFLICT (version) DO NOTHING;
