import { sql, json } from '@/lib/db/client';

/**
 * Mini-League War Room.
 *
 * Goal: turn a classic league + your manager ID into actionable intel.
 *
 *  - live table (sourced from FPL ingestion)
 *  - projected final table for this GW (your live + remaining xPts)
 *  - effective ownership across rivals
 *  - captain differences (who's captaining what)
 *  - threat players (rivals own who you don't)
 *  - help players (you own who rivals don't)
 *  - point-swing events (e.g. "a Haaland goal costs you 8.7 pts vs top 5")
 *  - safe vs aggressive play recommendation
 */

interface LeagueManagerRow {
  manager_id: number;
  entry_name: string;
  player_name: string;
  rank: number;
  total: number;
  event_total: number;
}

export async function buildWarRoom(leagueId: number, userManagerId: number, gameweekId: number) {
  // 1. League table
  const standings = await sql<LeagueManagerRow[]>`
    SELECT entry AS manager_id, entry_name, player_name, rank, total, event_total
    FROM classic_league_standings
    WHERE league_id = ${leagueId} AND gameweek_id = ${gameweekId}
    ORDER BY rank ASC
  `;

  if (standings.length === 0) {
    return {
      empty: true, leagueId, userManagerId, gameweekId,
      message: 'No standings yet for this league/GW. Run /api/ingest/league first.'
    };
  }

  // 2. Rival picks (skip the user; cap at top N for cost)
  const rivals = standings.filter(s => s.manager_id !== userManagerId).slice(0, 50);
  const rivalIds = rivals.map(r => r.manager_id);

  // postgres.js: pass an array via sql(values) so we get a proper IN-list.
  const picks = rivalIds.length === 0
    ? []
    : await sql<Array<{
        manager_id: number; player_id: number; multiplier: number; is_captain: boolean; is_vice: boolean;
        web_name: string; team_short: string; xpts: number;
      }>>`
    SELECT mp.manager_id, mp.player_id, mp.multiplier, mp.is_captain, mp.is_vice,
           p.web_name, t.short_name AS team_short,
           COALESCE(SUM(pr.xpts_total), 0) AS xpts
    FROM manager_picks mp
    JOIN players p ON p.id = mp.player_id
    JOIN teams t   ON t.id = p.team_id
    LEFT JOIN projections pr ON pr.player_id = mp.player_id AND pr.gameweek_id = ${gameweekId}
    WHERE mp.gameweek_id = ${gameweekId}
      AND mp.manager_id IN ${sql(rivalIds)}
    GROUP BY mp.manager_id, mp.player_id, mp.multiplier, mp.is_captain, mp.is_vice, p.web_name, t.short_name
  `;

  const userPicks = await sql<Array<{
    player_id: number; multiplier: number; is_captain: boolean; web_name: string; xpts: number;
  }>>`
    SELECT mp.player_id, mp.multiplier, mp.is_captain, p.web_name,
           COALESCE(SUM(pr.xpts_total), 0) AS xpts
    FROM manager_picks mp
    JOIN players p ON p.id = mp.player_id
    LEFT JOIN projections pr ON pr.player_id = mp.player_id AND pr.gameweek_id = ${gameweekId}
    WHERE mp.manager_id = ${userManagerId} AND mp.gameweek_id = ${gameweekId}
    GROUP BY mp.player_id, mp.multiplier, mp.is_captain, p.web_name
  `;
  const userOwned = new Set(userPicks.filter(p => p.multiplier > 0).map(p => p.player_id));
  const userCaptain = userPicks.find(p => p.is_captain);

  // 3. EO + captain breakdown
  const total = rivals.length;
  const eoByPlayer = new Map<number, { played: number; cap: number; vice: number; webName: string; teamShort: string; xpts: number }>();
  for (const r of picks) {
    if (!eoByPlayer.has(r.player_id)) eoByPlayer.set(r.player_id, { played: 0, cap: 0, vice: 0, webName: r.web_name, teamShort: r.team_short, xpts: r.xpts });
    const e = eoByPlayer.get(r.player_id)!;
    if (r.multiplier > 0) e.played++;
    if (r.is_captain)     e.cap++;
    if (r.is_vice)        e.vice++;
  }

  // Threats: rivals own (played), you don't, high projected
  const threats = [...eoByPlayer.entries()]
    .filter(([pid, v]) => !userOwned.has(pid) && v.played >= Math.max(2, total * 0.1))
    .map(([pid, v]) => ({
      playerId: pid, webName: v.webName, teamShort: v.teamShort,
      eo: 100 * (v.played + v.cap) / total,
      projection: v.xpts
    }))
    .sort((a, b) => b.projection * b.eo - a.projection * a.eo)
    .slice(0, 10);

  // Differentials helping the user: you own + played, rivals don't / rarely
  const help = userPicks
    .filter(p => p.multiplier > 0)
    .map(p => {
      const e = eoByPlayer.get(p.player_id);
      const eoPct = e ? 100 * e.played / total : 0;
      return { playerId: p.player_id, webName: p.web_name, eo: eoPct, projection: p.xpts };
    })
    .filter(p => p.eo < 30 && p.projection > 3)
    .sort((a, b) => b.projection - a.projection)
    .slice(0, 10);

  // Captain differences
  const captainCounts = new Map<number, number>();
  for (const r of picks) {
    if (r.is_captain) captainCounts.set(r.player_id, (captainCounts.get(r.player_id) ?? 0) + 1);
  }
  const captainDiffs = [...captainCounts.entries()]
    .map(([pid, count]) => {
      const e = eoByPlayer.get(pid)!;
      return {
        playerId: pid, webName: e.webName,
        cappedByPct: 100 * count / total,
        projection: e.xpts,
        userCaptain: userCaptain?.player_id === pid
      };
    })
    .sort((a, b) => b.cappedByPct - a.cappedByPct);

  // Point-swing events: per-rival captain × projected points
  const swings = threats.map(t => {
    const e = eoByPlayer.get(t.playerId)!;
    // If e.cap rivals captained him, a 1-goal swing costs you ~ POINTS_PER_GOAL × 2 × cap_share + 1× non_cap_share
    const goalPts = 4;                     // assume MID/FWD average
    const cost =
      goalPts * 2 * (e.cap / total) +
      goalPts * (Math.max(0, e.played - e.cap) / total);
    return { playerId: t.playerId, webName: t.webName, costPerGoalIfNotOwned: cost.toFixed(2) };
  });

  // Recommendation: safe vs aggressive
  const safePlay = `Run with the template captain (${captainDiffs[0]?.webName ?? 'top owned'}) and avoid differentials with EO < 5%.`;
  const aggressivePlay = `If you're chasing in the table, target the high-EV low-EO names (${help.slice(0, 3).map(h => h.webName).join(', ')}).`;

  const payload = { standings, threats, help, captainDiffs, swings, safePlay, aggressivePlay };

  await sql`
    INSERT INTO mini_league_snapshots (league_id, manager_id, gameweek_id, payload, taken_at)
    VALUES (${leagueId}, ${userManagerId}, ${gameweekId}, ${json(payload)}, now())
  `;
  return payload;
}
