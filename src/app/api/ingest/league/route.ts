import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/client';
import { fpl } from '@/lib/fpl/client';
import { upsertClassicLeague } from '@/lib/fpl/normalise';
import { requireIngestSecret, ok, fail } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = requireIngestSecret(req);
  if (guard) return guard;
  const url = new URL(req.url);
  const leagueId = Number(url.searchParams.get('leagueId') ?? process.env.FPL_LEAGUE_ID ?? 0);
  if (!leagueId) return fail('leagueId not provided');
  try {
    const gwRows = await sql<{ id: number | null }[]>`
      SELECT COALESCE(
        (SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1),
        (SELECT id FROM gameweeks WHERE is_previous = TRUE ORDER BY id DESC LIMIT 1),
        (SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1)
      ) AS id
    `;
    const currentGw = gwRows[0]?.id ?? null;
    let page = 1;
    let total = 0;
    while (true) {
      const data = await fpl.classicLeague(leagueId, page);
      await upsertClassicLeague(data, currentGw ?? 0);
      total += data.standings.results.length;
      if (data.standings.results.length < 50 || page >= 4) break;  // cap at 200 managers for cost control
      page++;
    }
    return ok({ leagueId, gameweek: currentGw, entries: total });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
