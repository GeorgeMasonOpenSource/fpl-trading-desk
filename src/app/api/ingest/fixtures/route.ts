import { NextRequest } from 'next/server';
import { fpl } from '@/lib/fpl/client';
import { upsertFixtures } from '@/lib/fpl/normalise';
import { requireIngestSecret, ok, fail } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = requireIngestSecret(req);
  if (guard) return guard;
  try {
    const fixtures = await fpl.fixtures();
    await upsertFixtures(fixtures);
    return ok({ fixtures: fixtures.length });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
