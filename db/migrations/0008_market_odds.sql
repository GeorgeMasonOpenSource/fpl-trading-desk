-- =============================================================================
-- 0008 — Bookmaker market odds.
--
-- Single highest-leverage external data source we can add without licensing:
-- the lines that real money is being moved on for player goalscorer and team
-- clean-sheet markets. These markets are tight, calibrated against thousands
-- of bettors, and contain information our deterministic engine cannot derive
-- on its own (e.g. tactical setup intel, late-week news, lineup speculation).
--
-- We store:
--   - one row per (player, market, gameweek, bookmaker, captured_at)
--   - decimal odds AND the implied probability (1/odds, vig-removed at the
--     market level if multiple outcomes are observed simultaneously)
--   - the source so we can compare bookmakers and detect outliers
--
-- The ensemble blender in src/lib/projections/ensemble.ts reads these and
-- blends them with the engine's projection to produce a final number.
-- =============================================================================

CREATE TABLE IF NOT EXISTS market_odds (
  id               BIGSERIAL PRIMARY KEY,
  gameweek_id      INT NOT NULL REFERENCES gameweeks(id),
  fixture_id       INT REFERENCES fixtures(id),
  -- Subject: player goals, player assists, team clean sheet, etc.
  market           TEXT NOT NULL CHECK (market IN (
    'player_goal',
    'player_two_or_more_goals',
    'player_assist',
    'team_clean_sheet',
    'team_to_win',
    'btts'
  )),
  -- Subject identifier. NULL for team markets; team_id used for clean sheet.
  player_id        INT  REFERENCES players(id) ON DELETE CASCADE,
  team_id          INT  REFERENCES teams(id)   ON DELETE CASCADE,
  -- Decimal odds (e.g. 3.50) at time of capture. Lower = more likely.
  decimal_odds     NUMERIC(8,3) NOT NULL,
  -- Implied probability after de-vigging at the market level. 0..1.
  implied_prob     NUMERIC(6,4) NOT NULL,
  -- Vig (over-round) from the market this row was sourced from. Used as
  -- a diagnostic — over-round above 1.10 is a wide, less informative market.
  market_overround NUMERIC(6,4),
  bookmaker        TEXT NOT NULL DEFAULT 'consensus',
  captured_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Source identifier — which API or scraper produced this row.
  source           TEXT NOT NULL DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS market_odds_lookup_idx
  ON market_odds (gameweek_id, market, player_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS market_odds_team_idx
  ON market_odds (gameweek_id, market, team_id, captured_at DESC);

-- Convenience view: latest snapshot of each (player, market, gameweek)
-- combination. Used by the ensemble blender to avoid stale data.
CREATE OR REPLACE VIEW market_odds_latest AS
SELECT DISTINCT ON (gameweek_id, market, player_id, team_id)
       id, gameweek_id, fixture_id, market, player_id, team_id,
       decimal_odds, implied_prob, market_overround, bookmaker,
       captured_at, source
  FROM market_odds
 ORDER BY gameweek_id, market, player_id, team_id, captured_at DESC;

INSERT INTO schema_migrations (version) VALUES ('0008_market_odds')
  ON CONFLICT (version) DO NOTHING;
