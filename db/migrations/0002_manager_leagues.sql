-- =============================================================================
-- 0002 — manager_leagues: persistent list of leagues a manager belongs to.
-- Auto-populated from FPL's /entry/{id}/ endpoint on connect/refresh, so the
-- UI can list all leagues without re-fetching, and the user can pick which
-- ones to monitor.
-- =============================================================================
CREATE TABLE IF NOT EXISTS manager_leagues (
  manager_id      BIGINT NOT NULL REFERENCES manager_teams(manager_id) ON DELETE CASCADE,
  league_id       BIGINT NOT NULL,
  name            TEXT NOT NULL,
  short_name      TEXT,
  scoring         CHAR(1) NOT NULL DEFAULT 'c',     -- 'c' classic, 'h' h2h
  league_type     CHAR(1) NOT NULL DEFAULT 'x',     -- 's' system, 'x' other, 'c' classic
  start_event     INT,
  entry_rank      INT,
  entry_last_rank INT,
  entry_percentile_rank INT,
  closed          BOOLEAN NOT NULL DEFAULT FALSE,
  monitored       BOOLEAN NOT NULL DEFAULT FALSE,   -- user-flagged; cron pulls standings for these
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (manager_id, league_id)
);
CREATE INDEX IF NOT EXISTS manager_leagues_monitored_idx
  ON manager_leagues (manager_id, monitored) WHERE monitored;

INSERT INTO schema_migrations (version) VALUES ('0002_manager_leagues')
  ON CONFLICT (version) DO NOTHING;
