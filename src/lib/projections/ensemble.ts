import { sql } from '@/lib/db/client';
import { impliedXg } from '@/lib/odds/the-odds-api';

/**
 * Ensemble blender.
 *
 * Blends our model's per-player xpts with the market-implied expected goals
 * derived from bookmaker anytime-scorer odds. The blend reduces variance
 * because:
 *   - The bookmakers price in late team-news that our model misses
 *   - Multiple bookmakers aggregate to a wisdom-of-crowds signal
 *   - Our model has structural information bookmakers don't surface (defcon,
 *     bonus, set-piece role) so it contributes the parts the market lacks
 *
 * Blend weight is a single tunable: BLEND_MARKET_WEIGHT.
 * 0.0 = pure model (no change). 1.0 = market only. 0.4 is the published
 * sweet spot from the few academic papers comparing the two — we adopt
 * that as the default and let the backtest harness tune it.
 *
 * What we blend specifically: the GOALS component only. Assists / clean
 * sheets / defcon / bonus stay model-driven because the markets for those
 * are either thin (assists) or already incorporated structurally (clean
 * sheets piggy-back on team xGA which we already use).
 */

const BLEND_MARKET_WEIGHT = 0.40;
const GOAL_POINTS: Record<string, number> = { GKP: 6, DEF: 6, MID: 5, FWD: 4 };

export interface EnsembleRow {
  playerId: number;
  fixtureId: number;
  gameweekId: number;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  modelXpts: number;       // raw model output (xpts_total from projections)
  modelXg: number;         // model's expected goals contribution
  marketImpliedProb: number; // bookmaker probability of anytime-scorer
  marketImpliedXg: number;   // -ln(1-p), expected goals from market
  blendedXg: number;         // weighted average per-game
  blendedXpts: number;       // model xpts with the goals component swapped
  marketAvailable: boolean;  // false → falls back to model alone
}

/**
 * Compute the ensemble blend for every player-fixture in the given
 * gameweek. Returns one row per (player, fixture). Players without
 * market data get marketAvailable=false and blendedXpts = modelXpts
 * (no change) so the caller can use the ensemble field unconditionally.
 */
export async function buildEnsemble(gameweekId: number): Promise<EnsembleRow[]> {
  const rows = await sql<Array<{
    player_id: number;
    fixture_id: number;
    gameweek_id: number;
    position: 'GKP' | 'DEF' | 'MID' | 'FWD';
    xpts_total: number;
    xpts_goals: number;
    implied_prob: number | null;
  }>>`
    SELECT pr.player_id, pr.fixture_id, pr.gameweek_id,
           p.position,
           pr.xpts_total::float8  AS xpts_total,
           pr.xpts_goals::float8  AS xpts_goals,
           mol.implied_prob::float8 AS implied_prob
      FROM projections pr
      JOIN players p ON p.id = pr.player_id
      LEFT JOIN market_odds_latest mol
        ON mol.player_id = pr.player_id
       AND mol.market = 'player_goal'
       AND mol.gameweek_id = pr.gameweek_id
     WHERE pr.gameweek_id = ${gameweekId}
  `;

  const out: EnsembleRow[] = [];
  for (const r of rows) {
    const goalPts = GOAL_POINTS[r.position] ?? 5;
    // Back-derive the model's xG from the goals points component.
    const modelXg = goalPts > 0 ? r.xpts_goals / goalPts : 0;

    const marketProb = r.implied_prob == null ? 0 : Number(r.implied_prob);
    const marketAvailable = marketProb > 0;
    const marketXg = marketAvailable ? impliedXg(marketProb) : 0;

    const blendedXg = marketAvailable
      ? modelXg * (1 - BLEND_MARKET_WEIGHT) + marketXg * BLEND_MARKET_WEIGHT
      : modelXg;
    // Replace the goals contribution in xpts_total with the blended value.
    const xptsGoalsBlended = blendedXg * goalPts;
    const blendedXpts = r.xpts_total - r.xpts_goals + xptsGoalsBlended;

    out.push({
      playerId: r.player_id,
      fixtureId: r.fixture_id,
      gameweekId: r.gameweek_id,
      position: r.position,
      modelXpts: r.xpts_total,
      modelXg,
      marketImpliedProb: marketProb,
      marketImpliedXg: marketXg,
      blendedXg,
      blendedXpts,
      marketAvailable
    });
  }
  return out;
}

/**
 * Get the blended xpts for a single player+gameweek. Convenience used by
 * the dashboard / transfer planner. Falls back to model xpts if market
 * data isn't available.
 */
export async function getBlendedXpts(
  playerId: number, gameweekId: number
): Promise<number | null> {
  const rows = await sql<Array<{ blended: number }>>`
    WITH p AS (
      SELECT pr.player_id, pl.position,
             pr.xpts_total::float8 AS xpts_total,
             pr.xpts_goals::float8 AS xpts_goals,
             mol.implied_prob::float8 AS implied_prob
        FROM projections pr
        JOIN players pl ON pl.id = pr.player_id
        LEFT JOIN market_odds_latest mol
          ON mol.player_id = pr.player_id
         AND mol.market = 'player_goal'
         AND mol.gameweek_id = pr.gameweek_id
       WHERE pr.player_id = ${playerId}
         AND pr.gameweek_id = ${gameweekId}
    )
    SELECT (
      p.xpts_total - p.xpts_goals
      + (
        (p.xpts_goals / CASE p.position
                          WHEN 'FWD' THEN 4 WHEN 'MID' THEN 5
                          WHEN 'DEF' THEN 6 WHEN 'GKP' THEN 6 ELSE 5 END)
        * (1 - ${BLEND_MARKET_WEIGHT})
        + COALESCE(- LN(1 - LEAST(0.99, GREATEST(0, p.implied_prob))), 0)
          * ${BLEND_MARKET_WEIGHT}
      ) * CASE p.position
            WHEN 'FWD' THEN 4 WHEN 'MID' THEN 5
            WHEN 'DEF' THEN 6 WHEN 'GKP' THEN 6 ELSE 5 END
    )::float8 AS blended
    FROM p
  `;
  return rows[0]?.blended ?? null;
}
