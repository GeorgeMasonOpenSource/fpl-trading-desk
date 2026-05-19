import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/client';
import { fpl } from '@/lib/fpl/client';
import { upsertManagerEntry, upsertManagerPicks } from '@/lib/fpl/normalise';
import { requireIngestSecret, ok, fail } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = requireIngestSecret(req);
  if (guard) return guard;
  const url = new URL(req.url);
  // Scheduled jobs pass the ID explicitly; cookie helper falls through to env for cron-friendliness.
  const managerId = Number(url.searchParams.get('managerId') ?? process.env.FPL_MANAGER_ID ?? 0);
  if (!managerId) return fail('managerId not provided');
  try {
    const entry = await fpl.managerEntry(managerId);

    // Free-transfer count needs to come from the history endpoint.
    const history = (await fpl.managerHistory(managerId)) as {
      current: Array<{ event: number; event_transfers: number; event_transfers_cost: number }>;
    };
    // Free transfers: 1 at GW1, +1 each unused week, max 5 in current rules.
    let ft = 1;
    for (let i = 0; i < history.current.length; i++) {
      const used = history.current[i].event_transfers > 0;
      ft = used ? 1 : Math.min(5, ft + 1);
    }

    await upsertManagerEntry(entry, ft);

    const gwRows = await sql<{ id: number | null }[]>`
      SELECT COALESCE(
        (SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1),
        (SELECT id FROM gameweeks WHERE is_next = TRUE LIMIT 1)
      ) AS id
    `;
    const currentGw = gwRows[0]?.id ?? null;
    if (currentGw) {
      const picks = await fpl.managerPicks(managerId, currentGw);
      await upsertManagerPicks(managerId, currentGw, picks);
    }
    return ok({ managerId, gameweek: currentGw, freeTransfers: ft });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
