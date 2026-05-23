import { sql } from '@/lib/db/client';

/**
 * Pull expected_minutes + start_prob for a set of players in a gameweek.
 * Used by the transfer planner to flag rotation risk on either side of a
 * suggested swap — if the model is forecasting <70 mins for a player, the
 * recommendation is fragile and the user deserves a warning.
 *
 * We average over fixtures (a player with a DGW gets the mean of his two
 * fixtures' expected_minutes). For a single-GW player this is just the
 * one row.
 */
export interface MinutesContextRow {
  playerId: number;
  expectedMinutes: number;   // 0..90
  startProb: number;         // 0..1
  rotationRisk: number;      // 0..1 (1 - start_prob essentially)
}

export async function loadMinutesContext(
  playerIds: number[], gameweekId: number
): Promise<Map<number, MinutesContextRow>> {
  if (playerIds.length === 0) return new Map();
  const rows = await sql<Array<{
    player_id: number; expected_minutes: number; start_prob: number;
  }>>`
    SELECT mn.player_id,
           AVG(mn.expected_minutes)::float8 AS expected_minutes,
           AVG(mn.start_prob)::float8       AS start_prob
      FROM minutes_projections mn
      JOIN fixtures f ON f.id = mn.fixture_id
     WHERE mn.player_id IN ${sql(playerIds as any)}
       AND f.gameweek_id = ${gameweekId}
     GROUP BY mn.player_id
  `;
  const out = new Map<number, MinutesContextRow>();
  for (const r of rows) {
    const startProb = Number(r.start_prob) || 0;
    out.set(r.player_id, {
      playerId: r.player_id,
      expectedMinutes: Number(r.expected_minutes) || 0,
      startProb,
      rotationRisk: Math.max(0, 1 - startProb)
    });
  }
  return out;
}
