import { NextRequest } from 'next/server';
import { buildWarRoom } from '@/lib/mini-league/engine';
import { ok, fail } from '@/lib/util/auth';
import { getManagerId, getLeagueId } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const managerId = Number(url.searchParams.get('managerId') ?? getManagerId() ?? 0);
  const leagueId = Number(url.searchParams.get('leagueId') ?? getLeagueId() ?? 0);
  const gw = Number(url.searchParams.get('gameweek'));
  if (!managerId || !leagueId || !gw) return fail('managerId, leagueId, gameweek required');
  const result = await buildWarRoom(leagueId, managerId, gw);
  return ok(result);
}
