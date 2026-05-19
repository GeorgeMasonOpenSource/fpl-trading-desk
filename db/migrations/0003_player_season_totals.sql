-- =============================================================================
-- 0003 — player season totals from FPL bootstrap-static.
--
-- Before this migration, "current-season" aggregates were derived from
-- player_gameweek_history, but that table is only populated from event/live
-- ingestion (just the in-progress / recently-finished GWs). At end-of-season
-- this leaves the projection engine starved of evidence and everyone falls
-- back to the default prior — which is why xPts collapsed to ~0 and every
-- player got identical reliability / rotation values.
--
-- FPL's bootstrap-static endpoint already includes per-element season totals.
-- We store them here and have the engines read from these columns directly.
-- =============================================================================
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_minutes        INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_starts         INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_goals          INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_assists        INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_xg             NUMERIC(8,3) NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_xa             NUMERIC(8,3) NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_xgi            NUMERIC(8,3) NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_xgc            NUMERIC(8,3) NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_bonus          INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_yellow_cards   INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_red_cards      INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_saves          INT          NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (version) VALUES ('0003_player_season_totals')
  ON CONFLICT (version) DO NOTHING;
