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
import { revalidatePath } from 'next/cache';
import { fpl } from '@/lib/fpl/client';
import { sql } from '@/lib/db/client';
import {
  upsertManagerEntry, upsertManagerPicks, upsertClassicLeague
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
  const leagueRaw = String(formData.get('leagueId') ?? '').trim();
  const managerId = Number(managerRaw);
  if (!Number.isFinite(managerId) || managerId <= 0) {
    return { ok: false, error: 'Manager ID must be a positive integer.' };
  }
  const leagueId = leagueRaw ? Number(leagueRaw) : null;
  if (leagueRaw && (!Number.isFinite(leagueId!) || (leagueId ?? 0) <= 0)) {
    return { ok: false, error: 'League ID must be a positive integer (or blank).' };
  }

  try {
    // 1. Validate manager via FPL (fast: single endpoint, ~300ms)
    const entry = await fpl.managerEntry(managerId);
    setManagerId(managerId);
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

    // 3. Current GW + picks — needs gameweeks table populated; if not (fresh
    //    deploy before first cron run), skip silently and the dashboard hint
    //    will tell the user to wait.
    const gwRows = await sql<Array<{ id: number }>>`
      SELECT id FROM gameweeks WHERE is_current = TRUE UNION ALL
      SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1
    `;
    const gw = gwRows[0]?.id ?? null;
    if (gw != null) {
      const picks = await fpl.managerPicks(managerId, gw);
      await upsertManagerPicks(managerId, gw, picks);
    }

    let leagueLabel: string | undefined;
    if (leagueId && gw != null) {
      const league = await fpl.classicLeague(leagueId);
      await upsertClassicLeague(league, gw);
      leagueLabel = league.league.name;
    }

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

/** Just persist the cookies (no ingest). Used for the inline "edit" form. */
export async function saveIdsOnly(formData: FormData) {
  const managerRaw = String(formData.get('managerId') ?? '').trim();
  const leagueRaw  = String(formData.get('leagueId') ?? '').trim();
  if (managerRaw) {
    const n = Number(managerRaw);
    if (Number.isFinite(n) && n > 0) setManagerId(n);
  } else {
    setManagerId(null);
  }
  if (leagueRaw) {
    const n = Number(leagueRaw);
    if (Number.isFinite(n) && n > 0) setLeagueId(n);
  } else {
    setLeagueId(null);
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

    const gwRows = await sql<Array<{ id: number }>>`
      SELECT id FROM gameweeks WHERE is_current = TRUE UNION ALL
      SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1
    `;
    const gw = gwRows[0]?.id ?? null;
    if (gw != null) {
      const picks = await fpl.managerPicks(managerId, gw);
      await upsertManagerPicks(managerId, gw, picks);
    }
    if (leagueId && gw != null) {
      const league = await fpl.classicLeague(leagueId);
      await upsertClassicLeague(league, gw);
    }
    revalidatePath('/', 'layout');
    return { ok: true, managerId, leagueId, gameweek: gw };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
