import { NextRequest } from 'next/server';
import { fpl } from '@/lib/fpl/client';
import { upsertBootstrap, upsertFixtures } from '@/lib/fpl/normalise';
import { requireIngestSecret, ok, fail } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Daily bootstrap pull: teams, players, gameweeks, fixtures list.
export async function POST(req: NextRequest) {
  const guard = requireIngestSecret(req);
  if (guard) return guard;
  try {
    const bs = await fpl.bootstrap();
    await upsertBootstrap(bs);
    const fixtures = await fpl.fixtures();
    await upsertFixtures(fixtures);
    return ok({
      teams: bs.teams.length,
      events: bs.events.length,
      players: bs.elements.length,
      fixtures: fixtures.length
    });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
