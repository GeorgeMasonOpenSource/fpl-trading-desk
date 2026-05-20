import { sql } from '@/lib/db/client';
import type { Position } from '@/lib/db/types';

/**
 * Creator accuracy backtest.
 *
 * For every historical creator_rankings row whose target gameweek is FINISHED,
 * we compare the player they recommended against the actual points scored over
 * the following N gameweeks (1 for transfers/captains, 4 for set-and-forget).
 *
 * "Beat-the-median" definition:
 *   Their #1 captain pick scored more FPL points than the position-level
 *   median over the same window. We use position-median rather than
 *   "average premium", because what counts as premium varies week to week
 *   (price cuts and new signings shift the population) — the median is a
 *   stable reference that doesn't require choosing a price band.
 *
 * The result is a Brier-style aggregate: rate of beat-the-median picks per
 * creator per ranking_kind, with sample size attached so the UI can grey out
 * small-N rows.
 *
 * What this is NOT:
 *   - A statistical significance test. With ~30 weeks of data per creator
 *     the confidence intervals are wide; the leaderboard is a credibility
 *     hint, not a verdict.
 *   - A captain-EV optimiser. That's the planner's job.
 */
export interface CreatorAccuracyRow {
  channelId: string;
  channelName: string;
  rankingKind: string;
  totalPicks: number;
  beatMedianPicks: number;
  beatMedianRate: number;          // 0..1
  avgPointsAboveMedian: number;    // per-pick mean of (player_points - median)
  lastEvaluatedGw: number | null;
}

export interface PickEvaluation {
  rankingId: number;
  videoId: string;
  channelId: string;
  channelName: string;
  rankingKind: string;
  positionRank: number;
  playerId: number;
  webName: string;
  position: Position;
  targetGw: number;
  evalWindowGws: number;
  playerPoints: number;
  positionMedianPoints: number;
  beatMedian: boolean;
}

// How many gameweeks forward we evaluate each pick over, by ranking kind.
// Captain picks are a 1-week call; transfers should pay off over the planner's
// 3-GW horizon; set-and-forget is meant to last 4+ GWs.
const EVAL_WINDOWS: Record<string, number> = {
  captains:        1,
  transfers_in:    3,
  transfers_out:   3,
  differentials:   3,
  set_and_forget:  4,
  avoid:           3
};

/**
 * Pull all evaluable picks — ones whose target gameweek window is fully
 * finished. We do the gameweek-finished check in SQL so we don't waste a
 * round-trip on picks that aren't ready to score yet.
 */
interface PickRow {
  id: number; video_id: string; channel_id: string; channel_name: string;
  ranking_kind: string; position_rank: number; player_id: number;
  web_name: string; position: Position; target_gw: number;
}

export async function evaluatePicks(limit = 2000): Promise<PickEvaluation[]> {
  const rows = await sql<PickRow[]>`
    SELECT cr.id, cr.video_id, cr.channel_id, cr.channel_name,
           cr.ranking_kind, cr.position_rank, cr.player_id,
           p.web_name, p.position,
           cr.gameweek_id AS target_gw
      FROM creator_rankings cr
      JOIN players p   ON p.id = cr.player_id
      JOIN gameweeks gw ON gw.id = cr.gameweek_id
     WHERE gw.finished = TRUE
     ORDER BY cr.created_at DESC
     LIMIT ${limit}
  `;

  if (rows.length === 0) return [];

  const evaluations: PickEvaluation[] = [];

  // Group rows by (target_gw, eval_window, position) so we compute the median
  // for each bucket only once. This collapses what would otherwise be
  // O(picks * positionPlayers) work into O(buckets).
  // NOTE: postgres.js returns RowList (an array subclass with metadata), not a
  // plain array, so we declare `rows: PickRow[]` explicitly rather than
  // `typeof rows` — TypeScript otherwise refuses to assign `[]` to RowList.
  type Bucket = { targetGw: number; endGw: number; position: Position; rows: PickRow[] };
  const bucketByKey = new Map<string, Bucket>();
  for (const r of rows) {
    const win = EVAL_WINDOWS[r.ranking_kind] ?? 1;
    const endGw = r.target_gw + win - 1;
    const key = `${r.target_gw}|${endGw}|${r.position}`;
    if (!bucketByKey.has(key)) {
      bucketByKey.set(key, { targetGw: r.target_gw, endGw, position: r.position, rows: [] });
    }
    bucketByKey.get(key)!.rows.push(r);
  }

  for (const bucket of bucketByKey.values()) {
    // Get per-player summed points for every active player at that position
    // over the bucket's window. Filter to players who appeared at all (we
    // shouldn't punish a creator for picking a player who was injured the
    // whole bucket — though if you wanted to be strict you could include them
    // as 0 to penalise "should have known about the injury").
    const playerPointsRows = await sql<Array<{ player_id: number; pts: number }>>`
      SELECT pgh.player_id,
             SUM(pgh.total_points)::int AS pts
        FROM player_gameweek_history pgh
        JOIN players p ON p.id = pgh.player_id
       WHERE pgh.gameweek_id BETWEEN ${bucket.targetGw} AND ${bucket.endGw}
         AND p.position = ${bucket.position}
       GROUP BY pgh.player_id
    `;

    const pointsByPlayer = new Map<number, number>();
    for (const pp of playerPointsRows) pointsByPlayer.set(pp.player_id, Number(pp.pts));
    const allPoints = playerPointsRows.map(r => Number(r.pts)).sort((a, b) => a - b);
    const median = allPoints.length === 0 ? 0 : (
      allPoints.length % 2 === 1
        ? allPoints[(allPoints.length - 1) / 2]!
        : (allPoints[allPoints.length / 2 - 1]! + allPoints[allPoints.length / 2]!) / 2
    );

    for (const r of bucket.rows) {
      const playerPoints = pointsByPlayer.get(r.player_id) ?? 0;
      const beatMedian = r.ranking_kind === 'avoid'
        // For "avoid", a successful call is the player UNDER-performing —
        // beat-the-median = player_points < median.
        ? playerPoints < median
        : playerPoints > median;
      evaluations.push({
        rankingId: r.id,
        videoId: r.video_id,
        channelId: r.channel_id,
        channelName: r.channel_name,
        rankingKind: r.ranking_kind,
        positionRank: r.position_rank,
        playerId: r.player_id,
        webName: r.web_name,
        position: r.position,
        targetGw: bucket.targetGw,
        evalWindowGws: bucket.endGw - bucket.targetGw + 1,
        playerPoints,
        positionMedianPoints: median,
        beatMedian
      });
    }
  }

  return evaluations;
}

/** Roll up evaluations into a leaderboard. */
export function rollupToLeaderboard(evals: PickEvaluation[]): CreatorAccuracyRow[] {
  const byKey = new Map<string, {
    channelId: string; channelName: string; rankingKind: string;
    total: number; wins: number; sumAbove: number; lastGw: number | null;
  }>();
  for (const e of evals) {
    const key = `${e.channelId}|${e.rankingKind}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        channelId: e.channelId,
        channelName: e.channelName,
        rankingKind: e.rankingKind,
        total: 0, wins: 0, sumAbove: 0, lastGw: null
      });
    }
    const b = byKey.get(key)!;
    b.total += 1;
    if (e.beatMedian) b.wins += 1;
    // Avg points-above-median: signed even for `avoid` (under-performance is
    // recorded as a negative delta, which is the correct sign for a successful
    // avoid pick). Reverse so positive = good either way.
    const signed = e.rankingKind === 'avoid'
      ? (e.positionMedianPoints - e.playerPoints)
      : (e.playerPoints - e.positionMedianPoints);
    b.sumAbove += signed;
    if (b.lastGw == null || e.targetGw > b.lastGw) b.lastGw = e.targetGw;
  }
  const out: CreatorAccuracyRow[] = [];
  for (const b of byKey.values()) {
    out.push({
      channelId: b.channelId,
      channelName: b.channelName,
      rankingKind: b.rankingKind,
      totalPicks: b.total,
      beatMedianPicks: b.wins,
      beatMedianRate: b.total === 0 ? 0 : b.wins / b.total,
      avgPointsAboveMedian: b.total === 0 ? 0 : b.sumAbove / b.total,
      lastEvaluatedGw: b.lastGw
    });
  }
  // Sort by beat-rate, but only among rows with a meaningful sample (≥ 5);
  // small-N rows are pushed to the bottom so users don't read "100% (1 pick)"
  // as a real signal.
  out.sort((a, b) => {
    const aSmall = a.totalPicks < 5;
    const bSmall = b.totalPicks < 5;
    if (aSmall !== bSmall) return aSmall ? 1 : -1;
    if (b.beatMedianRate !== a.beatMedianRate) return b.beatMedianRate - a.beatMedianRate;
    return b.totalPicks - a.totalPicks;
  });
  return out;
}
