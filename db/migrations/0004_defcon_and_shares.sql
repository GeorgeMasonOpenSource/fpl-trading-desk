-- =============================================================================
-- 0004 — Defensive Contributions, set-piece / penalty order, and team season
-- totals so we can derive goal / assist shares from data instead of hardcoding
-- 0.15 / 0 / 0 in the projection engine.
--
-- Why this matters: the projection engine was systematically under-rating
-- attackers (Haaland 1.8 xPts vs ~7 in well-calibrated models) and defenders
-- (4.5 vs 3.5) because:
--   1. We never modelled the new 25/26 DEFCON scoring rule (+2 pts at 10+
--      defensive actions for DEF, 12+ for MID/FWD).
--   2. goalShare / assistShare / penaltyShare were hardcoded to 0.15 / 0.15 / 0
--      so a 35%-of-team-xG striker got the same treatment as a tertiary forward.
--   3. We had no record of who actually takes the penalties.
-- =============================================================================
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_defcon                       INT          NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS season_defcon_per_90                NUMERIC(8,3) NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS penalties_order                     INT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS corners_and_indirect_freekicks_order INT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS direct_freekicks_order              INT;

-- Team season aggregates used as denominators when deriving player shares.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS season_xg_total NUMERIC(10,3) NOT NULL DEFAULT 0;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS season_xa_total NUMERIC(10,3) NOT NULL DEFAULT 0;

-- DEFCON-points component, added so the projection breakdown stays itemised.
ALTER TABLE projections ADD COLUMN IF NOT EXISTS xpts_defcon NUMERIC(8,3) NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (version) VALUES ('0004_defcon_and_shares')
  ON CONFLICT (version) DO NOTHING;
