import { NextRequest } from 'next/server';
import { rankCaptains } from '@/lib/captaincy/engine';
import { ok, fail } from '@/lib/util/auth';
import { getManagerId, getLeagueId } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const managerId = Number(url.searchParams.get('managerId') ?? getManagerId() ?? 0);
  const gw = Number(url.searchParams.get('gameweek'));
  const leagueIdParam = url.searchParams.get('leagueId') ?? getLeagueId();
  const leagueId = leagueIdParam ? Number(leagueIdParam) : undefined;
  if (!managerId || !gw) return fail('managerId and gameweek required');
  const result = await rankCaptains(managerId, gw, leagueId);
  return ok(result);
}
