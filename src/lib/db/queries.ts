// Reusable read queries for the UI. Server-side only.
//
// The heavy-traffic queries below are wrapped with Next.js `unstable_cache`
// so navigating between pages serves from the in-process / KV cache instead
// of round-tripping to Neon every time. Each cache is tagged so we can
// invalidate precisely on `Refresh now`:
//   - 'gameweeks'  : invalidated when ingest runs
//   - 'manager:N'  : invalidated when this manager's picks change
//   - 'projections' : invalidated when the model recomputes
//
// Stale-while-revalidate is built in — the user sees the cached version
// instantly while a background revalidation picks up new data.
import { sql } from './client';
import { unstable_cache } from 'next/cache';

export interface GameweekRow {
  id: number;
  name: string;
  deadline: string;
  isCurrent: boolean;
  isNext: boolean;
  finished: boolean;
}

/**
 * Returns the gameweek context the UI needs:
 *   - current : the GW that's in progress / most recently finished (for live tracking)
 *   - next    : the GW with the upcoming deadline (for planning)
 *   - planning: alias for `next ?? current` — what projections / scenarios use
 *
 * At season-end, `next` may be null. Mid-season they're typically different.
 * Cached for 60s and tagged so `revalidateTag('gameweeks')` busts it instantly.
 */
export const getGameweeks = unstable_cache(
  async (): Promise<{ current: GameweekRow | null; next: GameweekRow | null; planning: GameweekRow | null }> => {
    const rows = await sql<Array<{
      id: number; name: string; deadline_time: string;
      is_current: boolean; is_next: boolean; finished: boolean;
    }>>`
      SELECT id, name, deadline_time, is_current, is_next, finished
      FROM gameweeks
      WHERE is_current = TRUE OR is_next = TRUE
      ORDER BY is_current DESC, is_next DESC
    `;
    const mk = (r: any): GameweekRow => ({
      id: r.id, name: r.name, deadline: r.deadline_time,
      isCurrent: r.is_current, isNext: r.is_next, finished: r.finished
    });
    const current = rows.find(r => r.is_current) ?? null;
    const next    = rows.find(r => r.is_next) ?? null;
    return {
      current: current ? mk(current) : null,
      next:    next ? mk(next) : null,
      planning: next ? mk(next) : (current ? mk(current) : null)
    };
  },
  ['gameweeks'],
  { revalidate: 60, tags: ['gameweeks'] }
);

/** Legacy single-GW helper. Prefer getGameweeks() in new code. */
export async function currentGameweek(): Promise<{ id: number; name: string; deadline: string } | null> {
  const { planning } = await getGameweeks();
  return planning ? { id: planning.id, name: planning.name, deadline: planning.deadline } : null;
}

export const lastIngestAt = unstable_cache(
  async (): Promise<string | null> => {
    const [row] = await sql<Array<{ fetched_at: string | null }>>`
      SELECT MAX(fetched_at) AS fetched_at FROM raw_fpl_responses
    `;
    return row?.fetched_at ?? null;
  },
  ['last-ingest'],
  { revalidate: 30, tags: ['ingest'] }
);

export async function managerSummary(managerId: number) {
  // Per-manager fetch — wrapper that produces a manager-specific cache key.
  return unstable_cache(
    async () => {
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
    },
    [`manager-summary:${managerId}`],
    { revalidate: 60, tags: ['manager', `manager:${managerId}`] }
  )();
}

/**
 * Players FPL has flagged: chance_of_playing < 100 or non-empty news. Marks
 * squad-owned players. Sorted: owned-first, then most-at-risk (lowest
 * chance_of_playing) first.
 */
export async function newsWatch(managerId: number, planningGw: number) {
  // Restrict to players actually in the user's squad for the planning GW.
  // Showing news about random players the user doesn't own is noise —
  // 100+ players have news at any time during the season and they're
  // mostly irrelevant.
  const owned = await sql<Array<{
    player_id: number; web_name: string; team_short: string; position: string;
    status: string; news: string | null; news_added_at: string | null;
    chance_of_playing_next_round: number | null;
    chance_of_playing_this_round: number | null;
    owned: boolean;
  }>>`
    SELECT p.id AS player_id, p.web_name, t.short_name AS team_short, p.position,
           p.status, p.news, p.news_added_at,
           p.chance_of_playing_next_round, p.chance_of_playing_this_round,
           TRUE AS owned
      FROM players p
      JOIN teams t        ON t.id = p.team_id
      JOIN manager_picks mp ON mp.player_id = p.id
                            AND mp.manager_id = ${managerId}
                            AND mp.gameweek_id = ${planningGw}
     WHERE (
        (p.chance_of_playing_next_round IS NOT NULL AND p.chance_of_playing_next_round < 100)
        OR (p.news IS NOT NULL AND p.news <> '')
        OR p.status <> 'a'
      )
     ORDER BY
       COALESCE(p.chance_of_playing_next_round, 50) ASC,
       p.news_added_at DESC NULLS LAST
     LIMIT 30
  `;
  if (owned.length > 0) return owned;

  // Fallback — no news affecting any squad player. Show the 10 most
  // recent league-wide injury / availability updates so the panel isn't
  // empty and the user has SOMETHING to scan. These rows render with
  // owned = FALSE so the UI can fade them or label them clearly.
  return await sql<Array<{
    player_id: number; web_name: string; team_short: string; position: string;
    status: string; news: string | null; news_added_at: string | null;
    chance_of_playing_next_round: number | null;
    chance_of_playing_this_round: number | null;
    owned: boolean;
  }>>`
    SELECT p.id AS player_id, p.web_name, t.short_name AS team_short, p.position,
           p.status, p.news, p.news_added_at,
           p.chance_of_playing_next_round, p.chance_of_playing_this_round,
           FALSE AS owned
      FROM players p
      JOIN teams t ON t.id = p.team_id
     WHERE (
        (p.chance_of_playing_next_round IS NOT NULL AND p.chance_of_playing_next_round < 100)
        OR (p.news IS NOT NULL AND p.news <> '')
        OR p.status <> 'a'
      )
       AND p.news_added_at IS NOT NULL
     ORDER BY p.news_added_at DESC
     LIMIT 10
  `;
}

export async function squadForGameweek(managerId: number, gw: number) {
  return unstable_cache(
    async () => {
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
    },
    [`squad:${managerId}:${gw}`],
    { revalidate: 60, tags: ['squad', `manager:${managerId}`, `gameweek:${gw}`] }
  )();
}

/**
 * Live points for a manager in a specific (in-progress) gameweek. Pulled from
 * `player_gameweek_history` which the `/api/ingest/live` cron updates every
 * 5 min during match windows. Short TTL so the page reflects live changes.
 */
export async function livePoints(managerId: number, gw: number) {
  return unstable_cache(
    async () => {
      const rows = await sql<Array<{
        player_id: number; web_name: string; multiplier: number; is_captain: boolean;
        minutes: number; total_points: number; bonus: number;
      }>>`
        SELECT mp.player_id, p.web_name, mp.multiplier, mp.is_captain,
               COALESCE(pgh.minutes, 0)      AS minutes,
               COALESCE(pgh.total_points, 0) AS total_points,
               COALESCE(pgh.bonus, 0)        AS bonus
        FROM manager_picks mp
        JOIN players p ON p.id = mp.player_id
        LEFT JOIN player_gameweek_history pgh
          ON pgh.player_id = mp.player_id AND pgh.gameweek_id = ${gw}
        WHERE mp.manager_id = ${managerId} AND mp.gameweek_id = ${gw}
        ORDER BY mp.position
      `;
      const xi = rows.filter(r => r.multiplier > 0);
      const points = xi.reduce((sum, r) => sum + r.total_points * (r.multiplier || 1), 0);
      const stillToPlay = rows.filter(r => r.minutes === 0 && r.multiplier > 0).length;
      return { rows, points, stillToPlay };
    },
    [`live:${managerId}:${gw}`],
    { revalidate: 30, tags: ['live', `manager:${managerId}`, `gameweek:${gw}`] }
  )();
}
