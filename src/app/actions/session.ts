'use server';

/**
 * Server actions called from form submits in the UI.
 *
 * Each action:
 *   1. validates the ID by hitting the FPL public endpoint (fast — sub-second)
 *   2. persists the cookie
 *   3. runs the relevant ingestion + model refresh so the dashboard works
 *      immediately
 *   4. revalidates the affected pages
 */
import { revalidatePath, revalidateTag } from 'next/cache';
import { fpl } from '@/lib/fpl/client';
import { sql } from '@/lib/db/client';
import {
  upsertManagerEntry, upsertManagerPicks, upsertClassicLeague, upsertManagerLeagues
} from '@/lib/fpl/normalise';
import { setManagerId, setLeagueId, getManagerId, getLeagueId } from '@/lib/session';

export interface ConnectResult {
  ok: boolean;
  managerId?: number;
  leagueId?: number | null;
  gameweek?: number | null;
  error?: string;
  ingested?: {
    teams: number; players: number; fixtures: number;
    manager?: string; league?: string;
  };
}

/** Hit the FPL manager endpoint to confirm the ID is real, then ingest the
 *  light per-user bits. Heavy ingestion (bootstrap, fixtures, model recompute)
 *  is intentionally NOT done here — it's far too slow for Vercel's 10s server
 *  action timeout and is owned by the GitHub Actions cron / local seed script.
 *  If the bootstrap-derived tables (teams/players/fixtures) are empty when
 *  connect runs, we still save the manager cookie + picks so the user can see
 *  their squad immediately; the dashboard surfaces a "models warming up" hint.
 */
export async function connectManager(formData: FormData): Promise<ConnectResult> {
  const managerRaw = String(formData.get('managerId') ?? '').trim();
  const managerId = Number(managerRaw);
  if (!Number.isFinite(managerId) || managerId <= 0) {
    return { ok: false, error: 'Manager ID must be a positive integer.' };
  }

  try {
    // 1. Validate manager via FPL (fast: single endpoint, ~300ms)
    const entry = await fpl.managerEntry(managerId);
    setManagerId(managerId);
    // Auto-pick the user's top-ranked classic league as the active one
    // (they can switch later via the LeaguePicker on /mini-league).
    const classicLeagues = entry.leagues?.classic ?? [];
    const topClassic = [...classicLeagues]
      .filter(l => !l.closed)
      .sort((a, b) => (a.entry_rank ?? 9e9) - (b.entry_rank ?? 9e9))[0];
    const leagueId = topClassic?.id ?? null;
    setLeagueId(leagueId);

    // 2. Free transfer count from history (fast)
    const history = (await fpl.managerHistory(managerId)) as {
      current: Array<{ event_transfers: number }>;
    };
    let ft = 1;
    for (const h of history.current ?? []) {
      ft = h.event_transfers > 0 ? 1 : Math.min(5, ft + 1);
    }
    await upsertManagerEntry(entry, ft);
    // Persist every league the user belongs to, so the UI can list them
    // without re-fetching. Standings still pulled on demand for the one
    // they're actively monitoring.
    await upsertManagerLeagues(managerId, entry);

    // 3. Pull picks for both the current (in-progress) and next (planning)
    //    gameweeks. If next-GW picks aren't yet exposed by FPL (lineup not
    //    submitted), fall back to copying the current squad into the next
    //    slot so the planning views can render.
    const currentRows = await sql<Array<{ id: number }>>`SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1`;
    const nextRows    = await sql<Array<{ id: number }>>`SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1`;
    const currentGw = currentRows[0]?.id ?? null;
    const nextGw    = nextRows[0]?.id ?? null;

    if (currentGw != null) {
      try {
        const picks = await fpl.managerPicks(managerId, currentGw);
        await upsertManagerPicks(managerId, currentGw, picks);
      } catch { /* tolerate if FPL has nothing yet */ }
    }
    if (nextGw != null) {
      try {
        const picks = await fpl.managerPicks(managerId, nextGw);
        await upsertManagerPicks(managerId, nextGw, picks);
      } catch {
        if (currentGw != null) {
          await sql`
            INSERT INTO manager_picks (manager_id, gameweek_id, player_id, position,
                                       is_captain, is_vice, multiplier,
                                       purchase_price, selling_price)
            SELECT manager_id, ${nextGw}, player_id, position, is_captain, is_vice,
                   multiplier, purchase_price, selling_price
            FROM manager_picks
            WHERE manager_id = ${managerId} AND gameweek_id = ${currentGw}
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }
    const gw = nextGw ?? currentGw;   // for downstream return-value reporting

    let leagueLabel: string | undefined;
    if (leagueId && (currentGw != null || nextGw != null)) {
      const league = await fpl.classicLeague(leagueId);
      await upsertClassicLeague(league, currentGw ?? nextGw ?? 0);
      leagueLabel = league.league.name;
    }

    // Invalidate the per-manager caches so the dashboard reads fresh data on
    // the next paint instead of waiting for the 60s TTL.
    revalidateTag(`manager:${managerId}`);
    revalidateTag('gameweeks');
    revalidatePath('/', 'layout');

    return {
      ok: true,
      managerId,
      leagueId,
      gameweek: gw,
      ingested: {
        teams: 0, players: 0, fixtures: 0,
        manager: entry.name,
        league: leagueLabel
      }
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Just persist the manager cookie (no ingest). Used for the inline "edit"
 *  form. League is not editable here — leagues are auto-pulled from
 *  /entry/{id}/ on connect and switched via the LeaguePicker on the
 *  Mini League page. */
export async function saveIdsOnly(formData: FormData) {
  const managerRaw = String(formData.get('managerId') ?? '').trim();
  if (managerRaw) {
    const n = Number(managerRaw);
    if (Number.isFinite(n) && n > 0) setManagerId(n);
  } else {
    setManagerId(null);
  }
  revalidatePath('/', 'layout');
}

/** Disconnect: clear cookies. */
export async function disconnect() {
  setManagerId(null);
  setLeagueId(null);
  revalidatePath('/', 'layout');
}

/** Void wrappers so these are usable directly in `<form action={...}>`. */
export async function connectManagerForm(formData: FormData) {
  const r = await connectManager(formData);
  if (!r.ok) console.error('[connectManager]', r.error);
}
export async function refreshNowForm() {
  const r = await refreshNow();
  if (!r.ok) console.error('[refreshNow]', r.error);
}

/**
 *  Per-user refresh: re-fetch this manager's entry + current GW picks + the
 *  league snapshot. Keeps under Vercel Hobby's 10s server-action limit.
 *
 *  The heavy ingest (bootstrap, fixtures, team-strength + minutes +
 *  projection recompute) is owned by GitHub Actions (`/.github/workflows`)
 *  which POST to `/api/refresh` with a 60s `maxDuration` and the
 *  `INGEST_SECRET`. We deliberately do not invoke that path from a server
 *  action because the cumulative latency of sequential INSERTs from
 *  Vercel→Neon would always exceed 10s.
 */
export async function refreshNow(): Promise<ConnectResult> {
  const managerId = getManagerId();
  if (!managerId) return { ok: false, error: 'No manager connected.' };
  const leagueId = getLeagueId();
  try {
    const entry = await fpl.managerEntry(managerId);
    const history = (await fpl.managerHistory(managerId)) as {
      current: Array<{ event_transfers: number }>;
    };
    let ft = 1;
    for (const h of history.current ?? []) {
      ft = h.event_transfers > 0 ? 1 : Math.min(5, ft + 1);
    }
    await upsertManagerEntry(entry, ft);

    const currentRows = await sql<Array<{ id: number }>>`SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1`;
    const nextRows    = await sql<Array<{ id: number }>>`SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1`;
    const currentGw = currentRows[0]?.id ?? null;
    const nextGw    = nextRows[0]?.id ?? null;

    if (currentGw != null) {
      try {
        const picks = await fpl.managerPicks(managerId, currentGw);
        await upsertManagerPicks(managerId, currentGw, picks);
      } catch { /* ignore */ }
    }
    if (nextGw != null) {
      try {
        const picks = await fpl.managerPicks(managerId, nextGw);
        await upsertManagerPicks(managerId, nextGw, picks);
      } catch {
        if (currentGw != null) {
          await sql`
            INSERT INTO manager_picks (manager_id, gameweek_id, player_id, position,
                                       is_captain, is_vice, multiplier,
                                       purchase_price, selling_price)
            SELECT manager_id, ${nextGw}, player_id, position, is_captain, is_vice,
                   multiplier, purchase_price, selling_price
            FROM manager_picks
            WHERE manager_id = ${managerId} AND gameweek_id = ${currentGw}
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }
    const gw = nextGw ?? currentGw;
    if (leagueId && gw != null) {
      const league = await fpl.classicLeague(leagueId);
      await upsertClassicLeague(league, gw);
    }
    revalidateTag(`manager:${managerId}`);
    revalidateTag('live');
    revalidateTag('gameweeks');
    revalidatePath('/', 'layout');
    return { ok: true, managerId, leagueId, gameweek: gw };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
