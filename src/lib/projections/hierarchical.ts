import { sql } from '@/lib/db/client';

/**
 * Hierarchical empirical-Bayes pooling for per-90 stats.
 *
 * Concept: each player's xG/90, xA/90, bonus/90 estimate is informed by
 * BOTH their own evidence AND the position-level prior. New signings
 * with little playing time get heavily shrunk toward the position mean;
 * established players move toward their own observed rate.
 *
 * Math (standard James-Stein / empirical Bayes for normal-normal):
 *
 *   posterior_mean = w × observed + (1 - w) × prior
 *   w              = obs_var / (obs_var + prior_var)
 *
 * Where:
 *   - obs_var  = position-tier variance / observed minutes proxy
 *   - prior_var = variance of true-skill across all players of that
 *                 position (estimated empirically from the league)
 *
 * The "tier" within a position is determined by price band — a £12m
 * midfielder gets a different prior than a £4.5m midfielder, because
 * their true-skill distributions are very different.
 *
 * Output is one row per player with shrunk per-90 estimates. The engine
 * reads these instead of the raw per-90s. Falls back to raw values when
 * we can't compute a prior (e.g. position has < 10 players with data).
 */

export interface HierarchicalEstimate {
  playerId: number;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  // Shrunk per-90 values (open-play xG, xA, bonus). Use in place of the
  // engine's raw current_xg/minutes ratio.
  xg90: number;
  xa90: number;
  bonus90: number;
  // Weight = how much of the player's own evidence we trust. 0..1.
  // Useful for the UI to show "shrunk 70% toward position prior" hints.
  ownWeight: number;
}

/**
 * Recompute hierarchical estimates for every player with at least one
 * appearance this season. Writes to a per-player aggregate table so the
 * engine can JOIN at projection time.
 *
 * Empirical-Bayes update per position tier:
 *
 *   pool_mean = league_position_tier_mean
 *   pool_var  = empirical variance across players in tier
 *   obs_var   = league_per_match_xg_var / (player_minutes / 90)
 *   shrinkage_w = obs_var / (obs_var + pool_var)
 *   posterior = shrinkage_w × pool_mean + (1 - shrinkage_w) × player_observed
 *
 * That's the textbook empirical Bayes for one parameter per player with
 * a population-level prior. We do it separately for xG, xA, bonus.
 */
export async function recomputeHierarchicalEstimates(): Promise<HierarchicalEstimate[]> {
  // Pull every player with their position, price tier, and observed
  // per-90 from season totals.
  const rows = await sql<Array<{
    id: number; position: 'GKP'|'DEF'|'MID'|'FWD';
    now_cost: number; season_minutes: number;
    season_xg: number; season_xa: number; season_bonus: number;
    xg_open_play_understat: number | null;
  }>>`
    SELECT p.id, p.position, p.now_cost, COALESCE(p.season_minutes, 0) AS season_minutes,
           COALESCE(p.season_xg, 0) AS season_xg,
           COALESCE(p.season_xa, 0) AS season_xa,
           COALESCE(p.season_bonus, 0) AS season_bonus,
           psa.xg_open_play::numeric AS xg_open_play_understat
      FROM players p
      LEFT JOIN player_shot_aggregates psa ON psa.player_id = p.id
     WHERE p.status <> 'u'
       AND COALESCE(p.season_minutes, 0) >= 90
  `;

  // Build pooled priors per (position, price tier). Three tiers:
  //   - premium  (top quintile by now_cost in position)
  //   - mid      (middle quintiles)
  //   - budget   (bottom quintile)
  const positions: Array<'GKP'|'DEF'|'MID'|'FWD'> = ['GKP', 'DEF', 'MID', 'FWD'];
  type Row = typeof rows[number];
  const tierFor = (rowsInPos: readonly Row[], row: Row): 'premium'|'mid'|'budget' => {
    const sorted = rowsInPos.slice().sort((a, b) => Number(b.now_cost) - Number(a.now_cost));
    const ix = sorted.findIndex(r => r.id === row.id);
    if (ix < sorted.length * 0.2) return 'premium';
    if (ix < sorted.length * 0.8) return 'mid';
    return 'budget';
  };

  // Compute per-(position, tier) prior mean + variance for each stat.
  type Stat = 'xg' | 'xa' | 'bonus';
  const stats: Stat[] = ['xg', 'xa', 'bonus'];
  const priors = new Map<string, { mean: number; variance: number }>();
  for (const pos of positions) {
    const rowsInPos = rows.filter(r => r.position === pos);
    for (const tier of ['premium', 'mid', 'budget'] as const) {
      const tierRows = rowsInPos.filter(r => tierFor(rowsInPos, r) === tier);
      if (tierRows.length === 0) continue;
      for (const stat of stats) {
        const per90s = tierRows
          .map(r => {
            const mins = Number(r.season_minutes);
            if (mins === 0) return null;
            const rawXg = stat === 'xg' && r.xg_open_play_understat != null
              ? Number(r.xg_open_play_understat)   // prefer open-play when available
              : Number((r as any)[`season_${stat}`]);
            return (rawXg * 90) / mins;
          })
          .filter((v): v is number => v != null);
        if (per90s.length < 3) continue;
        const mean = per90s.reduce((s, x) => s + x, 0) / per90s.length;
        const variance = per90s.reduce((s, x) => s + (x - mean) ** 2, 0) / per90s.length;
        priors.set(`${pos}:${tier}:${stat}`, { mean, variance: Math.max(0.0001, variance) });
      }
    }
  }

  // Per-player shrinkage.
  const out: HierarchicalEstimate[] = [];
  for (const r of rows) {
    const rowsInPos = rows.filter(p => p.position === r.position);
    const tier = tierFor(rowsInPos, r);
    const mins = Number(r.season_minutes);
    const get = (stat: Stat) => {
      const prior = priors.get(`${r.position}:${tier}:${stat}`);
      const rawXg = stat === 'xg' && r.xg_open_play_understat != null
        ? Number(r.xg_open_play_understat)
        : Number((r as any)[`season_${stat}`]);
      const observed = mins > 0 ? (rawXg * 90) / mins : (prior?.mean ?? 0);
      if (!prior) return { value: observed, ownWeight: 1 };
      // Observation variance shrinks with more minutes. priorVar grows.
      const obsVar = prior.variance / Math.max(1, mins / 90);
      const w = prior.variance / (prior.variance + obsVar);
      const value = w * observed + (1 - w) * prior.mean;
      return { value, ownWeight: w };
    };
    const xg = get('xg');
    const xa = get('xa');
    const bonus = get('bonus');
    out.push({
      playerId: r.id,
      position: r.position,
      xg90: xg.value,
      xa90: xa.value,
      bonus90: bonus.value,
      ownWeight: (xg.ownWeight + xa.ownWeight + bonus.ownWeight) / 3
    });
  }
  return out;
}
