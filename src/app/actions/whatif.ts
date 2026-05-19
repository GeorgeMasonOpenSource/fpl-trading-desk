'use server';

/**
 * "What-if" transfer scoring.
 *
 * The user picks one player out of their squad and one player to bring in.
 * We compute, from cached projections, the EV delta over 1/3/6/8 GW horizons
 * and flag any FPL constraint violations (3-per-club, budget, position).
 *
 * This never writes to manager_picks — it's a sandbox.
 */
import { sql } from '@/lib/db/client';
import { getManagerId } from '@/lib/session';

interface PlayerSlot {
  player_id: number; web_name: string; team_id: number; team_short: string;
  position: 'GKP'|'DEF'|'MID'|'FWD'; cost: number;
  xpts_1: number; xpts_3: number; xpts_6: number; xpts_8: number;
}

export interface WhatIfResult {
  ok: boolean;
  error?: string;
  out?: PlayerSlot;
  in?: PlayerSlot;
  ev: { h1: number; h3: number; h6: number; h8: number };
  netCost: number;            // £m × 10, positive = need cash
  remainingBank: number;      // after the swap (£m × 10)
  violations: string[];
}

async function loadSlot(playerId: number, startGw: number, sellingPrice?: number | null): Promise<PlayerSlot | null> {
  const rows = await sql<Array<any>>`
    WITH proj AS (
      SELECT player_id,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 0 THEN xpts_total ELSE 0 END) AS h1,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 2 THEN xpts_total ELSE 0 END) AS h3,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 5 THEN xpts_total ELSE 0 END) AS h6,
             SUM(CASE WHEN gameweek_id BETWEEN ${startGw} AND ${startGw} + 7 THEN xpts_total ELSE 0 END) AS h8
      FROM projections
      WHERE player_id = ${playerId}
      GROUP BY player_id
    )
    SELECT p.id AS player_id, p.web_name, p.team_id, t.short_name AS team_short,
           p.position, p.now_cost,
           COALESCE(proj.h1, 0) AS h1, COALESCE(proj.h3, 0) AS h3,
           COALESCE(proj.h6, 0) AS h6, COALESCE(proj.h8, 0) AS h8
    FROM players p
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN proj ON proj.player_id = p.id
    WHERE p.id = ${playerId}
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    player_id: r.player_id,
    web_name: r.web_name,
    team_id: r.team_id,
    team_short: r.team_short,
    position: r.position,
    cost: sellingPrice ?? Number(r.now_cost),
    xpts_1: Number(r.h1), xpts_3: Number(r.h3),
    xpts_6: Number(r.h6), xpts_8: Number(r.h8)
  };
}

export async function tryTransfer(formData: FormData): Promise<WhatIfResult> {
  const empty = { ev: { h1: 0, h3: 0, h6: 0, h8: 0 }, netCost: 0, remainingBank: 0, violations: [] };
  const managerId = getManagerId();
  if (!managerId) return { ok: false, error: 'No manager connected.', ...empty };
  const outId = Number(formData.get('outId'));
  const inId  = Number(formData.get('inId'));
  if (!outId || !inId) return { ok: false, error: 'Pick one player to sell and one to buy.', ...empty };
  if (outId === inId) return { ok: false, error: 'Pick two different players.', ...empty };

  // Find the current gameweek + bank + selling price for the outgoing player.
  const [{ id: gw }] = await sql<Array<{ id: number }>>`
    SELECT COALESCE(
      (SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1),
      (SELECT id FROM gameweeks WHERE is_next    = TRUE LIMIT 1)
    ) AS id
  `;
  const bankRows = await sql<Array<{ bank: number }>>`
    SELECT bank FROM manager_teams WHERE manager_id = ${managerId}
  `;
  const startBank = bankRows[0]?.bank ?? 0;

  const pickRows = await sql<Array<{ selling_price: number | null }>>`
    SELECT selling_price FROM manager_picks
    WHERE manager_id = ${managerId} AND gameweek_id = ${gw} AND player_id = ${outId}
  `;
  if (pickRows.length === 0) {
    return { ok: false, error: 'Outgoing player is not in your squad.', ...empty };
  }
  const sellingPrice = pickRows[0]?.selling_price ?? null;

  const out = await loadSlot(outId, gw, sellingPrice);
  const inc = await loadSlot(inId,  gw, null);
  if (!out || !inc) return { ok: false, error: 'Could not load one of the players.', ...empty };

  // Constraints
  const violations: string[] = [];
  if (out.position !== inc.position) {
    violations.push(`Position mismatch: ${out.position} → ${inc.position}.`);
  }
  // 3-per-club: count current squad excluding the outgoing player.
  const sameClub = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n
    FROM manager_picks mp
    JOIN players p ON p.id = mp.player_id
    WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${gw}
      AND p.team_id = ${inc.team_id} AND mp.player_id != ${outId}
  `;
  if ((sameClub[0]?.n ?? 0) >= 3) {
    violations.push(`Brings you to 4+ players from ${inc.team_short}.`);
  }
  // Status
  const status = await sql<Array<{ status: string }>>`SELECT status FROM players WHERE id = ${inId}`;
  if (status[0]?.status !== 'a') {
    violations.push(`Incoming player FPL status is "${status[0]?.status}" (not 'a').`);
  }
  const netCost = inc.cost - out.cost;
  const remainingBank = startBank - netCost;
  if (remainingBank < 0) violations.push(`Over budget by £${(-remainingBank/10).toFixed(1)}m.`);

  return {
    ok: true,
    out, in: inc,
    ev: {
      h1: inc.xpts_1 - out.xpts_1,
      h3: inc.xpts_3 - out.xpts_3,
      h6: inc.xpts_6 - out.xpts_6,
      h8: inc.xpts_8 - out.xpts_8
    },
    netCost,
    remainingBank,
    violations
  };
}

/** Lightweight: list of the user's current squad for the dropdown. */
export async function listMySquad() {
  const managerId = getManagerId();
  if (!managerId) return [];
  return await sql<Array<{
    player_id: number; web_name: string; position: string; team_short: string;
    now_cost: number; selling_price: number | null;
  }>>`
    SELECT mp.player_id, p.web_name, p.position, t.short_name AS team_short,
           p.now_cost, mp.selling_price
    FROM manager_picks mp
    JOIN players p ON p.id = mp.player_id
    JOIN teams t   ON t.id = p.team_id
    WHERE mp.manager_id = ${managerId}
      AND mp.gameweek_id = (SELECT COALESCE(
        (SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1),
        (SELECT id FROM gameweeks WHERE is_next    = TRUE LIMIT 1)
      ))
    ORDER BY mp.position
  `;
}

/** Top-N players by 3-GW xPts for a given position, for the buy dropdown. */
export async function listCandidates(position: string, maxCost: number) {
  const [{ id: gw }] = await sql<Array<{ id: number }>>`
    SELECT COALESCE(
      (SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1),
      (SELECT id FROM gameweeks WHERE is_next    = TRUE LIMIT 1)
    ) AS id
  `;
  return await sql<Array<{
    player_id: number; web_name: string; team_short: string; now_cost: number; h3: number;
  }>>`
    WITH proj AS (
      SELECT player_id, SUM(xpts_total) AS h3
      FROM projections
      WHERE gameweek_id BETWEEN ${gw} AND ${gw} + 2
      GROUP BY player_id
    )
    SELECT p.id AS player_id, p.web_name, t.short_name AS team_short, p.now_cost,
           COALESCE(proj.h3, 0) AS h3
    FROM players p
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN proj ON proj.player_id = p.id
    WHERE p.position = ${position} AND p.status = 'a' AND p.now_cost <= ${maxCost}
    ORDER BY h3 DESC NULLS LAST
    LIMIT 30
  `;
}
