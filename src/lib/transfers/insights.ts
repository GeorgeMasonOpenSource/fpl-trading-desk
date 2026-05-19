import { sql } from '@/lib/db/client';

/**
 * "Why" data for transfer rows — used so the user can see WHY a player was
 * suggested without taking the model on faith. Sources only deterministic
 * data we already have in the DB.
 *
 *   - recent: aggregates from player_gameweek_history over the last 5
 *     finished fixtures for that player (NOT the last 5 GWs in the season
 *     — a player who's been injured or rotated may not have appeared in
 *     all of them, and we want the last 5 *meaningful* observations).
 *   - upcoming: next 3 unfinished fixtures with opponent + home/away + FDR
 *     (FPL difficulty rating).
 *   - roles: penalty / set-piece order from bootstrap-static (1 = primary).
 *   - season: full-season totals for context.
 */
export interface RecentMatch {
  gw: number;
  opp: string;           // 3-letter team short name of opponent
  home: boolean;
  started: boolean;
  minutes: number;
  goals: number;
  assists: number;
  bonus: number;
  fplPoints: number;
  xg: number;
  xa: number;
}

export interface PlayerInsight {
  playerId: number;
  matches: RecentMatch[];   // per-match rows, last 5 played, most-recent first
  recent: {
    apps: number;
    starts: number;
    minutes: number;
    goals: number;
    assists: number;
    bonus: number;
    fplPoints: number;
    xg: number;
    xa: number;
  };
  upcoming: Array<{
    gw: number;
    opp: string;
    home: boolean;
    fdr: number;
  }>;
  roles: {
    penaltyOrder: number | null;
    cornersOrder: number | null;
    freekicksOrder: number | null;
  };
  season: {
    minutes: number;
    starts: number;
    goals: number;
    assists: number;
    xg: number;
    xa: number;
    bonus: number;
  };
}

/**
 * Batch-fetch insights for many players in one round-trip. We pull every row
 * we need and aggregate in JS — Postgres window functions over JSON_AGG with
 * LIMIT 3 / LIMIT 5 are clunkier than just SELECTing the rows.
 */
export async function getTransferInsights(
  playerIds: number[],
  startGameweek: number
): Promise<Map<number, PlayerInsight>> {
  if (playerIds.length === 0) return new Map();

  // Last 5 *played* fixtures per player. Use a window function so we only
  // return the 5 most-recent finished fixture rows per player, joined to teams
  // for the opponent's short name so the UI can render "vs MUN (H)" style.
  const recentRows = await sql<Array<{
    player_id: number; gameweek_id: number;
    minutes: number; starts: number;
    goals_scored: number; assists: number;
    bonus: number; total_points: number;
    expected_goals: number; expected_assists: number;
    opponent_team: number; was_home: boolean;
    opp_short: string;
  }>>`
    SELECT player_id, gameweek_id, minutes, starts,
           goals_scored, assists, bonus, total_points,
           expected_goals, expected_assists,
           opponent_team, was_home, opp_short
    FROM (
      SELECT pgh.*,
             t.short_name AS opp_short,
             ROW_NUMBER() OVER (
               PARTITION BY pgh.player_id ORDER BY pgh.gameweek_id DESC
             ) AS rn
      FROM player_gameweek_history pgh
      JOIN fixtures f ON f.id = pgh.fixture_id
      LEFT JOIN teams t ON t.id = pgh.opponent_team
      WHERE f.finished = TRUE
        AND pgh.player_id IN ${sql(playerIds as any)}
    ) sub
    WHERE rn <= 5
    ORDER BY player_id, gameweek_id DESC
  `;

  // Upcoming fixtures — next 3 per player. Pull by team_id (a player's
  // fixtures = his team's fixtures).
  const playerTeams = await sql<Array<{ id: number; team_id: number }>>`
    SELECT id, team_id FROM players WHERE id IN ${sql(playerIds as any)}
  `;
  const teamIds = Array.from(new Set(playerTeams.map(p => p.team_id)));
  const teamFixtures = teamIds.length === 0 ? [] : await sql<Array<{
    gameweek_id: number; team_h: number; team_a: number;
    team_h_difficulty: number; team_a_difficulty: number;
    home_short: string; away_short: string;
  }>>`
    SELECT f.gameweek_id, f.team_h, f.team_a,
           f.team_h_difficulty, f.team_a_difficulty,
           th.short_name AS home_short, ta.short_name AS away_short
    FROM fixtures f
    JOIN teams th ON th.id = f.team_h
    JOIN teams ta ON ta.id = f.team_a
    WHERE f.finished = FALSE
      AND f.gameweek_id >= ${startGameweek}
      AND (f.team_h IN ${sql(teamIds as any)} OR f.team_a IN ${sql(teamIds as any)})
    ORDER BY f.gameweek_id
  `;

  // Roles + season totals from players.
  const meta = await sql<Array<{
    id: number; team_id: number;
    penalties_order: number | null;
    corners_and_indirect_freekicks_order: number | null;
    direct_freekicks_order: number | null;
    season_minutes: number; season_starts: number;
    season_goals: number; season_assists: number;
    season_xg: number; season_xa: number; season_bonus: number;
  }>>`
    SELECT id, team_id,
           penalties_order,
           corners_and_indirect_freekicks_order,
           direct_freekicks_order,
           season_minutes, season_starts,
           season_goals, season_assists,
           season_xg, season_xa, season_bonus
    FROM players WHERE id IN ${sql(playerIds as any)}
  `;
  const metaById = new Map(meta.map(m => [m.id, m]));

  // Assemble per-player insight.
  const recentByPlayer = new Map<number, typeof recentRows>();
  for (const r of recentRows) {
    if (!recentByPlayer.has(r.player_id)) recentByPlayer.set(r.player_id, [] as any);
    recentByPlayer.get(r.player_id)!.push(r);
  }

  const out = new Map<number, PlayerInsight>();
  for (const p of playerTeams) {
    const m = metaById.get(p.id);
    const recent = recentByPlayer.get(p.id) ?? [];
    const teamFx = teamFixtures
      .filter(f => f.team_h === p.team_id || f.team_a === p.team_id)
      .slice(0, 3)
      .map(f => {
        const home = f.team_h === p.team_id;
        return {
          gw: f.gameweek_id,
          opp: home ? f.away_short : f.home_short,
          home,
          fdr: home ? f.team_h_difficulty : f.team_a_difficulty
        };
      });

    out.set(p.id, {
      playerId: p.id,
      matches: recent.map(r => ({
        gw: r.gameweek_id,
        opp: (r as any).opp_short ?? '???',
        home: !!(r as any).was_home,
        started: Number(r.starts) > 0,
        minutes: Number(r.minutes),
        goals: Number(r.goals_scored),
        assists: Number(r.assists),
        bonus: Number(r.bonus),
        fplPoints: Number(r.total_points),
        xg: Number(r.expected_goals),
        xa: Number(r.expected_assists)
      })),
      recent: {
        apps: recent.filter(r => Number(r.minutes) > 0).length,
        starts: recent.reduce((s, r) => s + (Number(r.starts) || 0), 0),
        minutes: recent.reduce((s, r) => s + Number(r.minutes), 0),
        goals: recent.reduce((s, r) => s + Number(r.goals_scored), 0),
        assists: recent.reduce((s, r) => s + Number(r.assists), 0),
        bonus: recent.reduce((s, r) => s + Number(r.bonus), 0),
        fplPoints: recent.reduce((s, r) => s + Number(r.total_points), 0),
        xg: recent.reduce((s, r) => s + Number(r.expected_goals), 0),
        xa: recent.reduce((s, r) => s + Number(r.expected_assists), 0)
      },
      upcoming: teamFx,
      roles: {
        penaltyOrder: m?.penalties_order ?? null,
        cornersOrder: m?.corners_and_indirect_freekicks_order ?? null,
        freekicksOrder: m?.direct_freekicks_order ?? null
      },
      season: {
        minutes: Number(m?.season_minutes) || 0,
        starts: Number(m?.season_starts) || 0,
        goals: Number(m?.season_goals) || 0,
        assists: Number(m?.season_assists) || 0,
        xg: Number(m?.season_xg) || 0,
        xa: Number(m?.season_xa) || 0,
        bonus: Number(m?.season_bonus) || 0
      }
    });
  }
  return out;
}
