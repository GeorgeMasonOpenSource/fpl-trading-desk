import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/client';
import { fpl } from '@/lib/fpl/client';
import { upsertEventLive, upsertFixtures } from '@/lib/fpl/normalise';
import { requireIngestSecret, ok, fail } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Live refresh: pull the current event's live data + fixtures status.
// Designed to be called on a 1-5 minute cadence during active matches and
// hourly otherwise. The job itself is cheap; the gating happens in the
// scheduled-job workflow which skips outside live windows.
export async function POST(req: NextRequest) {
  const guard = requireIngestSecret(req);
  if (guard) return guard;
  try {
    const gwRows = await sql<{ id: number }[]>`
      SELECT id FROM gameweeks WHERE is_current = TRUE
      UNION ALL SELECT id FROM gameweeks WHERE is_next = TRUE
      LIMIT 1
    `;
    const currentGw = gwRows[0]?.id;
    if (!currentGw) return fail('no current or next gameweek');
    const fixtures = await fpl.fixturesForGameweek(currentGw);
    await upsertFixtures(fixtures);
    const live = await fpl.eventLive(currentGw);
    await upsertEventLive(currentGw, live);
    return ok({ gameweek: currentGw, fixtures: fixtures.length, elements: live.elements.length });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
