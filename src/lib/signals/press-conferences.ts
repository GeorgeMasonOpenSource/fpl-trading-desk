/**
 * Press-conference summary engine.
 *
 * Aggregates the raw signals we have about each Premier League team
 * (creator transcripts, FPL news field, recent injury_status_history)
 * into a single per-team card answering:
 *
 *   1. Likely starters         — players named as nailed for the next GW
 *   2. Likely benched/rotated  — players named as drop-outs or 60-min risks
 *   3. Confirmed injuries      — anyone with FPL status ∈ {i, s, u, n} or a
 *                                doubt with chance ≤ 50, plus the news quote
 *   4. Ruled out by news       — news-string parse: "Suspended", "joined ...
 *                                permanently", "Made unavailable", etc.
 *   5. Key manager quotes      — raw verbatim quotes from creator transcripts
 *                                tagged with section context ("press conf",
 *                                "team news", etc.) so the user can
 *                                cross-reference what was said.
 *
 * Data sources are non-determinstic by design — we present quotes for the
 * user to audit, then THEY decide whether to apply a manual_override. The
 * projection engine still keys off FPL `status` + news + manual_overrides;
 * this page is the cockpit for triage.
 *
 * Falls back gracefully when transcript_signals is empty (e.g. early week
 * before videos drop) — shows status-driven cards using FPL news only.
 */

import { sql } from '@/lib/db/client';

export type StarterTier = 'nailed' | 'likely' | 'rotation' | 'benched' | 'out';

export interface PressPlayerLine {
  playerId: number;
  webName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  cost: number;                 // tenths
  status: 'a' | 'd' | 'i' | 'n' | 's' | 'u';
  chanceOfPlayingNext: number | null;
  news: string | null;
  newsAddedAt: string | null;
  // Engine-side
  tier: StarterTier;
  expectedMinutes: number | null;
  startProb: number | null;
  // Signal-side
  startSignalCount: number;
  benchSignalCount: number;
  injurySignalCount: number;
  topQuote: string | null;      // most informative verbatim quote
  topQuoteUrl: string | null;   // YouTube link with t=Xs
  topQuoteChannel: string | null;
  // Reasoning
  reasons: string[];
}

export interface TeamPressSummary {
  teamId: number;
  teamShort: string;
  teamName: string;
  // The next-GW headline numbers.
  totalSignals: number;
  // Players grouped by tier — useful for rendering.
  nailedStarters:  PressPlayerLine[];
  likelyStarters:  PressPlayerLine[];
  rotationRisk:    PressPlayerLine[];
  injured:         PressPlayerLine[];  // includes any status != 'a' OR cop < 100
  ruledOutByNews:  PressPlayerLine[];  // news-string parse hit
  // Bonus: standout one-liner the user can scan in 2 seconds.
  headline: string;
}

/**
 * Build the summary across all 20 PL teams.
 *
 * @param gameweekId - the upcoming GW (for minutes / news filtering)
 * @param withinDays - look back this many days for creator quotes (default 7)
 */
export async function buildPressConferenceSummary(
  gameweekId: number,
  withinDays = 7
): Promise<TeamPressSummary[]> {
  // 1. Pull every team. The summary card always shows all 20 so the user
  //    can scan in a fixed order; teams with no signals are still listed.
  const teams = await sql<Array<{
    id: number; name: string; short_name: string;
  }>>`SELECT id, name, short_name FROM teams ORDER BY short_name`;

  if (teams.length === 0) return [];

  // 2. Pull every player with key bootstrap fields. The status, news,
  //    chance_of_playing_next_round combination defines the engine-side
  //    tier; transcript signals refine it.
  type PlayerRow = {
    id: number; team_id: number; web_name: string;
    position: 'GKP' | 'DEF' | 'MID' | 'FWD'; now_cost: number;
    status: 'a' | 'd' | 'i' | 'n' | 's' | 'u';
    chance_of_playing_next_round: number | null;
    news: string | null; news_added_at: string | null;
    season_minutes: number; season_starts: number;
  };
  const players = await sql<PlayerRow[]>`
    SELECT id, team_id, web_name, position, now_cost, status,
           chance_of_playing_next_round, news, news_added_at,
           season_minutes, season_starts
    FROM players
    WHERE now_cost > 0
  `;
  const playersByTeam = new Map<number, PlayerRow[]>();
  for (const p of players) {
    if (!playersByTeam.has(p.team_id)) playersByTeam.set(p.team_id, []);
    playersByTeam.get(p.team_id)!.push(p);
  }

  // 3. Pull per-fixture minutes projections for the next GW so we can
  //    surface expected_minutes and start_prob alongside each player.
  const mins = await sql<Array<{
    player_id: number; expected_minutes: number;
    start_prob: number; ninety_prob: number;
  }>>`
    SELECT mp.player_id,
           mp.expected_minutes,
           mp.start_prob,
           mp.ninety_prob
    FROM minutes_projections mp
    JOIN fixtures f ON f.id = mp.fixture_id
    WHERE f.gameweek_id = ${gameweekId}
  `;
  const minsByPlayer = new Map<number, typeof mins[0]>();
  for (const m of mins) minsByPlayer.set(m.player_id, m);

  // 4. Pull transcript_signals for each player from the last `withinDays`
  //    days. signal_kind ∈ {start, bench, injury, penalty, setpiece,
  //                         recommend, watching, buying, selling}.
  //    For this summary we only care about start / bench / injury.
  type SignalRow = {
    player_id: number;
    signal_kind: string;
    raw_quote: string;
    timestamp_sec: number;
    confidence: number;
    video_id: string;
    video_url: string;
    channel_name: string;
    published_at: string;
  };
  const signals = await sql<SignalRow[]>`
    SELECT s.player_id, s.signal_kind, s.raw_quote, s.timestamp_sec, s.confidence,
           v.video_id, v.url AS video_url, v.channel_name, v.published_at
    FROM transcript_signals s
    JOIN youtube_videos v ON v.video_id = s.video_id
    WHERE s.signal_kind IN ('start', 'bench', 'injury')
      AND v.published_at > now() - (${withinDays} || ' days')::interval
      AND (s.user_action IS NULL OR s.user_action = 'accepted')
    ORDER BY v.published_at DESC, s.confidence DESC
  `;
  const signalsByPlayer = new Map<number, SignalRow[]>();
  for (const s of signals) {
    if (!signalsByPlayer.has(s.player_id)) signalsByPlayer.set(s.player_id, []);
    signalsByPlayer.get(s.player_id)!.push(s);
  }

  // 5. Build one summary per team.
  const out: TeamPressSummary[] = [];
  for (const t of teams) {
    const ps = playersByTeam.get(t.id) ?? [];
    // Filter to "regular squad members" — anyone with > 200 mins this
    // season OR currently flagged. Removes deep youth / fringe players
    // who would clutter the card.
    const relevant = ps.filter(p =>
      p.season_minutes > 200 || p.status !== 'a' || p.chance_of_playing_next_round !== null
    );

    const lines: PressPlayerLine[] = relevant.map(p => {
      const m = minsByPlayer.get(p.id);
      const sigs = signalsByPlayer.get(p.id) ?? [];
      const startCount  = sigs.filter(s => s.signal_kind === 'start').length;
      const benchCount  = sigs.filter(s => s.signal_kind === 'bench').length;
      const injuryCount = sigs.filter(s => s.signal_kind === 'injury').length;
      const topSig = sigs[0]; // most recent + highest confidence
      const reasons: string[] = [];

      // Determine tier — combine engine signals + creator quotes.
      let tier: StarterTier = 'rotation';
      if (isHardOut(p)) {
        tier = 'out';
        reasons.push(p.news ? `news: ${p.news.slice(0, 80)}` : `FPL status='${p.status}'`);
      } else if (p.status === 'd' && (p.chance_of_playing_next_round ?? 50) <= 50) {
        tier = 'out';
        reasons.push(`doubt — ${p.chance_of_playing_next_round}% chance of playing`);
      } else if (m && m.start_prob >= 0.85 && (m.expected_minutes ?? 0) >= 75) {
        tier = 'nailed';
        reasons.push(`engine: ${Math.round(m.start_prob * 100)}% start, ${Math.round(m.expected_minutes)} mins`);
      } else if (m && m.start_prob >= 0.55) {
        tier = 'likely';
        reasons.push(`engine: ${Math.round(m.start_prob * 100)}% start`);
      } else if (m && m.start_prob >= 0.25) {
        tier = 'rotation';
        reasons.push(`engine: rotation risk (${Math.round(m.start_prob * 100)}% start)`);
      } else if (m && (m.expected_minutes ?? 0) < 20) {
        tier = 'benched';
        reasons.push(`engine: likely benched (${Math.round(m.expected_minutes ?? 0)} mins)`);
      }
      // Creator signal overrides — start signal lifts tier, bench signal drops.
      if (startCount >= 2 && tier === 'likely') {
        tier = 'nailed';
        reasons.push(`${startCount} creator(s) say nailed to start`);
      } else if (startCount >= 1 && tier === 'rotation') {
        tier = 'likely';
        reasons.push(`${startCount} creator(s) flagging as starter`);
      }
      if (benchCount >= 2 && (tier === 'nailed' || tier === 'likely')) {
        tier = 'rotation';
        reasons.push(`${benchCount} creator(s) flagging rotation risk`);
      }
      if (injuryCount >= 1 && tier !== 'out') {
        reasons.push(`${injuryCount} creator(s) mention injury concern`);
      }

      const topQuoteUrl = topSig
        ? `${topSig.video_url}${topSig.video_url.includes('?') ? '&' : '?'}t=${topSig.timestamp_sec}`
        : null;

      return {
        playerId: p.id,
        webName: p.web_name,
        position: p.position,
        cost: p.now_cost,
        status: p.status,
        chanceOfPlayingNext: p.chance_of_playing_next_round,
        news: p.news,
        newsAddedAt: p.news_added_at,
        tier,
        expectedMinutes: m?.expected_minutes ?? null,
        startProb: m?.start_prob ?? null,
        startSignalCount: startCount,
        benchSignalCount: benchCount,
        injurySignalCount: injuryCount,
        topQuote: topSig?.raw_quote ?? null,
        topQuoteUrl,
        topQuoteChannel: topSig?.channel_name ?? null,
        reasons,
      };
    });

    // Bucket by tier.
    const nailed = lines.filter(l => l.tier === 'nailed').sort(byStartProbDesc);
    const likely = lines.filter(l => l.tier === 'likely').sort(byStartProbDesc);
    const rotation = lines.filter(l => l.tier === 'rotation').sort(byStartProbDesc);
    const injured = lines
      .filter(l =>
        l.status !== 'a' ||
        (l.chanceOfPlayingNext !== null && l.chanceOfPlayingNext < 100)
      )
      .sort((a, b) => (a.chanceOfPlayingNext ?? 0) - (b.chanceOfPlayingNext ?? 0));
    const ruledOut = lines.filter(l => l.tier === 'out' && l.news && isHardOutByNews(l.news));

    const totalSignals = lines.reduce(
      (s, l) => s + l.startSignalCount + l.benchSignalCount + l.injurySignalCount, 0
    );

    // Headline: surface the most actionable item.
    let headline = '';
    if (ruledOut.length > 0) {
      headline = `${ruledOut.length} ruled out: ${ruledOut.slice(0, 3).map(l => l.webName).join(', ')}`;
    } else if (injured.length >= 3) {
      headline = `${injured.length} flagged in injury list`;
    } else if (rotation.length >= 4) {
      headline = `${rotation.length} rotation risks — heavy squad usage expected`;
    } else if (nailed.length >= 8) {
      headline = `Settled XI — ${nailed.length} nailed starters`;
    } else if (totalSignals === 0 && injured.length === 0) {
      headline = 'No recent signals — relying on FPL data only';
    } else {
      headline = `${nailed.length} nailed · ${rotation.length} rotation · ${injured.length} flagged`;
    }

    out.push({
      teamId: t.id,
      teamShort: t.short_name,
      teamName: t.name,
      totalSignals,
      nailedStarters: nailed,
      likelyStarters: likely,
      rotationRisk: rotation,
      injured,
      ruledOutByNews: ruledOut,
      headline,
    });
  }

  return out;
}

// --- helpers ---------------------------------------------------------------

function byStartProbDesc(a: PressPlayerLine, b: PressPlayerLine): number {
  return (b.startProb ?? 0) - (a.startProb ?? 0);
}

function isHardOut(p: {
  status: string; news: string | null; chance_of_playing_next_round: number | null
}): boolean {
  if (p.status === 'i' || p.status === 's' || p.status === 'u' || p.status === 'n') return true;
  if (p.status === 'd' && (p.chance_of_playing_next_round ?? 50) <= 25) return true;
  if (p.news && isHardOutByNews(p.news)) return true;
  return false;
}

/**
 * Same regex set used by the minutes engine's news-gate, kept in sync so
 * the press-conf summary card lines up with what the projection engine
 * actually applies.
 */
export function isHardOutByNews(news: string): boolean {
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
