-- =============================================================================
-- 0016 — FPL Joe (https://www.fpljoe.com) per-fixture market odds.
--
-- Source: https://www.fpljoe.com/api/odds/overview (public, JSON).
-- Bookmaker market is converted by FPL Joe into Poisson lambdas per team:
--   lambda_home / lambda_away — expected goals (the model anchor)
--   p_home_cs / p_away_cs     — clean-sheet probabilities (already derived)
--
-- We keep four snapshots: latest, 12h, 24h, 48h ago. The 12-48h deltas are
-- the "sharp money has moved" signal — useful for late-week alerts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS fpljoe_odds (
  fixture_id           INT  NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  bookmaker            TEXT NOT NULL,                       -- 'Sbobet' currently
  snapshot_ts          TIMESTAMPTZ NOT NULL,                -- latest snapshot
  confidence           NUMERIC(4,3) NOT NULL DEFAULT 0,     -- 0..1 from FPL Joe
  is_stale             BOOLEAN NOT NULL DEFAULT FALSE,
  -- Current snapshot
  lambda_home          NUMERIC(6,3) NOT NULL,
  lambda_away          NUMERIC(6,3) NOT NULL,
  p_home_cs            NUMERIC(5,4) NOT NULL,
  p_away_cs            NUMERIC(5,4) NOT NULL,
  -- 12h-ago comparison (NULL if no comparison snapshot)
  lambda_home_12h      NUMERIC(6,3),
  lambda_away_12h      NUMERIC(6,3),
  -- 24h-ago comparison
  lambda_home_24h      NUMERIC(6,3),
  lambda_away_24h      NUMERIC(6,3),
  -- 48h-ago comparison
  lambda_home_48h      NUMERIC(6,3),
  lambda_away_48h      NUMERIC(6,3),
  -- Bookkeeping
  fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_id, bookmaker)
);

CREATE INDEX IF NOT EXISTS fpljoe_odds_snapshot_idx
  ON fpljoe_odds (snapshot_ts DESC);

INSERT INTO schema_migrations (version) VALUES ('0016_fpljoe_odds')
  ON CONFLICT (version) DO NOTHING;
