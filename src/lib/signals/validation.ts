import { sql } from '@/lib/db/client';
import type { Position } from '@/lib/db/types';

/**
 * Signal validation — does the model agree with what the creator said?
 *
 * For each player in `playerIds`, score them against the rest of their
 * position by 3-GW xPts. Returns a verdict the Creator Board renders as a
 * coloured badge:
 *
 *   agrees    — player is in the top quartile for their position (good pick)
 *   neutral   — middle two quartiles (no strong opinion)
 *   disagrees — bottom quartile (model thinks this is a bad pick)
 *   no_data   — sample too thin (player has < 270 season minutes OR no
 *               projection rows yet) — neither a green light nor a red flag,
 *               just an honest "we can't tell".
 *
 * Why quartile and not absolute threshold: xPts varies hugely by position
 * (a top FWD scores 6+, a top GKP scores 4–5). Using a position-relative
 * quartile cutoff makes "good pick" mean the same thing across positions.
 *
 * Why only 3 GW: matches the planner's primary horizon. Lots of creator
 * recommendations are "buy this week" rather than long-term holds, so a
 * short horizon is the right yardstick. We can stretch this later.
 *
 * The result is also serialisable to a string for caching on the signal row
 * (model_verdict, model_verdict_detail) so the board can sort by it without
 * re-running the join on every page load.
 */
export type Verdict = 'agrees' | 'neutral' | 'disagrees' | 'no_data';

export interface Validation {
  verdict: Verdict;
  // Player's summed 3-GW xPts.
  modelXpts: number;
  // Position-wide percentile (0..1). 1 = top.
  positionPercentile: number;
  // Position-wide rank (1 = best).
  positionRank: number;
  // Number of players in that position with projections in the window.
  positionCount: number;
  // Median xPts for the position (used in the badge tooltip).
  positionMedian: number;
  // Short human string for the row tooltip.
  detail: string;
}

const HORIZON_GWS = 3;

interface PlayerProjectionRow {
  player_id: number;
  position: Position;
  season_minutes: number | null;
  xpts_3: number;
}

export async function getSignalValidations(
  playerIds: number[],
  startGameweek: number
): Promise<Map<number, Validation>> {
  if (playerIds.length === 0) return new Map();
  const endGw = startGameweek + HORIZON_GWS - 1;

  // For each player position represented in `playerIds`, we need the FULL
  // position population's 3-GW xPts so we can compute quartile ranks. Pulling
  // every active player keeps the query simple and the table cheap; the
  // position-bucket cardinality is ~600 (the FPL roster) so this is fine.
  const allPositionRows = await sql<PlayerProjectionRow[]>`
    WITH proj AS (
      SELECT player_id, SUM(xpts_total) AS xpts_3
        FROM projections
       WHERE gameweek_id BETWEEN ${startGameweek} AND ${endGw}
       GROUP BY player_id
    )
    SELECT p.id AS player_id, p.position,
           COALESCE(p.season_minutes, 0) AS season_minutes,
           COALESCE(proj.xpts_3, 0)      AS xpts_3
      FROM players p
      LEFT JOIN proj ON proj.player_id = p.id
     WHERE p.status <> 'u'
  `;

  // Bucket by position so quartile cutoffs are computed within position.
  const byPosition = new Map<Position, PlayerProjectionRow[]>();
  for (const r of allPositionRows) {
    if (!byPosition.has(r.position)) byPosition.set(r.position, []);
    byPosition.get(r.position)!.push(r);
  }
  for (const arr of byPosition.values()) {
    arr.sort((a, b) => Number(b.xpts_3) - Number(a.xpts_3));
  }

  const wanted = new Set(playerIds);
  const result = new Map<number, Validation>();

  for (const [pos, players] of byPosition.entries()) {
    const xpts = players.map(p => Number(p.xpts_3));
    // Median for the tooltip — use the simpler "middle of the sorted list"
    // since we don't need the population median's mathematical purity.
    const median = xpts.length === 0 ? 0 : xpts[Math.floor(xpts.length / 2)] ?? 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (!wanted.has(p.player_id)) continue;
      const rank = i + 1;
      const pct = players.length > 1 ? 1 - (i / (players.length - 1)) : 0.5;

      // No-data gate: too few minutes for the model to have a confident view.
      // We mirror the engine's `newSigningPenalty` cut-off at 270 minutes.
      // If the player also has zero projection points, the model has no opinion;
      // if the minutes are thin but projections exist, we still hold our nose
      // and rank — but stamp 'no_data' so the user knows we're uncertain.
      const seasonMins = Number(p.season_minutes) || 0;
      const hasProjections = Number(p.xpts_3) > 0;
      if (!hasProjections && seasonMins < 270) {
        result.set(p.player_id, {
          verdict: 'no_data',
          modelXpts: 0,
          positionPercentile: 0,
          positionRank: rank,
          positionCount: players.length,
          positionMedian: median,
          detail: 'No projections yet; too few minutes to take a view.'
        });
        continue;
      }

      const verdict: Verdict =
        pct >= 0.75 ? 'agrees' :
        pct >= 0.25 ? 'neutral' :
                      'disagrees';
      result.set(p.player_id, {
        verdict,
        modelXpts: Number(p.xpts_3),
        positionPercentile: pct,
        positionRank: rank,
        positionCount: players.length,
        positionMedian: median,
        detail:
          verdict === 'agrees'
            ? `Top ${(100 - pct*100).toFixed(0)}% of ${pos}s by 3-GW xPts (${(Number(p.xpts_3)).toFixed(1)} vs median ${median.toFixed(1)}).`
            : verdict === 'disagrees'
            ? `Bottom ${(pct*100).toFixed(0)}% of ${pos}s by 3-GW xPts (${(Number(p.xpts_3)).toFixed(1)} vs median ${median.toFixed(1)}).`
            : `Mid-pack ${pos} by 3-GW xPts (${(Number(p.xpts_3)).toFixed(1)} vs median ${median.toFixed(1)}).`
      });
    }
  }

  // Any wanted player we didn't find — they aren't in the active player set,
  // or their position bucket was empty. Return no_data so the UI still shows
  // a badge.
  for (const id of wanted) {
    if (!result.has(id)) {
      result.set(id, {
        verdict: 'no_data',
        modelXpts: 0,
        positionPercentile: 0,
        positionRank: 0,
        positionCount: 0,
        positionMedian: 0,
        detail: 'Player not in active roster or no projection rows.'
      });
    }
  }
  return result;
}

/**
 * Some signal kinds invert the "agrees" semantics. If a creator says
 * `selling`, then the model AGREES with them when the player is in the
 * bottom quartile, not the top. Apply the inversion at the call site so
 * the cached verdict on the signal row reflects "model agrees with the
 * recommendation", not just "this player is good".
 */
export function alignVerdictToKind(verdict: Verdict, kind: string): Verdict {
  if (verdict === 'no_data') return 'no_data';
  const sellishKinds = new Set(['selling', 'bench', 'injury']);
  if (!sellishKinds.has(kind)) return verdict;
  if (verdict === 'agrees')    return 'disagrees';
  if (verdict === 'disagrees') return 'agrees';
  return 'neutral';
}
