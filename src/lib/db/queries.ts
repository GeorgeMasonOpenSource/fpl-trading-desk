// Reusable read queries for the UI. Server-side only.
import { sql } from './client';

export async function currentGameweek(): Promise<{ id: number; name: string; deadline: string } | null> {
  const rows = await sql<Array<{ id: number; name: string; deadline_time: string }>>`
    SELECT id, name, deadline_time FROM gameweeks
    WHERE is_current = TRUE OR is_next = TRUE
    ORDER BY is_current DESC, is_next DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name, deadline: rows[0].deadline_time };
}

export async function lastIngestAt(): Promise<string | null> {
  const [row] = await sql<Array<{ fetched_at: string | null }>>`
    SELECT MAX(fetched_at) AS fetched_at FROM raw_fpl_responses
  `;
  return row?.fetched_at ?? null;
}

export async function managerSummary(managerId: number) {
  const rows = await sql<Array<{
    manager_id: number; name: string | null; player_first_name: string | null;
    player_last_name: string | null; total_points: number; overall_rank: number | null;
    bank: number; team_value: number; free_transfers: number;
  }>>`
    SELECT manager_id, name, player_first_name, player_last_name,
           total_points, overall_rank, bank, team_value, free_transfers
    FROM manager_teams WHERE manager_id = ${managerId}
  `;
  return rows[0] ?? null;
}

export async function squadForGameweek(managerId: number, gw: number) {
  const rows = await sql<Array<any>>`
    SELECT mp.player_id, mp.position, mp.multiplier, mp.is_captain, mp.is_vice,
           mp.selling_price, p.web_name, p.position AS pos, p.team_id,
           t.short_name AS team_short,
           COALESCE(SUM(pr.xpts_total), 0)     AS xpts_total,
           COALESCE(MAX(mn.start_prob), 0)     AS start_prob,
           COALESCE(MAX(mn.sixty_plus_prob), 0) AS sixty_plus_prob,
           COALESCE(MAX(mn.ninety_prob), 0)    AS ninety_prob,
           COALESCE(MAX(mn.sub_prob), 0)       AS sub_prob,
           COALESCE(MAX(mn.bench_unused_prob), 0) AS bench_unused_prob,
           COALESCE(MAX(mn.injury_absence_prob), 0) AS injury_absence_prob,
           COALESCE(MAX(mn.expected_minutes), 0) AS expected_minutes,
           COALESCE(MAX(mn.rotation_risk), 0)  AS rotation_risk,
           COALESCE(MAX(mn.rotation_resistance), 0) AS rotation_resistance,
           COALESCE(MAX(mn.reliability_index), 0) AS reliability_index,
           COALESCE(MAX(mn.minutes_confidence), 0.5) AS minutes_confidence,
           COALESCE(SUM(pr.floor), 0)          AS floor,
           COALESCE(SUM(pr.ceiling), 0)        AS ceiling,
           COALESCE(MAX(pr.risk_score), 0)     AS risk_score,
           COALESCE(MAX(pr.confidence_score), 0) AS confidence_score,
           COALESCE(MAX(pr.reasons::text), NULL) AS reasons_json
    FROM manager_picks mp
    JOIN players p ON p.id = mp.player_id
    JOIN teams t   ON t.id = p.team_id
    LEFT JOIN projections pr        ON pr.player_id = p.id AND pr.gameweek_id = ${gw}
    LEFT JOIN minutes_projections mn ON mn.player_id = p.id
      AND mn.fixture_id IN (SELECT id FROM fixtures WHERE gameweek_id = ${gw})
    WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${gw}
    GROUP BY mp.player_id, mp.position, mp.multiplier, mp.is_captain, mp.is_vice,
             mp.selling_price, p.web_name, p.position, p.team_id, t.short_name
    ORDER BY mp.position
  `;
  return rows;
}
