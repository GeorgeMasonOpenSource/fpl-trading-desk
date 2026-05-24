/**
 * Press-conference / Team-news engine.
 *
 * Goal: surface ONLY content that a manager actually addressed in their
 * pre-match press conference (or that's verifiable from FPL bootstrap).
 * Specifically excludes off-season transfers and rest-of-season loans —
 * those clutter the page with players who are gone for the summer, not
 * what the manager talked about on Friday.
 *
 * Sources, in priority order:
 *
 *   1. FPL `players.news` filtered to PRESS-CONF-RELEVANT patterns:
 *      • injury / knock / lack of match fitness / muscle / hamstring /
 *        ankle / knee / illness
 *      • "Suspended for the match against …" / "Suspended until …"
 *      • "% chance of playing"
 *      • "Expected back …" (for confirming injury timelines)
 *      Explicit excludes:
 *      • "has joined X permanently"  (off-season transfer)
 *      • "has joined X on loan"      (off-season loan)
 *      • "has departed the club"     (off-season exit)
 *      • "On loan to …"              (off-season loan)
 *      • "Signed by …"               (off-season exit)
 *
 *   2. Minutes engine — expected_minutes, start_prob, ninety_prob for
 *      THIS GW. Drives the predicted-XI picker and rotation flagging.
 *
 *   3. Yellow-card history — cumulative count to detect 5/10/15 bans.
 *
 *   4. Creator transcript signals from the last 48h. The FPL ecosystem
 *      doesn't give us direct manager-presser transcripts, but most
 *      FPL pundit channels record post-presser previews that quote the
 *      manager. We extract those by:
 *      • Filtering raw_quote for the team's manager surname
 *        (Pep / Arteta / Carrick / Slot / Iraola / Howe / …)
 *      • Surfacing those quotes as "Manager said (via {channel})"
 *      Everything else (generic captain debates, team-shuffle ideas) is
 *      DEMOTED to a separate "Pundit chatter" section so the user can
 *      tell signal from speculation.
 *
 *   5. teams.motivation_score — derived from PL position + stakes (in
 *      team-context.ts). Drives the "Dead rubber / Top-4 race / etc."
 *      label.
 *
 * Output: one TeamPressSummary per PL team, with predicted XI, Out /
 * Doubts / Banned columns, a narrative built from the manager quotes
 * (when we have them) + active flags, and the verbatim source quotes
 * linked to source videos so the user can verify.
 */

import { sql } from '@/lib/db/client';

// ─── public types ─────────────────────────────────────────────────────────────

export type Position = 'GKP' | 'DEF' | 'MID' | 'FWD';
export type Status   = 'a' | 'd' | 'i' | 'n' | 's' | 'u';
export type StarterTier = 'nailed' | 'likely' | 'rotation' | 'doubt' | 'out';
export type RotationSeverity = 'severe' | 'moderate' | 'mild' | 'none';

export interface PressQuote {
  channelName: string;
  videoTitle: string;
  rawQuote: string;
  timestampSec: number;
  videoUrl: string;
  publishedAt: string;
  signalKind: 'start' | 'bench' | 'injury';
  confidence: number;
  /** Set when the quote text contains the team's manager surname. */
  mentionsManager: boolean;
}

export interface PressPlayerLine {
  playerId: number;
  webName: string;
  position: Position;
  cost: number;
  status: Status;
  chanceOfPlayingNext: number | null;
  news: string | null;       // ONLY if press-conf relevant
  rawNews: string | null;    // full FPL news (we keep it for debugging)
  tier: StarterTier;
  expectedMinutes: number | null;
  startProb: number | null;
  seasonAvgMinsPerApp: number;
  minsDeltaVsSeason: number;
  ycSuspended: boolean;
  reasons: string[];
  freshQuotes: PressQuote[];
}

export interface RotationCandidate {
  playerId: number;
  webName: string;
  position: Position;
  cost: number;
  teamShort: string;
  teamName: string;
  expectedMinutes: number;
  startProb: number;
  ninetyProb: number;
  seasonAvgMinsPerApp: number;
  seasonStartRate: number;
  minsDeltaVsSeason: number;
  severity: RotationSeverity;
  status: Status;
  chanceOfPlayingNext: number | null;
  news: string | null;
  ycSuspended: boolean;
  reasons: string[];
  freshQuotes: PressQuote[];
  impactScore: number;
}

export interface PredictedXI {
  formation: { def: number; mid: number; fwd: number };
  starters: PressPlayerLine[];
  bench:    PressPlayerLine[];
}

export interface TeamPressSummary {
  teamId: number;
  teamShort: string;
  teamName: string;
  managerName: string | null;
  // Stakes & fixture context
  tablePosition:   number | null;
  motivation:      number | null;
  motivationLabel: string;
  fixtureSummary:  string;
  isHome:          boolean;
  // Predicted XI
  predictedXI: PredictedXI;
  // Status buckets (active-squad only)
  out:    PressPlayerLine[];
  doubts: PressPlayerLine[];
  banned: PressPlayerLine[];
  // Quotes split by whether they mention the manager
  managerQuotes: PressQuote[];    // quotes that explicitly cite the manager
  punditQuotes:  PressQuote[];    // everything else (creator analysis / debate)
  // Synthesised paragraph (2-5 sentences)
  latestNews:    string;
  newsUpdatedAt: string | null;
  headline:      string;
  // External team-news sources (Fantasy Football Scout etc.). Always
  // displayed with explicit source attribution + outbound link.
  externalNews?: ExternalTeamNews | null;
}

export interface ExternalTeamNews {
  source:       string;       // 'ff_scout'
  sourceLabel:  string;       // 'Fantasy Football Scout'
  sourceUrl:    string;       // back-link for attribution
  nextMatch:    string | null;
  formation:    string | null;
  predictedXi:  string[];
  out:          Array<{ name: string }>;
  doubts:       Array<{ name: string; percent: number | null }>;
  banned:       Array<{ name: string }>;
  latestNews:   string | null;
  lastUpdated:  string | null;
  fetchedAt:    string;       // ISO timestamp
}

// ─── managers ─────────────────────────────────────────────────────────────────

/**
 * Surnames / common short references for each PL team's manager as of
 * GW38 25/26. Used to detect when a creator quote is reporting what
 * the manager actually said (vs the creator's own opinion). Manually
 * curated; update as managers change.
 *
 * Add Pep + first names where short-form is heavily used in transcripts.
 */
const MANAGERS_BY_TEAM: Record<string, { manager: string; aliases: string[] }> = {
  ARS: { manager: 'Mikel Arteta',     aliases: ['Arteta'] },
  AVL: { manager: 'Unai Emery',       aliases: ['Emery'] },
  BOU: { manager: 'Andoni Iraola',    aliases: ['Iraola'] },
  BRE: { manager: 'Keith Andrews',    aliases: ['Andrews'] },
  BHA: { manager: 'Fabian Hürzeler',  aliases: ['Hurzeler', 'Hürzeler'] },
  BUR: { manager: 'Mike Jackson',     aliases: ['Jackson'] },
  CHE: { manager: 'Enzo Maresca',     aliases: ['Maresca', 'McFarlane'] },
  CRY: { manager: 'Oliver Glasner',   aliases: ['Glasner'] },
  EVE: { manager: 'David Moyes',      aliases: ['Moyes'] },
  FUL: { manager: 'Marco Silva',      aliases: ['Silva'] },
  LEE: { manager: 'Daniel Farke',     aliases: ['Farke'] },
  LIV: { manager: 'Arne Slot',        aliases: ['Slot'] },
  MCI: { manager: 'Pep Guardiola',    aliases: ['Guardiola', 'Pep'] },
  MUN: { manager: 'Michael Carrick',  aliases: ['Carrick'] },
  NEW: { manager: 'Eddie Howe',       aliases: ['Howe'] },
  NFO: { manager: 'Vítor Pereira',    aliases: ['Pereira'] },
  SUN: { manager: 'Régis Le Bris',    aliases: ['Le Bris'] },
  TOT: { manager: 'Roberto De Zerbi', aliases: ['De Zerbi'] },
  WHU: { manager: 'Nuno Espírito Santo', aliases: ['Nuno', 'Espirito Santo', 'Espírito Santo'] },
  WOL: { manager: 'Rob Edwards',      aliases: ['Edwards'] },
};

function managerMatchesQuote(quote: string, teamShort: string): boolean {
  const m = MANAGERS_BY_TEAM[teamShort];
  if (!m) return false;
  const lc = quote.toLowerCase();
  return m.aliases.some(a => lc.includes(a.toLowerCase()));
}

// ─── news filtering ───────────────────────────────────────────────────────────

/**
 * Is this `news` field text relevant to THIS week's press conference?
 * Off-season transfers and rest-of-season loans are EXCLUDED — they
 * tell us nothing about whether a player will feature on Sunday.
 */
function isPressConfRelevantNews(news: string | null): boolean {
  if (!news) return false;
  const s = news.toLowerCase();
  // Explicit excludes — off-season housekeeping.
  if (
    /has joined .* permanently/.test(s) ||
    /\bhas joined .* on loan\b/.test(s) ||
    /has departed the club/.test(s) ||
    /\bon loan to\b/.test(s) ||
    /signed by /.test(s) ||
    /season-long loan/.test(s)
  ) return false;
  // Includes — current-week press-conf signal.
  return (
    /\binjury\b|\bknock\b|\billness\b|\bfatigue\b|match fitness/.test(s) ||
    /\bhamstring|knee|ankle|foot|calf|muscle|shoulder|back|hip|achilles\b/.test(s) ||
    /chance of playing/.test(s) ||
    /\bsuspended\b/.test(s) ||
    /expected back/.test(s) ||
    /not available for the match/.test(s) ||
    /made unavailable for selection/.test(s)
  );
}

/**
 * Sub-class for "hard out THIS WEEK" — drives the engine's news-gate
 * and the page's Out column. Only fires on definitively-out news, not
 * on "knock 75% chance" or "expected back early next month".
 */
export function isHardOutByNews(news: string | null): boolean {
  if (!news) return false;
  const s = news.toLowerCase();
  // Same exclusions as above — never count "joined permanently" as
  // hard-out for THIS GW because the player has already left.
  if (
    /has joined .* permanently/.test(s) ||
    /\bhas joined .* on loan\b/.test(s) ||
    /has departed the club/.test(s) ||
    /\bon loan to\b/.test(s) ||
    /signed by /.test(s)
  ) return false;
  return (
    /\bsuspended\b/.test(s) ||
    /not available for the match/.test(s) ||
    /made unavailable for selection/.test(s)
  );
}

/**
 * Should this player be SHOWN on the press-conf page at all? Drops
 * players who already left the club for the summer (status='u' with
 * an off-season news string), regardless of season minutes. Keeps
 * everyone who could plausibly feature on Sunday.
 */
function isActiveSquadMember(p: ProjectionRow): boolean {
  // Already left the club — no point showing on a GW preview.
  const news = (p.news ?? '').toLowerCase();
  if (
    /has joined .* permanently/.test(news) ||
    /\bhas joined .* on loan\b/.test(news) ||
    /has departed the club/.test(news) ||
    /\bon loan to\b/.test(news) ||
    /signed by /.test(news) ||
    /season-long loan/.test(news)
  ) return false;
  // Status 'u' WITHOUT a "joined elsewhere" news string can still be
  // relevant (e.g. legally unavailable but on the roster). Rare; we
  // keep them and let the news string speak.
  // Drop fringe players who haven't played all season AND aren't flagged.
  if (p.season_minutes === 0 && p.status === 'a') return false;
  return true;
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function buildRotationWatchlist(
  gameweekId: number,
  opts: { withinHours?: number; limit?: number } = {}
): Promise<RotationCandidate[]> {
  const withinHours = opts.withinHours ?? 48;
  const limit       = opts.limit       ?? 25;

  const players = (await loadPlayerProjections(gameweekId)).filter(isActiveSquadMember);
  if (players.length === 0) return [];
  const ycSet          = await loadYcSuspended(players.map(p => p.id));
  const quotesByPlayer = await loadFreshQuotes(players.map(p => p.id), withinHours);

  const out: RotationCandidate[] = [];
  for (const p of players) {
    if (p.appearances < 8) continue;
    const seasonAvg = p.season_avg_mins_per_app;
    const delta = p.expected_minutes - seasonAvg;
    const cop = p.chance_of_playing_next_round;
    const yc = ycSet.has(p.id);
    if (delta >= -5 && p.status === 'a' && (cop ?? 100) >= 100 && !yc) continue;
    const severity = classifySeverity(delta, p.status, cop, p.news, yc);
    if (severity === 'none') continue;
    const reasons = buildReasonsForPlayer(p, yc);
    const fresh = quotesByPlayer.get(p.id) ?? [];
    // Tag manager-mentioning quotes — feed back into reasons.
    const quotes = fresh.map(q => ({
      ...q,
      mentionsManager: managerMatchesQuote(q.rawQuote, p.team_short),
    }));
    for (const q of quotes.slice(0, 2)) {
      const tag =
        q.signalKind === 'start' ? '✓ start' :
        q.signalKind === 'bench' ? '✗ bench' :
                                    '⚕ injury';
      const prefix = q.mentionsManager ? `${q.channelName} (manager quote)` : q.channelName;
      reasons.push(`${prefix} ${tag}: "${truncate(q.rawQuote, 110)}"`);
    }
    const sevWeight = severity === 'severe' ? 4 : severity === 'moderate' ? 2 : 1;
    const impactScore = sevWeight * Math.max(1, p.now_cost / 10);
    out.push({
      playerId: p.id, webName: p.web_name, position: p.position, cost: p.now_cost,
      teamShort: p.team_short, teamName: p.team_name,
      expectedMinutes: p.expected_minutes, startProb: p.start_prob, ninetyProb: p.ninety_prob,
      seasonAvgMinsPerApp: seasonAvg,
      seasonStartRate: p.season_starts > 0 && p.team_games > 0 ? p.season_starts / p.team_games : 0,
      minsDeltaVsSeason: delta,
      severity,
      status: p.status,
      chanceOfPlayingNext: cop,
      news: isPressConfRelevantNews(p.news) ? p.news : null,
      ycSuspended: yc,
      reasons,
      freshQuotes: quotes,
      impactScore,
    });
  }
  out.sort((a, b) => b.impactScore - a.impactScore);
  return out.slice(0, limit);
}

export async function buildPressConferenceSummary(
  gameweekId: number,
  opts: { withinHours?: number } = {}
): Promise<TeamPressSummary[]> {
  const withinHours = opts.withinHours ?? 48;

  type TeamRow = {
    id: number; name: string; short_name: string;
    table_position: number | null;
    motivation_score: number | null;
  };
  const teams = await sql<TeamRow[]>`
    SELECT id, name, short_name, table_position, motivation_score
    FROM teams ORDER BY short_name
  `;
  if (teams.length === 0) return [];

  type FixtureRow = {
    team_h: number; team_a: number;
    h_short: string; a_short: string; h_name: string; a_name: string;
  };
  const fixtures = await sql<FixtureRow[]>`
    SELECT f.team_h, f.team_a,
           h.short_name AS h_short, a.short_name AS a_short,
           h.name AS h_name, a.name AS a_name
    FROM fixtures f
    JOIN teams h ON h.id = f.team_h
    JOIN teams a ON a.id = f.team_a
    WHERE f.gameweek_id = ${gameweekId} AND f.finished = FALSE
  `;
  type FxInfo = { opp: string; oppName: string; isHome: boolean };
  const fixtureByTeam = new Map<number, FxInfo>();
  for (const f of fixtures) {
    fixtureByTeam.set(f.team_h, { opp: f.a_short, oppName: f.a_name, isHome: true });
    fixtureByTeam.set(f.team_a, { opp: f.h_short, oppName: f.h_name, isHome: false });
  }

  const allProjRows = await loadPlayerProjections(gameweekId);
  const projRows    = allProjRows.filter(isActiveSquadMember);
  const ycSet       = await loadYcSuspended(projRows.map(p => p.id));
  const projByTeam  = new Map<number, ProjectionRow[]>();
  for (const p of projRows) {
    if (!projByTeam.has(p.team_id)) projByTeam.set(p.team_id, []);
    projByTeam.get(p.team_id)!.push(p);
  }
  const rawQuotesByPlayer = await loadFreshQuotes(projRows.map(p => p.id), withinHours);
  const externalByTeam    = await loadExternalTeamNews();

  const out: TeamPressSummary[] = [];
  for (const t of teams) {
    const ps = projByTeam.get(t.id) ?? [];
    const managerInfo = MANAGERS_BY_TEAM[t.short_name] ?? null;
    const managerName = managerInfo?.manager ?? null;

    // Quotes tagged with mentionsManager + carried per player.
    const tagQuote = (q: PressQuote): PressQuote => ({
      ...q,
      mentionsManager: managerMatchesQuote(q.rawQuote, t.short_name),
    });

    const lines: PressPlayerLine[] = ps.map(p => {
      const yc = ycSet.has(p.id);
      const quotes = (rawQuotesByPlayer.get(p.id) ?? []).map(tagQuote);
      return buildPlayerLine(p, quotes, yc);
    });

    // Predicted XI from the engine.
    const predictedXI = pickPredictedXI(lines);

    // Active flags. Banned = explicit suspension. Out = hard-out by news OR
    // status i/u/n. Doubts = status='d' or chance<100, not already out/banned.
    const banned = lines.filter(l => l.ycSuspended ||
      l.status === 's' ||
      (l.news && /\bsuspended\b/.test(l.news.toLowerCase()))
    );
    const out_ = lines.filter(l =>
      l.tier === 'out' && !banned.some(b => b.playerId === l.playerId)
    );
    const doubts = lines.filter(l =>
      (l.status === 'd' ||
       (l.chanceOfPlayingNext !== null && l.chanceOfPlayingNext < 100)
      ) &&
      l.tier !== 'out' &&
      !banned.some(b => b.playerId === l.playerId)
    );

    // Aggregate team-level quote list, deduped, sorted by freshness.
    const allQuotes = lines.flatMap(l => l.freshQuotes);
    const seen = new Set<string>();
    const dedupedAll: PressQuote[] = [];
    for (const q of allQuotes.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
      const key = `${q.videoUrl.split('?')[0]}::${q.signalKind}::${q.rawQuote.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupedAll.push(q);
    }
    // Split: quotes that mention the manager vs everything else.
    const managerQuotes = dedupedAll.filter(q => q.mentionsManager).slice(0, 6);
    const punditQuotes  = dedupedAll.filter(q => !q.mentionsManager).slice(0, 6);

    const motivation = t.motivation_score == null ? null : Number(t.motivation_score);
    const motivationLabel = describeMotivation(motivation, t.table_position);
    const fixtureSummary = fixtureByTeam.get(t.id)
      ? (fixtureByTeam.get(t.id)!.isHome
          ? `vs ${fixtureByTeam.get(t.id)!.opp} (H)`
          : `at ${fixtureByTeam.get(t.id)!.opp} (A)`)
      : 'No fixture';

    const narrative = synthesiseLatestNews({
      teamShort: t.short_name,
      managerName,
      fixture: fixtureByTeam.get(t.id),
      motivation,
      motivationLabel,
      out:    out_,
      doubts,
      banned,
      predictedXI,
      managerQuotes,
      punditQuotes,
    });

    const newsUpdatedAt = dedupedAll[0]?.publishedAt ?? null;

    // Headline: most actionable single line.
    let headline = '';
    if (banned.length > 0 && out_.length > 0) {
      headline = `Banned: ${listNamesFlat(banned)} · Out: ${listNamesFlat(out_, 3)}`;
    } else if (banned.length > 0) {
      headline = `Banned: ${listNamesFlat(banned)}`;
    } else if (out_.length > 0) {
      headline = `Out: ${listNamesFlat(out_, 3)}`;
    } else if (doubts.length > 0) {
      headline = `Doubts: ${doubts.slice(0,3).map(d =>
        `${d.webName} ${d.chanceOfPlayingNext ?? '?'}%`).join(', ')}`;
    } else if (motivation !== null && motivation < 0.4) {
      headline = `${motivationLabel} — rotation possible`;
    } else {
      headline = `${motivationLabel} — clean bill of health`;
    }

    out.push({
      teamId: t.id, teamShort: t.short_name, teamName: t.name, managerName,
      tablePosition: t.table_position,
      motivation, motivationLabel,
      fixtureSummary, isHome: fixtureByTeam.get(t.id)?.isHome ?? false,
      predictedXI,
      out: out_, doubts, banned,
      managerQuotes, punditQuotes,
      latestNews: narrative, newsUpdatedAt,
      headline,
      externalNews: externalByTeam.get(t.id) ?? null,
    });
  }
  return out;
}

// ─── data loaders ─────────────────────────────────────────────────────────────

type ProjectionRow = {
  id: number; team_id: number; team_short: string; team_name: string;
  web_name: string; position: Position;
  now_cost: number; status: Status;
  chance_of_playing_next_round: number | null;
  news: string | null;
  expected_minutes: number; start_prob: number; ninety_prob: number;
  season_minutes: number; season_starts: number;
  season_avg_mins_per_app: number;
  appearances: number; team_games: number;
};

async function loadPlayerProjections(gameweekId: number): Promise<ProjectionRow[]> {
  return sql<ProjectionRow[]>`
    WITH apps AS (
      SELECT pgh.player_id,
             COUNT(*) FILTER (WHERE pgh.minutes > 0)::int AS appearances,
             SUM(pgh.minutes)::float                       AS total_mins
      FROM player_gameweek_history pgh
      JOIN fixtures f ON f.id = pgh.fixture_id
      WHERE f.finished = TRUE
      GROUP BY pgh.player_id
    ),
    team_games AS (
      SELECT t.id AS team_id,
             COUNT(*) FILTER (WHERE f.finished = TRUE)::int AS games
      FROM teams t
      LEFT JOIN fixtures f ON (f.team_h = t.id OR f.team_a = t.id)
      GROUP BY t.id
    )
    SELECT p.id, p.team_id,
           t.short_name AS team_short, t.name AS team_name,
           p.web_name, p.position, p.now_cost, p.status,
           p.chance_of_playing_next_round, p.news,
           COALESCE(mp.expected_minutes, 0)::float AS expected_minutes,
           COALESCE(mp.start_prob,        0)::float AS start_prob,
           COALESCE(mp.ninety_prob,       0)::float AS ninety_prob,
           p.season_minutes, p.season_starts,
           CASE WHEN COALESCE(a.appearances, 0) > 0
                THEN COALESCE(a.total_mins, p.season_minutes) / a.appearances
                ELSE COALESCE(p.season_minutes::float / NULLIF(p.season_starts, 0), 0)
           END::float AS season_avg_mins_per_app,
           COALESCE(a.appearances, 0) AS appearances,
           COALESCE(tg.games, 1) AS team_games
    FROM players p
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN apps a ON a.player_id = p.id
    LEFT JOIN team_games tg ON tg.team_id = p.team_id
    LEFT JOIN LATERAL (
      SELECT mp.expected_minutes, mp.start_prob, mp.ninety_prob
      FROM minutes_projections mp
      JOIN fixtures f ON f.id = mp.fixture_id
      WHERE mp.player_id = p.id AND f.gameweek_id = ${gameweekId}
      ORDER BY mp.expected_minutes DESC NULLS LAST LIMIT 1
    ) mp ON TRUE
    WHERE p.now_cost > 0
  `;
}

async function loadYcSuspended(playerIds: number[]): Promise<Set<number>> {
  if (playerIds.length === 0) return new Set();
  const rows = await sql<Array<{ player_id: number; cum: number; before_last: number }>>`
    WITH match_yc AS (
      SELECT pgh.player_id, pgh.gameweek_id, pgh.yellow_cards,
             (SELECT MAX(gameweek_id) FROM fixtures WHERE finished = TRUE) AS last_gw
      FROM player_gameweek_history pgh
      JOIN fixtures f ON f.id = pgh.fixture_id
      WHERE f.finished = TRUE
        AND pgh.player_id IN ${sql(playerIds as any)}
    )
    SELECT player_id,
           SUM(yellow_cards)::int AS cum,
           SUM(CASE WHEN gameweek_id < last_gw THEN yellow_cards ELSE 0 END)::int AS before_last
    FROM match_yc
    GROUP BY player_id
  `;
  const out = new Set<number>();
  for (const r of rows) {
    const before = r.before_last; const total = r.cum;
    if ((before < 5 && total >= 5) ||
        (before < 10 && total >= 10) ||
        (before < 15 && total >= 15)) {
      out.add(r.player_id);
    }
  }
  return out;
}

async function loadFreshQuotes(
  playerIds: number[],
  withinHours: number
): Promise<Map<number, PressQuote[]>> {
  const m = new Map<number, PressQuote[]>();
  if (playerIds.length === 0) return m;
  type Row = {
    player_id: number;
    signal_kind: 'start' | 'bench' | 'injury';
    raw_quote: string; timestamp_sec: number; confidence: number;
    video_url: string; video_title: string; channel_name: string;
    published_at: string;
  };
  const rows = await sql<Row[]>`
    SELECT s.player_id,
           s.signal_kind::text AS signal_kind,
           s.raw_quote, s.timestamp_sec, s.confidence::float AS confidence,
           v.url AS video_url, v.title AS video_title, v.channel_name,
           v.published_at::text AS published_at
    FROM transcript_signals s
    JOIN youtube_videos v ON v.video_id = s.video_id
    WHERE s.signal_kind IN ('start', 'bench', 'injury')
      AND v.published_at > now() - (${withinHours} || ' hours')::interval
      AND s.player_id IN ${sql(playerIds as any)}
      AND (s.user_action IS NULL OR s.user_action = 'accepted')
    ORDER BY v.published_at DESC, s.confidence DESC
  `;
  for (const r of rows) {
    const url = r.video_url + (r.video_url.includes('?') ? '&' : '?') + `t=${r.timestamp_sec}`;
    const q: PressQuote = {
      channelName: r.channel_name, videoTitle: r.video_title,
      rawQuote: r.raw_quote, timestampSec: r.timestamp_sec,
      videoUrl: url, publishedAt: r.published_at,
      signalKind: r.signal_kind, confidence: r.confidence,
      mentionsManager: false,    // set later when we know the team
    };
    if (!m.has(r.player_id)) m.set(r.player_id, []);
    m.get(r.player_id)!.push(q);
  }
  return m;
}

/**
 * External team-news (Fantasy Football Scout etc.). Pulls the latest row
 * per team from team_news_external. Tolerates the table not existing yet
 * (returns empty map) so the page renders before the migration is run.
 */
async function loadExternalTeamNews(): Promise<Map<number, ExternalTeamNews>> {
  const m = new Map<number, ExternalTeamNews>();
  try {
    type Row = {
      team_id: number; source: string; source_label: string; source_url: string;
      next_match: string | null; formation: string | null;
      predicted_xi: any; out_list: any; doubts: any; banned: any;
      latest_news: string | null; last_updated_at: string | null;
      fetched_at: string;
    };
    const rows = await sql<Row[]>`
      SELECT team_id, source, source_label, source_url,
             next_match, formation, predicted_xi, out_list, doubts, banned,
             latest_news, last_updated_at, fetched_at::text AS fetched_at
      FROM team_news_external
      ORDER BY fetched_at DESC
    `;
    // For each team, keep only the most-recent row.
    for (const r of rows) {
      if (m.has(r.team_id)) continue;
      m.set(r.team_id, {
        source: r.source,
        sourceLabel: r.source_label,
        sourceUrl: r.source_url,
        nextMatch: r.next_match,
        formation: r.formation,
        predictedXi: Array.isArray(r.predicted_xi) ? r.predicted_xi : [],
        out: Array.isArray(r.out_list) ? r.out_list : [],
        doubts: Array.isArray(r.doubts) ? r.doubts : [],
        banned: Array.isArray(r.banned) ? r.banned : [],
        latestNews: r.latest_news,
        lastUpdated: r.last_updated_at,
        fetchedAt: r.fetched_at,
      });
    }
  } catch (err) {
    // Table missing (migration not yet applied) — log and continue.
    console.warn(`[press-conf] loadExternalTeamNews skipped: ${(err as Error).message}`);
  }
  return m;
}

// ─── classification ───────────────────────────────────────────────────────────

function buildPlayerLine(p: ProjectionRow, quotes: PressQuote[], yc: boolean): PressPlayerLine {
  const seasonAvg = p.season_avg_mins_per_app;
  const delta = p.expected_minutes - seasonAvg;
  const tier = classifyTier(p, delta, yc);
  return {
    playerId: p.id,
    webName: p.web_name,
    position: p.position,
    cost: p.now_cost,
    status: p.status,
    chanceOfPlayingNext: p.chance_of_playing_next_round,
    news: isPressConfRelevantNews(p.news) ? p.news : null,
    rawNews: p.news,
    tier,
    expectedMinutes: p.expected_minutes,
    startProb: p.start_prob,
    seasonAvgMinsPerApp: seasonAvg,
    minsDeltaVsSeason: delta,
    ycSuspended: yc,
    reasons: buildReasonsForPlayer(p, yc),
    freshQuotes: quotes,
  };
}

function classifyTier(p: ProjectionRow, delta: number, yc: boolean): StarterTier {
  if (yc) return 'out';
  if (isHardOutByNews(p.news)) return 'out';
  if (p.status === 'i' || p.status === 's') return 'out';
  // status='u' alone shouldn't mean out unless the player is clearly gone
  // (handled by isActiveSquadMember). Treat 'u' here as out anyway since
  // they aren't expected to feature.
  if (p.status === 'u') return 'out';
  if (p.status === 'n') return 'out';
  const cop = p.chance_of_playing_next_round;
  if (p.status === 'd' && (cop ?? 50) <= 50) return 'out';
  if (cop !== null && cop < 75) return 'doubt';
  if (p.start_prob >= 0.85 && p.expected_minutes >= 75 && delta >= -8) return 'nailed';
  if (p.start_prob >= 0.55 && delta >= -15) return 'likely';
  if (p.expected_minutes < 25) return 'rotation';
  if (delta < -20) return 'rotation';
  return 'likely';
}

function classifySeverity(
  delta: number, status: Status, cop: number | null, news: string | null, yc: boolean
): RotationSeverity {
  if (yc) return 'severe';
  if (isHardOutByNews(news)) return 'severe';
  if (status === 'i' || status === 's' || status === 'u' || status === 'n') return 'severe';
  if (status === 'd' && (cop ?? 50) <= 50) return 'severe';
  if (delta <= -40) return 'severe';
  if (delta <= -20) return 'moderate';
  if (delta <= -8)  return 'mild';
  if (cop !== null && cop < 100) return 'mild';
  return 'none';
}

function buildReasonsForPlayer(p: ProjectionRow, yc: boolean): string[] {
  const reasons: string[] = [];
  const seasonAvg = p.season_avg_mins_per_app;
  const delta = p.expected_minutes - seasonAvg;
  const pressRelevantNews = isPressConfRelevantNews(p.news) ? p.news : null;

  if (yc) reasons.push('Yellow-card threshold reached last GW — 1-match ban');
  if (isHardOutByNews(p.news)) {
    reasons.push(`Ruled out: ${truncate(p.news ?? '', 90)}`);
  } else if (p.status === 'i') {
    reasons.push(`FPL injured${pressRelevantNews ? ` — ${truncate(pressRelevantNews, 80)}` : ''}`);
  } else if (p.status === 's') {
    reasons.push(`FPL suspended${pressRelevantNews ? ` — ${truncate(pressRelevantNews, 80)}` : ''}`);
  } else if (p.status === 'n') {
    reasons.push(`Not available for this match${pressRelevantNews ? ` — ${truncate(pressRelevantNews, 80)}` : ''}`);
  } else if (p.status === 'd' && p.chance_of_playing_next_round != null) {
    reasons.push(`FPL doubt — ${p.chance_of_playing_next_round}% chance${pressRelevantNews ? ` (${truncate(pressRelevantNews, 60)})` : ''}`);
  } else if (p.chance_of_playing_next_round != null && p.chance_of_playing_next_round < 100) {
    reasons.push(`FPL chance ${p.chance_of_playing_next_round}% (yellow flag)`);
  }

  if (delta <= -10 && seasonAvg > 60) {
    reasons.push(`Engine: ${Math.round(p.expected_minutes)} mins vs ${Math.round(seasonAvg)} season avg (${delta >= 0 ? '+' : ''}${Math.round(delta)})`);
  } else if (p.expected_minutes < 30 && seasonAvg > 50) {
    reasons.push(`Bench/cameo likely (${Math.round(p.expected_minutes)} mins expected)`);
  }
  return reasons;
}

function describeMotivation(motivation: number | null, position: number | null): string {
  if (motivation == null) return 'Motivation unknown';
  // Motivation comes from team-context.ts — it's already 0.10 when every
  // boundary (title/top-4/top-6/relegation) is mathematically settled.
  // So the band of 0.7+ here only fires when an open-ended chase remains.
  if (motivation >= 0.85 && position != null && position >= 17 && position <= 18) {
    return 'Relegation decider — full strength';
  }
  if (motivation >= 0.7 && position != null && position <= 6) {
    return 'European chase — full strength';
  }
  if (motivation >= 0.7) return 'Stakes remain — full XI expected';
  if (motivation >= 0.4) return 'Reduced stakes — some rotation possible';
  if (motivation >= 0.2) return 'Little to play for — heavy rotation likely';
  return 'Nothing to play for — expect rotation';
}

// ─── predicted XI ─────────────────────────────────────────────────────────────

function pickPredictedXI(lines: PressPlayerLine[]): PredictedXI {
  const available = lines
    .filter(l => l.tier !== 'out')
    .slice()
    .sort((a, b) => {
      const aConf = (a.startProb ?? 0) >= 0.99;
      const bConf = (b.startProb ?? 0) >= 0.99;
      if (aConf !== bConf) return aConf ? -1 : 1;
      const aMins = a.expectedMinutes ?? 0;
      const bMins = b.expectedMinutes ?? 0;
      if (aMins !== bMins) return bMins - aMins;
      return (b.startProb ?? 0) - (a.startProb ?? 0);
    });

  const gk = available.find(p => p.position === 'GKP');
  const starters: PressPlayerLine[] = [];
  if (gk) starters.push(gk);

  const counts = { DEF: 0, MID: 0, FWD: 0 };
  const max = { DEF: 5, MID: 5, FWD: 3 };
  const minimaQueue: Position[] = ['DEF','DEF','DEF','MID','MID','FWD'];

  for (const need of minimaQueue) {
    const pick = available.find(p =>
      p.position === need && !starters.includes(p) &&
      counts[need as 'DEF'|'MID'|'FWD'] < max[need as 'DEF'|'MID'|'FWD']
    );
    if (pick) { starters.push(pick); counts[need as 'DEF'|'MID'|'FWD'] += 1; }
  }
  for (const p of available) {
    if (starters.length >= 11) break;
    if (p.position === 'GKP') continue;
    if (starters.includes(p)) continue;
    const pos = p.position as 'DEF'|'MID'|'FWD';
    if (counts[pos] < max[pos]) {
      starters.push(p); counts[pos] += 1;
    }
  }
  const final = starters.slice(0, 11);
  const bench = available.filter(p => !final.includes(p)).slice(0, 5);
  return {
    formation: {
      def: final.filter(p => p.position === 'DEF').length,
      mid: final.filter(p => p.position === 'MID').length,
      fwd: final.filter(p => p.position === 'FWD').length,
    },
    starters: final, bench,
  };
}

// ─── narrative synthesis ──────────────────────────────────────────────────────

interface NarrativeInputs {
  teamShort: string;
  managerName: string | null;
  fixture: { opp: string; oppName: string; isHome: boolean } | undefined;
  motivation: number | null;
  motivationLabel: string;
  out: PressPlayerLine[];
  doubts: PressPlayerLine[];
  banned: PressPlayerLine[];
  predictedXI: PredictedXI;
  managerQuotes: PressQuote[];
  punditQuotes: PressQuote[];
}

/**
 * Synthesise the team-news paragraph. When we have manager-quotes
 * (creator quotes that explicitly mention the manager), they LEAD
 * the paragraph because that's the closest we get to a real
 * press-conference summary. When we don't, we fall back to
 * fixture + motivation + flags.
 */
function synthesiseLatestNews(n: NarrativeInputs): string {
  const sentences: string[] = [];

  // 1. Fixture + motivation.
  if (n.fixture) {
    const fx = n.fixture.isHome ? `host ${n.fixture.oppName}` : `travel to ${n.fixture.oppName}`;
    sentences.push(`${n.teamShort} ${fx}. ${n.motivationLabel}.`);
  } else {
    sentences.push(`${n.teamShort}: ${n.motivationLabel}.`);
  }

  // 2. Manager-attributed quotes (highest signal). Phrase as "via {channel}"
  //    so it's clear the quote is a creator's report of what the manager said,
  //    not a primary transcript.
  if (n.managerQuotes.length > 0 && n.managerName) {
    // Cluster by signal_kind so we say "X reported the manager hinted at Y".
    const startMentions = n.managerQuotes.filter(q => q.signalKind === 'start').length;
    const benchMentions = n.managerQuotes.filter(q => q.signalKind === 'bench').length;
    const injuryMentions = n.managerQuotes.filter(q => q.signalKind === 'injury').length;
    const bits: string[] = [];
    if (startMentions > 0) bits.push(`a confirmed starter`);
    if (benchMentions > 0) bits.push(`possible rotation`);
    if (injuryMentions > 0) bits.push(`an injury concern`);
    sentences.push(
      `Creators reporting on ${n.managerName}'s presser surface ${bits.join(', ')}` +
      ` — see the manager-quote panel below for the verbatim sources.`
    );
  } else if (n.managerName) {
    sentences.push(`No press-conf coverage of ${n.managerName} in the last 48h — relying on FPL flags only.`);
  }

  // 3. Absences roll-up.
  const absentParts: string[] = [];
  if (n.banned.length > 0) absentParts.push(`${listNamesFlat(n.banned)} banned`);
  if (n.out.length > 0)    absentParts.push(`${listNamesFlat(n.out, 4)} out`);
  if (n.doubts.length > 0) {
    const dfmt = n.doubts.slice(0, 4).map(l => {
      const c = l.chanceOfPlayingNext;
      return c != null ? `${l.webName} (${c}%)` : l.webName;
    }).join(', ');
    absentParts.push(`doubts on ${dfmt}`);
  }
  if (absentParts.length > 0) {
    sentences.push(capitalise(absentParts.join('; ')) + '.');
  } else {
    sentences.push('No fitness flags from FPL bootstrap.');
  }

  // 4. Engine takeaway — rotation likely?
  const subThresholdStarters = n.predictedXI.starters.filter(s =>
    (s.expectedMinutes ?? 0) < 70 && s.seasonAvgMinsPerApp > 75
  );
  if (subThresholdStarters.length >= 3) {
    sentences.push(`Engine projects ${subThresholdStarters.length} of the predicted XI under 70 mins (${listNamesFlat(subThresholdStarters, 3)}) — managed minutes likely.`);
  } else if (subThresholdStarters.length >= 1) {
    sentences.push(`Engine expects reduced minutes for ${listNamesFlat(subThresholdStarters, 3)}.`);
  } else if (n.motivation !== null && n.motivation < 0.4 && n.out.length === 0 && n.doubts.length === 0) {
    sentences.push('No specific lineup leaks — but dead-rubber stakes mean wholesale changes from the bench are possible.');
  }
  return sentences.join(' ');
}

function listNamesFlat(ps: PressPlayerLine[], cap = 3): string {
  if (ps.length === 0) return '';
  const names = ps.slice(0, cap).map(p => p.webName);
  if (ps.length <= cap) {
    return names.length <= 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names[names.length-1];
  }
  return `${names.join(', ')} (+${ps.length - cap} more)`;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}
