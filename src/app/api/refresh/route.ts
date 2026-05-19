import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/client';
import { recomputeMinutesForGameweek } from '@/lib/minutes/engine';
import { recomputeProjectionsForGameweek } from '@/lib/projections/engine';
import { recomputeTeamStrengths } from '@/lib/projections/team-strength';
import { recomputeBaselines } from '@/lib/projections/baseline';
import { ok, fail, requireIngestSecret } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Manual + scheduled recompute. Run in order: team_strengths -> baselines ->
// minutes -> projections. Each engine is idempotent.
export async function POST(req: NextRequest) {
  const guard = requireIngestSecret(req);
  if (guard) return guard;
  try {
    await recomputeTeamStrengths();
    await recomputeBaselines();
    const gwRows = await sql<Array<{ id: number | null }>>`
      SELECT COALESCE(
        (SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1),
        (SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1)
      ) AS id
    `;
    const gw = gwRows[0]?.id;
    if (!gw) return fail('no current or next gameweek');
    const minutesCount = await recomputeMinutesForGameweek(gw);
    const projectionCount = await recomputeProjectionsForGameweek(gw);
    return ok({ gameweek: gw, minutesCount, projectionCount });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
