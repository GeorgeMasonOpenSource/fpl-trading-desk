-- =============================================================================
-- 0013 — Team-level xG_for from Understat's team API.
--
-- The current team_shot_aggregates.xg_for is summed from player_shot_history,
-- which requires every shot to map to an FPL player_id. The match rate is
-- ~60% (Cherki, Haaland, etc. miss for name/encoding reasons), which
-- structurally undercounts City's xG/match by ~30%.
--
-- Understat publishes per-team xG/xGA directly via its league endpoint
-- (no player mapping required). We add columns for these team-level
-- totals and populate them in the ingest. The team-rating Bayesian
-- Kalman now reads from these unbiased totals instead of the leaky
-- per-player sum.
-- =============================================================================

ALTER TABLE team_shot_aggregates
  ADD COLUMN IF NOT EXISTS xg_for       NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS npxg_for     NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS npxg_against NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS matches_team_xg INT;

INSERT INTO schema_migrations (version) VALUES ('0013_team_xg_for')
  ON CONFLICT (version) DO NOTHING;
