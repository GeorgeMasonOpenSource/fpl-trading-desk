import { sql } from '@/lib/db/client';
import { clamp01 } from '@/lib/util/math';

/**
 * Role Matrix.
 *
 * Roles are *learned* from current-season lineup + minutes observations.
 * Every observation is weighted, with recent matches counting more. Roles
 * expire if not verified in 4 weeks — staleness reduces confidence.
 *
 * Players can hold multiple roles with different probabilities. A winger
 * can be both LW (suitability 0.85) and RW (0.55) and emergency ST (0.20).
 *
 * If a player changes team / position, we reset role observations from the
 * new context (handled in normaliseBootstrap: a change in player.team_id
 * triggers a role_confidence_history "reset" row).
 */

const HALF_LIFE_DAYS = 21;
const STALE_DAYS = 28;

/** Rebuild role matrix from observations. Idempotent. */
export async function recomputeRoleMatrix(playerId?: number) {
  const players = playerId
    ? await sql<Array<{ id: number }>>`SELECT id FROM players WHERE id = ${playerId}`
    : await sql<Array<{ id: number }>>`SELECT id FROM players`;

  for (const p of players) {
    const obs = await sql<Array<{ role: string; weight: number; minutes: number; age_days: number }>>`
      SELECT role, weight, minutes,
             EXTRACT(EPOCH FROM (now() - observed_at)) / 86400 AS age_days
      FROM player_role_observations
      WHERE player_id = ${p.id}
    `;
    if (obs.length === 0) continue;

    // Time-decayed weight by 1/2 every HALF_LIFE_DAYS
    const decayed = new Map<string, { w: number; m: number }>();
    let totalW = 0;
    for (const o of obs) {
      const w = o.weight * Math.pow(0.5, o.age_days / HALF_LIFE_DAYS);
      const cur = decayed.get(o.role) ?? { w: 0, m: 0 };
      cur.w += w; cur.m += o.minutes * w;
      decayed.set(o.role, cur);
      totalW += w;
    }
    if (totalW === 0) continue;

    // Clear and rewrite this player's matrix.
    await sql`DELETE FROM player_role_matrix WHERE player_id = ${p.id} AND source != 'manual_override'`;

    const sorted = [...decayed.entries()].sort((a, b) => b[1].w - a[1].w);
    for (let i = 0; i < sorted.length; i++) {
      const [role, v] = sorted[i];
      const suitability = clamp01(v.w / totalW);
      // Confidence shrinks if our newest observation is stale.
      const newest = Math.min(...obs.filter(o => o.role === role).map(o => o.age_days));
      const staleness = clamp01(newest / STALE_DAYS);
      const confidence = clamp01(Math.min(1, totalW / 4) * (1 - 0.5 * staleness));
      const roleType: 'primary' | 'secondary' | 'emergency' =
        i === 0 ? 'primary' : i === 1 ? 'secondary' : 'emergency';
      const evidence: 'low' | 'medium' | 'high' = totalW > 6 ? 'high' : totalW > 2.5 ? 'medium' : 'low';

      await sql`
        INSERT INTO player_role_matrix
          (player_id, role, role_type, suitability, confidence, evidence_level,
           source, last_verified_at, expires_at)
        VALUES (${p.id}, ${role}, ${roleType}, ${suitability}, ${confidence}, ${evidence},
                'derived', now(), now() + (${STALE_DAYS} || ' days')::interval)
        ON CONFLICT (player_id, role, role_type) DO UPDATE SET
          suitability = EXCLUDED.suitability,
          confidence  = EXCLUDED.confidence,
          evidence_level = EXCLUDED.evidence_level,
          last_verified_at = now(),
          expires_at = EXCLUDED.expires_at
      `;
    }

    await sql`
      INSERT INTO role_confidence_history (player_id, role, confidence, reason, recorded_at)
      SELECT player_id, role, confidence, 'recompute', now()
      FROM player_role_matrix WHERE player_id = ${p.id}
    `;
  }
}

export async function applyManualRoleOverride(playerId: number, role: string, roleType: 'primary' | 'secondary' | 'emergency' | 'exclude', reason?: string, expiresAt?: Date) {
  await sql`
    INSERT INTO manual_role_overrides (player_id, role, role_type, reason, expires_at, active, created_at)
    VALUES (${playerId}, ${role}, ${roleType}, ${reason ?? null}, ${expiresAt ?? null}, TRUE, now())
  `;
  if (roleType === 'exclude') {
    await sql`DELETE FROM player_role_matrix WHERE player_id = ${playerId} AND role = ${role}`;
    return;
  }
  await sql`
    INSERT INTO player_role_matrix (player_id, role, role_type, suitability, confidence, evidence_level, source, last_verified_at, expires_at)
    VALUES (${playerId}, ${role}, ${roleType}, 1.0, 1.0, 'high', 'manual_override', now(), ${expiresAt ?? null})
    ON CONFLICT (player_id, role, role_type) DO UPDATE SET
      suitability = 1.0,
      confidence  = 1.0,
      source = 'manual_override',
      last_verified_at = now(),
      expires_at = EXCLUDED.expires_at
  `;
}
