import { NextRequest } from 'next/server';
import { runBacktest } from '@/lib/backtest/runner';
import { ok, fail } from '@/lib/util/auth';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;     // Hobby plan: 60s max

const Body = z.object({
  name: z.string(),
  fromGameweek: z.number().int(),
  toGameweek: z.number().int(),
  rules: z.object({
    chaseRecentGoals: z.boolean().default(false),
    europeanRotationPenalty: z.boolean().default(true),
    rotationResistanceScaling: z.boolean().default(true),
    seasonStageWeighting: z.boolean().default(true),
    teamObjectiveScoring: z.boolean().default(false),
    returnFromInjuryCaps: z.boolean().default(true)
  }).default({} as any),
  cohort: z.enum(['all','GKP','DEF','MID','FWD']).default('all')
});

export async function POST(req: NextRequest) {
  const json = await req.json();
  const parsed = Body.safeParse(json);
  if (!parsed.success) return fail(parsed.error.message);
  const { name, ...spec } = parsed.data;
  const result = await runBacktest(name, spec as any);
  return ok(result);
}
