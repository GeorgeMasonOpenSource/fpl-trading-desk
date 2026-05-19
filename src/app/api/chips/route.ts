import { NextRequest } from 'next/server';
import { simulateChips } from '@/lib/chips/engine';
import { ok, fail } from '@/lib/util/auth';
import { getManagerId } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const managerId = Number(url.searchParams.get('managerId') ?? getManagerId() ?? 0);
  const gw = Number(url.searchParams.get('gameweek'));
  const end = Number(url.searchParams.get('through') ?? gw + 6);
  if (!managerId || !gw) return fail('managerId and gameweek required');
  const result = await simulateChips(managerId, gw, end);
  return ok({ chips: result });
}
