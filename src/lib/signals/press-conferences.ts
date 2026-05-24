/**
 * Press-conference / team-news engine — GW-FOCUSED.
 *
 * Produces per-team blocks similar in shape to Fantasy Football Scout's
 * team-news page, but built deterministically from our own data sources:
 *
 *   • FPL bootstrap        — status, news, chance_of_playing_next_round
 *   • Minutes engine       — expected_minutes, start_prob, ninety_prob
 *   • teams.motivation     — derived in team-context.ts (table position +
 *                            stakes remaining)
 *   • transcript_signals   — verbatim quotes from FPL creator YouTube
 *                            videos in the last 48 hours, classified as
 *                            start / bench / injury per (player, video).
 *   • Yellow-card history  — cumulative YC counts to detect 5/10/15 bans
 *                            FPL hasn't yet flipped to status='s'.
 *
 * Per team we expose:
 *
 *   • Fixture, motivation context
 *   • Predicted XI (11 players, legal formation)
 *   • Out:    status ∈ {i, s, u, n} OR hard-out news OR yc-ban
 *   • Doubts: status='d' OR chance_of_playing < 100 (with %)
 *   • Banned: ycSuspended OR status='s' (subset of "Out" but flagged
 *             separately because the user usually wants to see them)
 *   • Latest News paragraph: 2-4 sentences stitched from the freshest
 *     creator quotes + FPL flags + motivation + suspension counts.
 *     Quotes are paraphrased into our own phrasing then linked back to
 *     the source video at the timestamp.
 *
 * Plus a top-level Rotation Watchlist that ranks players globally by
 * how much their expected minutes for THIS GW are below their season
 * average — same lens as FPLReview's heavy-rotation flags.
 *
 * Everything is GW-scoped (current/next finished=false) and quote-windowed
 * to the last 48 hours by default.
 */

import { sql } from '@/lib/db/client';

// ─── public types ─────────────────────────────────────────────────────────────

export type Position        = 'GKP' | 'DEF' | 'MID' | 'FWD';
export type Status          = 'a' | 'd' | 'i' | 'n' | 's' | 'u';
export type StarterTier     = 'nailed' | 'likely' | 'rotation' | 'doubt' | 'out';
export type RotationSeverity = 'severe' | 'moderate' | 'mild' | 'none';

export interface PressQuote {
  channelName: string;
  videoTitle:  string;
  rawQuote:    string;
  timestampSec: number;
  videoUrl:    string;
  publishedAt: string;
  signalKind:  'start' | 'bench' | 'injury';
  confidence:  number;
}

export interface PressPlayerLine {
  playerId:  number;
  webName:   string;
  position:  Position;
  cost:      number;                     // tenths
  status:    Status;
  chanceOfPlayingNext: number | null;
  news:      string | null;
  tier:      StarterTier;
  expectedMinutes:      number | null;
  startProb:            number | null;
  seasonAvgMinsPerApp:  number;
  minsDeltaVsSeason:    number;
  ycSuspended:          boolean;
  reasons:    string[];
  freshQuotes: PressQuote[];
}

export interface RotationCandidate {
  playerId: number;
  webName:  string;
  position: Position;
  cost:     number;
  teamShort: string;
  teamName:  string;
  expectedMinutes: number;
  startProb:        number;
  ninetyProb:       number;
  seasonAvgMinsPerApp: number;
  seasonStartRate:     number;
  minsDeltaVsSeason:   number;
  severity:  RotationSeverity;
  status:    Status;
  chanceOfPlayingNext: number | null;
  news:      string | null;
  ycSuspended: boolean;
  reasons: string[];
  freshQuotes: PressQuote[];
  impactScore: number;
}

export interface PredictedXI {
  formation: { def: number; mid: number; fwd: number };
  starters:  PressPlayerLine[];     // 11 players, GKP first
  bench:     PressPlayerLine[];     // up to 5 (we don't know the FPL squad)
}

export interface TeamPressSummary {
  teamId:    number;
  teamShort: string;
  teamName:  string;
  // Stakes & fixture context
  tablePosition:   number | null;
  motivation:      number | null;    // 0..1
  motivationLabel: string;           // human label
  fixtureSummary:  string;           // "vs Burnley (H)" / "at City (A)"
  isHome:          boolean;
  // Predicted XI
  predictedXI: PredictedXI;
  // Status buckets
  out:     PressPlayerLine[];        // any status i/s/u/n OR hard-out news OR yc-ban
  doubts:  PressPlayerLine[];        // status='d' OR chance < 100
  banned:  PressPlayerLine[];        // suspensions specifically
  // The narrative
  latestNews:   string;              // synthesised paragraph (2-4 sentences)
  newsUpdatedAt: string | null;      // newest published_at across quotes used
  teamLevelQuotes: PressQuote[];     // full quote list for the verify-it panel
  // 1-line scan-friendly takeaway
  headline: string;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Rotation Watchlist for the upcoming GW. Ranks players globally by
 * impact (severity × cost), filters out anyone whose expected minutes
 * are within 5 of their season average and who has no other flag.
 */
export async function buildRotationWatchlist(
  gameweekId: number,
  opts: { withinHours?: number; limit?: number } = {}
): Promise<RotationCandidate[]> {
  const withinHours = opts.withinHours ?? 48;
  const limit       = opts.limit       ?? 25;

  const players = await loadPlayerProjections(gameweekId);
  if (players.length === 0) return [];
  const ycSet = await loadYcSuspended(players.map(p => p.id));
  const quotesByPlayer = await loadFreshQuotes(players.map(p => p.id), withinHours);

  const candidates: RotationCandidate[] = [];
  for (const p of players) {
    if (p.appearances < 8) continue;            // need a season anchor
    const seasonAvg = p.season_avg_mins_per_app;
    const expected  = p.expected_minutes;
    const delta     = expected - seasonAvg;
    const yc = ycSet.has(p.id);
    const cop = p.chance_of_playing_next_round;
    if (
      delta >= -5 &&
      p.status === 'a' &&
      (cop ?? 100) >= 100 &&
      !yc
    ) continue;
    const severity = classifySeverity(delta, p.status, cop, p.news, yc);
    if (severity === 'none') continue;
    const reasons = buildReasonsForPlayer(p, yc);
    const freshQuotes = quotesByPlayer.get(p.id) ?? [];
    for (const q of freshQuotes.slice(0, 2)) {
      const tag =
        q.signalKind === 'start' ? '✓ start' :
        q.signalKind === 'bench' ? '✗ bench risk' :
                                    '⚕ injury concern';
      reasons.push(`${q.channelName} (${tag}): "${truncate(q.rawQuote, 110)}"`);
    }
    const sevWeight = severity === 'severe' ? 4 : severity === 'moderate' ? 2 : 1;
    const impactScore = sevWeight * Math.max(1, p.now_cost / 10);
    candidates.push({
      playerId: p.id,
      webName: p.web_name,
      position: p.position,
      cost: p.now_cost,
      teamShort: p.team_short,
      teamName: p.team_name,
      expectedMinutes: expected,
      startProb: p.start_prob,
      ninetyProb: p.ninety_prob,
      seasonAvgMinsPerApp: seasonAvg,
      seasonStartRate: p.season_starts > 0 && p.team_games > 0
        ? p.season_starts / p.team_games : 0,
      minsDeltaVsSeason: delta,
      severity,
      status: p.status,
      chanceOfPlayingNext: cop,
      news: p.news,
      ycSuspended: yc,
      reasons,
      freshQuotes,
      impactScore,
    });
  }
  candidates.sort((a, b) => b.impactScore - a.impactScore);
  return candidates.slice(0, limit);
}

/**
 * Per-team team-news cards. Quotes constrained to last 48h by default.
 */
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
    h_short: string; a_short: string;
    h_name:  string; a_name:  string;
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

  const projRows = await loadPlayerProjections(gameweekId);
  const ycSet    = await loadYcSuspended(projRows.map(p => p.id));
  const projByTeam = new Map<number, ProjectionRow[]>();
  for (const p of projRows) {
    if (!projByTeam.has(p.team_id)) projByTeam.set(p.team_id, []);
    projByTeam.get(p.team_id)!.push(p);
  }
  const quotesByPlayer = await loadFreshQuotes(projRows.map(p => p.id), withinHours);

  const out: TeamPressSummary[] = [];
  for (const t of teams) {
    const fx = fixtureByTeam.get(t.id);
    const ps = (projByTeam.get(t.id) ?? [])
      // Drop deep-fringe players — too noisy.
      .filter(p =>
        p.season_minutes > 200 ||
        p.status !== 'a' ||
        p.chance_of_playing_next_round !== null
      );

    const lines: PressPlayerLine[] = ps.map(p => {
      const yc = ycSet.has(p.id);
      return buildPlayerLine(p, quotesByPlayer.get(p.id) ?? [], yc);
    });

    // Predicted XI from the engine (legal 4-4-2-ish formation).
    const predictedXI = pickPredictedXI(lines);

    // Status buckets.
    const banned = lines.filter(l => l.ycSuspended || l.status === 's');
    const out_   = lines.filter(l =>
      l.tier === 'out' && !banned.some(b => b.playerId === l.playerId)
    );
    const doubts = lines.filter(l =>
      (l.status === 'd' ||
        (l.chanceOfPlayingNext !== null && l.chanceOfPlayingNext < 100)
      ) &&
      l.tier !== 'out' &&
      !banned.some(b => b.playerId === l.playerId)
    );

    // Team-level quote pool — flatten + dedupe by video_id + signal_kind.
    const allQuotes = lines.flatMap(l => l.freshQuotes);
    const seen = new Set<string>();
    const teamLevelQuotes: PressQuote[] = [];
    for (const q of allQuotes.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
      const key = `${q.videoUrl.split('?')[0]}::${q.signalKind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      teamLevelQuotes.push(q);
    }

    // Narrative — stitched from creator quotes + flags + motivation.
    const motivation = t.motivation_score == null ? null : Number(t.motivation_score);
    const motivationLabel = describeMotivation(motivation, t.table_position);
    const narrative = synthesiseLatestNews({
      teamShort: t.short_name,
      fixture: fx,
      motivation,
      motivationLabel,
      out: out_,
      doubts,
      banned,
      predictedXI,
      teamQuotes: teamLevelQuotes.slice(0, 6),
    });

    const fixtureSummary = fx
      ? (fx.isHome ? `vs ${fx.opp} (H)` : `at ${fx.opp} (A)`)
      : 'No fixture';

    const newsUpdatedAt = teamLevelQuotes[0]?.publishedAt ?? null;

    let headline = '';
    if (banned.length > 0 && out_.length > 0) {
      headline = `Banned: ${banned.map(b => b.webName).join(', ')} · Out: ${out_.map(b => b.webName).slice(0,3).join(', ')}`;
    } else if (banned.length > 0) {
      headline = `Banned: ${banned.map(b => b.webName).join(', ')}`;
    } else if (out_.length > 0) {
      headline = `Out: ${out_.slice(0,3).map(b => b.webName).join(', ')}`;
    } else if (doubts.length > 0) {
      headline = `Doubts: ${doubts.slice(0,3).map(b => `${b.webName} ${b.chanceOfPlayingNext ?? '?'}%`).join(', ')}`;
    } else if (motivation !== null && motivation < 0.4) {
      headline = `${motivationLabel} — rotation possible`;
    } else {
      headline = `${motivationLabel} — clean bill of health`;
    }

    out.push({
      teamId: t.id,
      teamShort: t.short_name,
      teamName: t.name,
      tablePosition: t.table_position,
      motivation,
      motivationLabel,
      fixtureSummary,
      isHome: fx?.isHome ?? false,
      predictedXI,
      out: out_,
      doubts,
      banned,
      latestNews: narrative,
      newsUpdatedAt,
      teamLevelQuotes,
      headline,
    });
  }
  return out;
}

// ─── internals: SQL ───────────────────────────────────────────────────────────

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
           COALESCE(mp.expected_minutes, 0)::float        AS expected_minutes,
           COALESCE(mp.start_prob,        0)::float        AS start_prob,
           COALESCE(mp.ninety_prob,       0)::float        AS ninety_prob,
           p.season_minutes, p.season_starts,
           CASE WHEN COALESCE(a.appearances, 0) > 0
                THEN COALESCE(a.total_mins, p.season_minutes) / a.appearances
                ELSE COALESCE(p.season_minutes::float / NULLIF(p.season_starts, 0), 0)
           END::float                                       AS season_avg_mins_per_app,
           COALESCE(a.appearances, 0)                       AS appearances,
           COALESCE(tg.games, 1)                            AS team_games
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

/**
 * Yellow-card-suspended set — anyone whose cumulative YC count crossed
 * a 5/10/15 threshold in the LAST FINISHED GW. Mirrors the detector
 * inside src/lib/minutes/engine.ts.
 */
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
    const before = r.before_last;
    const total  = r.cum;
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
      channelName: r.channel_name,
      videoTitle:  r.video_title,
      rawQuote:    r.raw_quote,
      timestampSec: r.timestamp_sec,
      videoUrl:    url,
      publishedAt: r.published_at,
      signalKind:  r.signal_kind,
      confidence:  r.confidence,
    };
    if (!m.has(r.player_id)) m.set(r.player_id, []);
    m.get(r.player_id)!.push(q);
  }
  return m;
}

// ─── internals: classification ────────────────────────────────────────────────

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
    news: p.news,
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
  if (p.status === 'i' || p.status === 's' || p.status === 'u' || p.status === 'n') return 'out';
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

  if (yc) reasons.push('Yellow-card threshold reached last GW — 1-match ban');
  if (isHardOutByNews(p.news)) {
    reasons.push(`Ruled out: ${truncate(p.news ?? '', 90)}`);
  } else if (p.status === 'i') {
    reasons.push(`FPL injured${p.news ? ` — ${truncate(p.news, 80)}` : ''}`);
  } else if (p.status === 's') {
    reasons.push(`FPL suspended${p.news ? ` — ${truncate(p.news, 80)}` : ''}`);
  } else if (p.status === 'u') {
    reasons.push(`Unavailable / no longer at club`);
  } else if (p.status === 'n') {
    reasons.push(`Not available for this match${p.news ? ` — ${truncate(p.news, 80)}` : ''}`);
  } else if (p.status === 'd' && p.chance_of_playing_next_round != null) {
    reasons.push(`FPL doubt — ${p.chance_of_playing_next_round}% chance${p.news ? ` (${truncate(p.news, 60)})` : ''}`);
  } else if (p.chance_of_playing_next_round != null && p.chance_of_playing_next_round < 100) {
    reasons.push(`FPL chance ${p.chance_of_playing_next_round}% (yellow flag despite status='a')`);
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
  if (motivation >= 0.85 && position != null && position <= 2) return 'Title decider — full strength';
  if (motivation >= 0.85 && position != null && position >= 18) return 'Relegation fight — full strength';
  if (motivation >= 0.7) return 'Stakes remain — full XI expected';
  if (motivation >= 0.4) return 'Reduced stakes — some rotation possible';
  if (motivation >= 0.2) return 'Little to play for — heavy rotation likely';
  return 'Dead rubber — expect rotation';
}

// ─── internals: predicted XI ──────────────────────────────────────────────────

function pickPredictedXI(lines: PressPlayerLine[]): PredictedXI {
  // Available players sorted by start probability (with confirmed-lineup
  // lock priority via start_prob >= 0.99) then expected minutes.
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

  const gk  = available.find(p => p.position === 'GKP');
  const out: PressPlayerLine[] = [];
  if (gk) out.push(gk);

  // Greedy fill of 10 outfielders respecting min/max constraints.
  const counts = { DEF: 0, MID: 0, FWD: 0 };
  const min = { DEF: 3, MID: 2, FWD: 1 };
  const max = { DEF: 5, MID: 5, FWD: 3 };
  const minimaQueue: Position[] = ['DEF','DEF','DEF','MID','MID','FWD'];

  // Pass 1: fill minima.
  for (const need of minimaQueue) {
    const pick = available.find(p =>
      p.position === need &&
      !out.includes(p) &&
      counts[need as 'DEF'|'MID'|'FWD'] < max[need as 'DEF'|'MID'|'FWD']
    );
    if (pick) {
      out.push(pick);
      counts[need as 'DEF'|'MID'|'FWD'] += 1;
    }
  }
  // Pass 2: fill remaining slots by expected minutes, honouring max.
  for (const p of available) {
    if (out.length >= 11) break;
    if (p.position === 'GKP') continue;
    if (out.includes(p)) continue;
    const pos = p.position as 'DEF'|'MID'|'FWD';
    if (counts[pos] < max[pos]) {
      out.push(p);
      counts[pos] += 1;
    }
  }
  const starters = out.slice(0, 11);
  const bench    = available.filter(p => !starters.includes(p)).slice(0, 5);
  return {
    formation: {
      def: starters.filter(p => p.position === 'DEF').length,
      mid: starters.filter(p => p.position === 'MID').length,
      fwd: starters.filter(p => p.position === 'FWD').length,
    },
    starters, bench,
  };
}

// ─── internals: narrative synthesis ───────────────────────────────────────────

interface NarrativeInputs {
  teamShort: string;
  fixture: { opp: string; oppName: string; isHome: boolean } | undefined;
  motivation: number | null;
  motivationLabel: string;
  out:    PressPlayerLine[];
  doubts: PressPlayerLine[];
  banned: PressPlayerLine[];
  predictedXI: PredictedXI;
  teamQuotes: PressQuote[];
}

/**
 * Build a 2-4 sentence Latest News paragraph. Deterministic — sentence
 * templates chosen by which signals are present. Quotes are paraphrased
 * into our own phrasing (we never copy verbatim into the narrative —
 * the verbatim text lives in the quote-link panel below).
 *
 * Avoids "manager Y said …" copy that would mirror Fantasy Football Scout;
 * we phrase it as "creators report …" since our source is FPL pundit
 * transcripts not direct manager wires.
 */
function synthesiseLatestNews(n: NarrativeInputs): string {
  const sentences: string[] = [];

  // 1. Fixture + motivation lead.
  if (n.fixture) {
    const fxStr = n.fixture.isHome ? `host ${n.fixture.oppName}` : `travel to ${n.fixture.oppName}`;
    sentences.push(`${n.teamShort} ${fxStr}. ${n.motivationLabel}.`);
  } else {
    sentences.push(`${n.teamShort}: ${n.motivationLabel}.`);
  }

  // 2. Banned + Out + Doubts roll-up.
  const absentParts: string[] = [];
  if (n.banned.length > 0) {
    absentParts.push(`${listNames(n.banned)} banned`);
  }
  if (n.out.length > 0) {
    absentParts.push(`${listNames(n.out, 4)} out`);
  }
  if (n.doubts.length > 0) {
    const docFmt = n.doubts.slice(0, 4).map(l => {
      const c = l.chanceOfPlayingNext;
      return c != null ? `${l.webName} (${c}%)` : l.webName;
    }).join(', ');
    absentParts.push(`doubts on ${docFmt}`);
  }
  if (absentParts.length > 0) {
    sentences.push(capitalise(absentParts.join('; ')) + '.');
  }

  // 3. Creator quote roll-up — pick the freshest distinct (kind, player).
  if (n.teamQuotes.length > 0) {
    const seenKinds = new Map<string, PressQuote>();
    for (const q of n.teamQuotes) {
      const key = `${q.signalKind}`;
      if (!seenKinds.has(key)) seenKinds.set(key, q);
    }
    const startQ  = seenKinds.get('start');
    const benchQ  = seenKinds.get('bench');
    const injuryQ = seenKinds.get('injury');
    const bits: string[] = [];
    if (startQ)  bits.push(`a starting nod for the player in question`);
    if (benchQ)  bits.push(`rotation concerns flagged`);
    if (injuryQ) bits.push(`an injury concern raised`);
    if (bits.length > 0) {
      sentences.push(`Creator quotes in the last 48h surface ${bits.join(', ')} — see the source clips below to verify.`);
    }
  }

  // 4. Engine takeaway about XI rotation.
  const subThresholdStarters = n.predictedXI.starters.filter(s =>
    (s.expectedMinutes ?? 0) < 70 && s.seasonAvgMinsPerApp > 75
  );
  if (subThresholdStarters.length >= 3) {
    sentences.push(`Engine flags ${subThresholdStarters.length} of the predicted XI for sub-70-minute outings (${listNames(subThresholdStarters, 3)}) — managed minutes likely.`);
  } else if (subThresholdStarters.length >= 1) {
    sentences.push(`Engine expects reduced minutes for ${listNames(subThresholdStarters, 3)}.`);
  } else if (n.motivation !== null && n.motivation < 0.4 && n.out.length === 0 && n.doubts.length === 0) {
    sentences.push('No specific lineup leaks — but dead-rubber stakes mean wholesale changes from the bench are possible.');
  }

  return sentences.join(' ');
}

function listNames(ps: PressPlayerLine[], cap = 3): string {
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

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Same regex set used by the minutes engine's news-gate, kept in sync.
 * Exported so the page card can flag a player as "hard-out by news"
 * without re-importing the engine.
 */
export function isHardOutByNews(news: string | null): boolean {
  if (!news) return false;
  const s = news.toLowerCase();
  return (
    /\bsuspended\b/.test(s) ||
    /not available for the match/.test(s) ||
    /made unavailable for selection/.test(s) ||
    /joined .* permanently/.test(s) ||
    /transferred to/.test(s) ||
    /has left the club/.test(s)
  );
}
