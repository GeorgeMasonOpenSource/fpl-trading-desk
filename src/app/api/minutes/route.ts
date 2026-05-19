import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/client';
import { ok, fail } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const gw = Number(url.searchParams.get('gameweek'));
  if (!gw) return fail('gameweek required');
  const rows = await sql`
    SELECT p.id AS player_id, p.web_name, p.position, t.short_name AS team_short,
           mp.start_prob, mp.sixty_plus_prob, mp.ninety_prob, mp.sub_prob,
           mp.bench_unused_prob, mp.injury_absence_prob, mp.expected_minutes,
           mp.rotation_risk, mp.rotation_resistance, mp.minutes_confidence,
           mp.reliability_index, mp.reasons
    FROM minutes_projections mp
    JOIN fixtures f ON f.id = mp.fixture_id AND f.gameweek_id = ${gw}
    JOIN players p ON p.id = mp.player_id
    JOIN teams t   ON t.id = p.team_id
    ORDER BY mp.start_prob DESC, mp.expected_minutes DESC
    LIMIT 600
  `;
  return ok({ gameweek: gw, rows });
}
