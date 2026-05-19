import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/client';
import { compareTransferScenarios } from '@/lib/transfers/optimiser';
import { ok, fail } from '@/lib/util/auth';
import { getManagerId } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const managerId = Number(url.searchParams.get('managerId') ?? getManagerId() ?? 0);
  const gw = Number(url.searchParams.get('gameweek'));
  if (!managerId || !gw) return fail('managerId and gameweek required');
  const rows = await sql<Array<{ free_transfers: number }>>`
    SELECT COALESCE(free_transfers, 1) AS free_transfers FROM manager_teams WHERE manager_id = ${managerId}
  `;
  const free_transfers = rows[0]?.free_transfers ?? 1;
  const result = await compareTransferScenarios({
    managerId, startGameweek: gw,
    freeTransfers: free_transfers,
    evThreshold: Number(process.env.EV_TRANSFER_THRESHOLD ?? 0.6),
    hitThreshold: Number(process.env.EV_HIT_THRESHOLD ?? 1.5)
  });
  return ok({ scenarios: result });
}
