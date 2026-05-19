'use server';
/**
 * Mini-league server actions: list the user's auto-pulled leagues from
 * `manager_leagues` and switch which one is the "active" one (cookie).
 *
 * The leagues come from FPL's /entry/{id}/ endpoint on connect — we never
 * have to ask the user to type a league ID; they pick from the list.
 */
import { sql } from '@/lib/db/client';
import { getManagerId, setLeagueId } from '@/lib/session';
import { revalidatePath } from 'next/cache';

export interface MyLeague {
  leagueId: number;
  name: string;
  scoring: 'c' | 'h';
  leagueType: string;
  startEvent: number | null;
  entryRank: number | null;
  entryLastRank: number | null;
  entryPercentileRank: number | null;
  closed: boolean;
}

/** Lists every league the connected manager belongs to, sorted by rank. */
export async function listMyLeagues(): Promise<MyLeague[]> {
  const managerId = getManagerId();
  if (!managerId) return [];
  const rows = await sql<Array<{
    league_id: number; name: string; scoring: 'c' | 'h';
    league_type: string; start_event: number | null;
    entry_rank: number | null; entry_last_rank: number | null;
    entry_percentile_rank: number | null; closed: boolean;
  }>>`
    SELECT league_id, name, scoring, league_type, start_event,
           entry_rank, entry_last_rank, entry_percentile_rank, closed
    FROM manager_leagues
    WHERE manager_id = ${managerId}
    ORDER BY entry_rank NULLS LAST, name
  `;
  return rows.map(r => ({
    leagueId: r.league_id,
    name: r.name,
    scoring: r.scoring,
    leagueType: r.league_type,
    startEvent: r.start_event,
    entryRank: r.entry_rank,
    entryLastRank: r.entry_last_rank,
    entryPercentileRank: r.entry_percentile_rank,
    closed: r.closed
  }));
}

/** Set the active league (writes the cookie). Revalidates the page. */
export async function selectLeague(formData: FormData) {
  const raw = formData.get('leagueId');
  const id = raw ? Number(raw) : NaN;
  if (Number.isFinite(id) && id > 0) {
    setLeagueId(id);
  } else {
    setLeagueId(null);
  }
  revalidatePath('/mini-league');
}
