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
  upsertBootstrap, upsertFixtures, upsertManagerEntry, upsertManagerPicks,
  upsertClassicLeague
} from '@/lib/fpl/normalise';
import { recomputeTeamStrengths } from '@/lib/projections/team-strength';
import { recomputeBaselines } from '@/lib/projections/baseline';
import { recomputeMinutesForGameweek } from '@/lib/minutes/engine';
import { recomputeProjectionsForGameweek } from '@/lib/projections/engine';
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

/** Hit the FPL manager endpoint to confirm the ID is real, then ingest everything. */
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

  // 1. Validate manager via FPL
  let managerName: string;
  try {
    const entry = await fpl.managerEntry(managerId);
    managerName = entry.name;
    // Persist cookies before doing anything heavier so the user gets immediate feedback.
    setManagerId(managerId);
    setLeagueId(leagueId);

    // Refresh bootstrap + fixtures so we have current data to project against.
    const bs = await fpl.bootstrap();
    await upsertBootstrap(bs);
    const fixtures = await fpl.fixtures();
    await upsertFixtures(fixtures);

    // Free transfer count from history
    const history = (await fpl.managerHistory(managerId)) as {
      current: Array<{ event_transfers: number }>;
    };
    let ft = 1;
    for (const h of history.current ?? []) {
      ft = h.event_transfers > 0 ? 1 : Math.min(5, ft + 1);
    }
    await upsertManagerEntry(entry, ft);

    // Current GW + picks
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
    if (leagueId) {
      const league = await fpl.classicLeague(leagueId);
      await upsertClassicLeague(league, gw ?? 0);
      leagueLabel = league.league.name;
    }

    // Recompute the models so the dashboard isn't empty.
    await recomputeTeamStrengths();
    await recomputeBaselines();
    if (gw != null) {
      await recomputeMinutesForGameweek(gw);
      await recomputeProjectionsForGameweek(gw);
    }

    // Refresh every page that depends on session state.
    revalidatePath('/', 'layout');

    return {
      ok: true,
      managerId,
      leagueId,
      gameweek: gw,
      ingested: {
        teams: bs.teams.length,
        players: bs.elements.length,
        fixtures: fixtures.length,
        manager: managerName,
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

/** Pull fresh manager + league picks + recompute models. Quick path. */
export async function refreshNow(): Promise<ConnectResult> {
  const managerId = getManagerId();
  if (!managerId) return { ok: false, error: 'No manager connected.' };
  const leagueId = getLeagueId();
  try {
    // Light bootstrap to catch price changes / status flags
    const bs = await fpl.bootstrap();
    await upsertBootstrap(bs);
    await upsertFixtures(await fpl.fixtures());

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
    if (leagueId) {
      const league = await fpl.classicLeague(leagueId);
      await upsertClassicLeague(league, gw ?? 0);
    }
    await recomputeTeamStrengths();
    if (gw != null) {
      await recomputeMinutesForGameweek(gw);
      await recomputeProjectionsForGameweek(gw);
    }
    revalidatePath('/', 'layout');
    return { ok: true, managerId, leagueId, gameweek: gw };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
