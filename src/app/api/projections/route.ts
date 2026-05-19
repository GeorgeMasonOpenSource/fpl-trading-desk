import { NextRequest } from 'next/server';
import { sql } from '@/lib/db/client';
import { ok, fail } from '@/lib/util/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Reads cached projections for a gameweek. Optional position / team filters.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const gw = Number(url.searchParams.get('gameweek'));
  if (!gw) return fail('gameweek required');
  const position = url.searchParams.get('position') ?? null;
  const teamId = url.searchParams.get('teamId') ? Number(url.searchParams.get('teamId')) : null;
  const rows = await sql`
    SELECT p.id AS player_id, p.web_name, p.position, t.short_name AS team_short,
           pr.xpts_total, pr.xpts_appearance, pr.xpts_goals, pr.xpts_assists,
           pr.xpts_clean_sheet, pr.xpts_bonus, pr.xpts_saves, pr.xpts_pen_save,
           pr.xpts_cards, pr.xpts_concede, pr.floor, pr.ceiling,
           pr.risk_score, pr.confidence_score, pr.reasons,
           mp.start_prob, mp.sixty_plus_prob, mp.ninety_prob,
           mp.expected_minutes, mp.rotation_risk, mp.rotation_resistance,
           mp.reliability_index, mp.minutes_confidence
    FROM projections pr
    JOIN players p ON p.id = pr.player_id
    JOIN teams   t ON t.id = p.team_id
    LEFT JOIN minutes_projections mp
      ON mp.player_id = pr.player_id AND mp.fixture_id = pr.fixture_id
    WHERE pr.gameweek_id = ${gw}
      AND ( ${position}::text IS NULL OR p.position = ${position} )
      AND ( ${teamId}::int   IS NULL OR p.team_id = ${teamId} )
    ORDER BY pr.xpts_total DESC
    LIMIT 600
  `;
  return ok({ gameweek: gw, rows });
}
