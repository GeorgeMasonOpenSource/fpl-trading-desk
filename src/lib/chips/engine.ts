import { sql, json } from '@/lib/db/client';

/**
 * Chip simulator.
 *
 * For each chip (WC, FH, BB, TC) we compute, for every future gameweek in the
 * projection horizon, the expected value of using it now vs. holding. The
 * "best week" is the one where chip EV is highest.
 *
 *   TC  : EV = max projected captain xPts (extra +1× over normal captain)
 *   BB  : EV = sum of bench xPts for that GW
 *   FH  : EV = top XI projection − current XI projection (cap at 12-13 pts realistically)
 *   WC  : EV = horizon EV uplift from greedy 5-upgrade (placeholder; full optimiser later)
 */

export interface ChipEv {
  chip: 'WC' | 'FH' | 'BB' | 'TC';
  gameweekId: number;
  ev: number;
  risk: number;
  confidence: number;
  payload: any;
}

export async function simulateChips(managerId: number, startGw: number, endGw: number): Promise<ChipEv[]> {
  const results: ChipEv[] = [];

  for (let gw = startGw; gw <= endGw; gw++) {
    // TC: highest 2× captain points uplift = max(xpts) × 1 (extra multiplier)
    const [tc] = await sql<Array<{ player_id: number; xpts: number; ceiling: number }>>`
      SELECT mp.player_id, SUM(pr.xpts_total) AS xpts, SUM(pr.ceiling) AS ceiling
      FROM manager_picks mp
      JOIN projections pr ON pr.player_id = mp.player_id AND pr.gameweek_id = ${gw}
      WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${startGw}
        AND mp.position <= 11
      GROUP BY mp.player_id
      ORDER BY xpts DESC LIMIT 1
    `;
    if (tc) {
      results.push({
        chip: 'TC', gameweekId: gw,
        ev: tc.xpts,                          // extra multiplier = +1× xPts
        risk: 0.25,
        confidence: 0.7,
        payload: { topCaptain: tc.player_id, projection: tc.xpts, ceiling: tc.ceiling }
      });
    }

    // BB: bench points
    const [bb] = await sql<Array<{ bench_xpts: number }>>`
      SELECT COALESCE(SUM(pr.xpts_total), 0) AS bench_xpts
      FROM manager_picks mp
      JOIN projections pr ON pr.player_id = mp.player_id AND pr.gameweek_id = ${gw}
      WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${startGw}
        AND mp.position > 11
    `;
    results.push({
      chip: 'BB', gameweekId: gw,
      ev: bb?.bench_xpts ?? 0,
      risk: 0.35, confidence: 0.6,
      payload: { benchXpts: bb?.bench_xpts ?? 0 }
    });

    // FH: top XI in the league minus current XI. Cap upgrade at +13 pts to stay realistic.
    const [fh] = await sql<Array<{ best_xi: number; current_xi: number }>>`
      WITH best AS (
        SELECT position, xpts_total
        FROM projections pr
        JOIN players p ON p.id = pr.player_id
        WHERE pr.gameweek_id = ${gw}
        ORDER BY xpts_total DESC
      )
      SELECT
        (SELECT SUM(xpts_total) FROM (
          SELECT xpts_total FROM best WHERE position = 'GKP' ORDER BY xpts_total DESC LIMIT 1
        ) a) +
        (SELECT SUM(xpts_total) FROM (
          SELECT xpts_total FROM best WHERE position = 'DEF' ORDER BY xpts_total DESC LIMIT 5
        ) b) +
        (SELECT SUM(xpts_total) FROM (
          SELECT xpts_total FROM best WHERE position = 'MID' ORDER BY xpts_total DESC LIMIT 5
        ) c) +
        (SELECT SUM(xpts_total) FROM (
          SELECT xpts_total FROM best WHERE position = 'FWD' ORDER BY xpts_total DESC LIMIT 3
        ) d) AS best_xi,
        (SELECT COALESCE(SUM(pr.xpts_total), 0)
           FROM manager_picks mp
           JOIN projections pr ON pr.player_id = mp.player_id AND pr.gameweek_id = ${gw}
           WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${startGw}
             AND mp.position <= 11
        ) AS current_xi
    `;
    const fhUplift = Math.min(13, Math.max(0, (fh?.best_xi ?? 0) - (fh?.current_xi ?? 0)));
    results.push({
      chip: 'FH', gameweekId: gw,
      ev: fhUplift,
      risk: 0.5, confidence: 0.5,
      payload: { uplift: fhUplift }
    });

    // WC: same idea, but value compounds across 6 GWs. Use the greedy uplift over horizon.
    const [wc] = await sql<Array<{ uplift: number }>>`
      WITH top5 AS (
        SELECT pr.player_id, pr.xpts_total
        FROM projections pr
        JOIN players p ON p.id = pr.player_id
        WHERE pr.gameweek_id BETWEEN ${gw} AND ${gw} + 5
      )
      SELECT GREATEST(0, COALESCE(AVG(xpts_total) * 5, 0)) AS uplift FROM top5
    `;
    results.push({
      chip: 'WC', gameweekId: gw,
      ev: Math.min(35, wc?.uplift ?? 0),     // cap to a realistic WC upside
      risk: 0.6, confidence: 0.45,
      payload: { uplift: wc?.uplift ?? 0 }
    });
  }

  // Persist
  for (const r of results) {
    await sql`
      INSERT INTO chip_simulations (manager_id, gameweek_id, chip, ev, risk, confidence,
                                    opportunity_cost, best_week_projected, payload, computed_at)
      VALUES (${managerId}, ${r.gameweekId}, ${r.chip}, ${r.ev}, ${r.risk}, ${r.confidence},
              0, ${r.gameweekId}, ${json(r.payload)}, now())
    `;
  }

  return results;
}
