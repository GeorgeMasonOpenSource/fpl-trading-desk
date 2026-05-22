import { sql, json } from '@/lib/db/client';
import { getBlendedXpts } from '@/lib/projections/ensemble';

// Spread penalty for risk-adjusted ranking. Tuned heuristically: a captain
// pick with EV=8 and spread=12 has riskAdjusted = 8 - 0.30*12 = 4.4, so
// loses to a captain with EV=7 and spread=4 → riskAdjusted = 7 - 1.2 = 5.8.
// In other words, we'll prefer a steady 7-point captain over a 5-to-15 swing.
const SPREAD_PENALTY = 0.30;

/**
 * Captaincy engine.
 *
 * Ranks captaincy options for the user's current 15. Captain points are doubled
 * (tripled with TC), so the ranking is by expected captain points = 2 × xPts.
 *
 * We also surface:
 *   - safe captain (highest floor among top projections)
 *   - aggressive captain (highest ceiling among top projections)
 *   - mini-league captain (best EV adjusted for effective ownership in your league)
 *   - triple-captain suitability (high ceiling + high start_prob + favourable fixture)
 */

export interface CaptainOption {
  playerId: number;
  webName: string;
  position: string;
  teamShort: string;
  projection: number;          // captain points (2 × xPts × start_prob already in xPts)
  projectionBlended: number;   // 2 × ensemble (model + market). Falls back to projection.
  ceiling: number;
  floor: number;
  startProb: number;
  effectiveOwnershipPct: number;
  miniLeagueImpact: number;
  tripleCaptainScore: number;
  // §risk-adjusted ranking: Sharpe-style blend of EV minus spread penalty.
  // Higher = better captain choice when minimising variance is the goal.
  // Calculated as: EV - SPREAD_PENALTY × (ceiling - floor)
  // The default SPREAD_PENALTY = 0.30 means a 10-pt spread costs 3 EV.
  riskAdjusted: number;
  reasons: string[];
}

export async function rankCaptains(managerId: number, gameweekId: number, leagueId?: number) {
  // Compute effective ownership across the user's mini league (if provided)
  const eoRows = leagueId
    ? await sql<Array<{ player_id: number; eo_pct: number }>>`
        WITH league_managers AS (
          SELECT DISTINCT entry AS manager_id
          FROM classic_league_standings
          WHERE league_id = ${leagueId} AND gameweek_id = ${gameweekId}
        ),
        latest AS (
          SELECT mp.player_id, mp.manager_id, mp.is_captain, mp.is_vice, mp.multiplier
          FROM manager_picks mp
          JOIN league_managers lm ON lm.manager_id = mp.manager_id
          WHERE mp.gameweek_id = ${gameweekId}
        )
        SELECT player_id,
               (100.0 * (
                 SUM(CASE WHEN multiplier > 0 THEN 1 ELSE 0 END)::float
                 + SUM(CASE WHEN is_captain THEN 1 ELSE 0 END)::float
                 + SUM(CASE WHEN is_vice    THEN 0.1 ELSE 0 END)::float
               ) / NULLIF((SELECT COUNT(*) FROM league_managers), 0))::numeric AS eo_pct
        FROM latest
        GROUP BY player_id
      `
    : [];
  const eoMap = new Map<number, number>(eoRows.map(r => [r.player_id, Number(r.eo_pct ?? 0)]));

  // The user's current 11 + bench
  const picks = await sql<Array<{
    player_id: number; multiplier: number; position: number;
    web_name: string; team_short: string; pos: string;
    xpts: number; floor: number; ceiling: number; start_prob: number;
  }>>`
    SELECT mp.player_id, mp.multiplier, mp.position,
           p.web_name, t.short_name AS team_short, p.position AS pos,
           COALESCE(SUM(pr.xpts_total), 0) AS xpts,
           COALESCE(SUM(pr.floor), 0)     AS floor,
           COALESCE(SUM(pr.ceiling), 0)   AS ceiling,
           COALESCE(MAX(mn.start_prob), 0) AS start_prob
    FROM manager_picks mp
    JOIN players p ON p.id = mp.player_id
    JOIN teams t   ON t.id = p.team_id
    LEFT JOIN projections pr        ON pr.player_id = p.id AND pr.gameweek_id = ${gameweekId}
    LEFT JOIN minutes_projections mn ON mn.player_id = p.id
      AND mn.fixture_id IN (SELECT id FROM fixtures WHERE gameweek_id = ${gameweekId})
    WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${gameweekId}
      AND mp.position <= 11                  -- starting XI only
    GROUP BY mp.player_id, mp.multiplier, mp.position, p.web_name, t.short_name, p.position
    ORDER BY xpts DESC
  `;

  // Fetch ensemble (model + market) blended xpts in parallel for every pick.
  // Falls back to model xpts when no market data exists.
  const blendedMap = new Map<number, number>();
  await Promise.all(picks.map(async r => {
    const b = await getBlendedXpts(r.player_id, gameweekId);
    if (b != null && Number.isFinite(b)) blendedMap.set(r.player_id, b);
  }));

  const ranked: CaptainOption[] = picks.map(r => {
    const eo = eoMap.get(r.player_id) ?? Number(r.start_prob > 0 ? 5 : 0); // floor at 0
    const blended = blendedMap.get(r.player_id) ?? Number(r.xpts);
    const projection = Number(r.xpts) * 2;
    const projectionBlended = blended * 2;
    const ceiling = Number(r.ceiling) * 2;
    const floor   = Number(r.floor)   * 2;
    const miniLeagueImpact = projectionBlended - (Number(r.xpts) * eo / 100);
    const tcScore =
      ceiling * 0.6 +
      Number(r.start_prob) * 5 +
      projectionBlended * 0.5;
    // §risk-adjusted: blended EV minus a spread penalty. Use the BLENDED
    // projection as the EV anchor so the market signal flows through.
    const spread = Math.max(0, ceiling - floor);
    const riskAdjusted = projectionBlended - SPREAD_PENALTY * spread;
    const reasons: string[] = [];
    if (r.start_prob < 0.85) reasons.push(`start prob ${(r.start_prob*100).toFixed(0)}% — minutes risk`);
    if (eo > 60) reasons.push(`high EO ${eo.toFixed(0)}% — template captain`);
    if (eo < 15 && Number(r.xpts) > 4.5) reasons.push(`low EO ${eo.toFixed(0)}% — differential edge`);
    if (blendedMap.has(r.player_id)) {
      const delta = blended - Number(r.xpts);
      if (Math.abs(delta) > 0.3) {
        reasons.push(`market ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} vs model`);
      }
    }
    if (spread > 8) reasons.push(`high variance (${spread.toFixed(1)} pt spread)`);
    return {
      playerId: r.player_id,
      webName: r.web_name,
      position: r.pos,
      teamShort: r.team_short,
      projection,
      projectionBlended,
      ceiling, floor,
      startProb: Number(r.start_prob),
      effectiveOwnershipPct: eo,
      miniLeagueImpact,
      tripleCaptainScore: tcScore,
      riskAdjusted,
      reasons
    };
  });

  // Stash for audit/replay
  for (const opt of ranked) {
    await sql`
      INSERT INTO captaincy_simulations (
        manager_id, gameweek_id, player_id, projection, ceiling, floor,
        start_prob, effective_ownership, ml_impact, triple_cap_score, reasons, computed_at
      ) VALUES (
        ${managerId}, ${gameweekId}, ${opt.playerId},
        ${opt.projection}, ${opt.ceiling}, ${opt.floor}, ${opt.startProb},
        ${opt.effectiveOwnershipPct}, ${opt.miniLeagueImpact}, ${opt.tripleCaptainScore},
        ${json(opt.reasons)}, now()
      )
    `;
  }

  // Re-sort the main `ranked` list by risk-adjusted score so the top of
  // the list is the model's recommended captain, not just the EV leader.
  ranked.sort((a, b) => b.riskAdjusted - a.riskAdjusted);

  // Buckets
  const top = ranked.slice(0, 6);
  const recommended = ranked[0];   // top of risk-adjusted ranking
  const safe        = top.slice().sort((a, b) => b.floor - a.floor)[0];
  const aggressive  = top.slice().sort((a, b) => b.ceiling - a.ceiling)[0];
  const ml          = top.slice().sort((a, b) => b.miniLeagueImpact - a.miniLeagueImpact)[0];
  const tripleCap   = ranked.slice().sort((a, b) => b.tripleCaptainScore - a.tripleCaptainScore)[0];

  return { ranked, recommended, safe, aggressive, miniLeague: ml, tripleCaptainCandidate: tripleCap };
}
