-- =============================================================================
-- 0005 — Team-level motivation + tactical-style columns.
--
-- Why: end-of-season teams with nothing to play for rotate more and bring
-- flatter performances. And some players thrive vs open / counter-attacking
-- defences while others crush low blocks. The projection engine reads from
-- these columns to adjust xG expectations and rotation risk per fixture.
-- All values are derived deterministically from data we already have
-- (fixtures table + season totals).
-- =============================================================================

ALTER TABLE teams ADD COLUMN IF NOT EXISTS table_position    INT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS table_points      INT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS games_played      INT;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS goal_difference   INT;
-- 0..1 — how motivated the team is by remaining PL stakes.
--   1.00 = title chase, relegation fight, or top-4 race
--   0.50 = chasing top-6
--   0.10 = mid-table, mathematically safe, no European stakes
ALTER TABLE teams ADD COLUMN IF NOT EXISTS motivation_score  NUMERIC(4,3) NOT NULL DEFAULT 0.70;
-- Tactical style proxies. Derived from goals-for / goals-against / xG / xGA.
--   defensive_solidity 0..1  — 1 = elite defence, 0 = leaky
--   attacking_style    0..1  — 1 = open/attacking, 0 = compact / low block
ALTER TABLE teams ADD COLUMN IF NOT EXISTS defensive_solidity NUMERIC(4,3) NOT NULL DEFAULT 0.50;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS attacking_style    NUMERIC(4,3) NOT NULL DEFAULT 0.50;

INSERT INTO schema_migrations (version) VALUES ('0005_motivation_style')
  ON CONFLICT (version) DO NOTHING;
