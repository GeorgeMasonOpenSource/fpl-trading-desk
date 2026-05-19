import crypto from 'node:crypto';
import { sql } from '@/lib/db/client';
import type {
  FplBootstrap,
  FplFixture,
  FplEventLive,
  FplManagerEntry,
  FplManagerPicks,
  FplClassicLeague,
  FplElementSummary
} from './types';

// The public FPL host. All endpoints are unauthenticated and rate-limited.
// We log every fetch to raw_fpl_responses so we can re-derive everything offline.
const BASE = 'https://fantasy.premierleague.com/api';

interface FetchOpts {
  gameweek?: number;
  entityId?: number;
}

async function fetchAndCache<T>(path: string, source: string, opts: FetchOpts = {}): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'fpl-trading-desk/0.1 (+https://github.com/your/repo)',
      'accept': 'application/json'
    },
    cache: 'no-store'
  });
  const text = await res.text();
  if (!res.ok) {
    // Still log the failure
    await sql`
      INSERT INTO raw_fpl_responses (source, url, status_code, gameweek, entity_id, payload, payload_hash)
      VALUES (${source}, ${url}, ${res.status}, ${opts.gameweek ?? null}, ${opts.entityId ?? null},
              ${sql.json({ error: text.slice(0, 4000) } as any)}, ${crypto.createHash('sha256').update(text).digest('hex')})
      ON CONFLICT DO NOTHING
    `;
    throw new Error(`FPL ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as T;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  // Best-effort dedupe via UNIQUE (source, entity_id, gameweek, payload_hash)
  await sql`
    INSERT INTO raw_fpl_responses (source, url, status_code, gameweek, entity_id, payload, payload_hash)
    VALUES (${source}, ${url}, ${res.status}, ${opts.gameweek ?? null}, ${opts.entityId ?? null},
            ${sql.json(data as any)}, ${hash})
    ON CONFLICT DO NOTHING
  `;
  return data;
}

export const fpl = {
  bootstrap: () =>
    fetchAndCache<FplBootstrap>('/bootstrap-static/', 'bootstrap-static'),

  fixtures: () =>
    fetchAndCache<FplFixture[]>('/fixtures/', 'fixtures'),

  fixturesForGameweek: (gw: number) =>
    fetchAndCache<FplFixture[]>(`/fixtures/?event=${gw}`, 'fixtures-event', { gameweek: gw }),

  eventLive: (gw: number) =>
    fetchAndCache<FplEventLive>(`/event/${gw}/live/`, 'event-live', { gameweek: gw }),

  managerEntry: (managerId: number) =>
    fetchAndCache<FplManagerEntry>(`/entry/${managerId}/`, 'manager-entry', { entityId: managerId }),

  managerHistory: (managerId: number) =>
    fetchAndCache<unknown>(`/entry/${managerId}/history/`, 'manager-history', { entityId: managerId }),

  managerPicks: (managerId: number, gw: number) =>
    fetchAndCache<FplManagerPicks>(`/entry/${managerId}/event/${gw}/picks/`, 'manager-picks', { entityId: managerId, gameweek: gw }),

  managerTransfers: (managerId: number) =>
    fetchAndCache<unknown>(`/entry/${managerId}/transfers/`, 'manager-transfers', { entityId: managerId }),

  classicLeague: (leagueId: number, page = 1) =>
    fetchAndCache<FplClassicLeague>(`/leagues-classic/${leagueId}/standings/?page_standings=${page}`,
      'classic-league', { entityId: leagueId }),

  elementSummary: (playerId: number) =>
    fetchAndCache<FplElementSummary>(`/element-summary/${playerId}/`, 'element-summary', { entityId: playerId })
};
