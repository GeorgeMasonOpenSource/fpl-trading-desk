-- =============================================================================
-- 0015 — External team-news ingest (Fantasy Football Scout etc.).
--
-- Stores per-team press-conference summaries scraped from public team-news
-- aggregators. One row per (team_id, source). We always display this with
-- explicit source attribution + outbound link — never as our own copy.
--
-- Sources currently supported:
--   • 'ff_scout' — https://www.fantasyfootballscout.co.uk/team-news
-- =============================================================================

CREATE TABLE IF NOT EXISTS team_news_external (
  team_id          INT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,
  source_label     TEXT NOT NULL,                 -- "Fantasy Football Scout"
  source_url       TEXT NOT NULL,                 -- back-link for attribution
  next_match       TEXT,                          -- "Crystal Palace (A)"
  formation        TEXT,                          -- "4-3-3"
  predicted_xi     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array of player names
  out_list         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ name }]
  doubts           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ name, percent }]
  banned           JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_news      TEXT,                          -- verbatim narrative paragraph
  last_updated_at  TEXT,                          -- "Sun 24th May" — verbatim
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, source)
);

CREATE INDEX IF NOT EXISTS team_news_external_fetched_idx
  ON team_news_external (fetched_at DESC);

INSERT INTO schema_migrations (version) VALUES ('0015_team_news_external')
  ON CONFLICT (version) DO NOTHING;
