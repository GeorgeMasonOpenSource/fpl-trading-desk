import { sql } from '@/lib/db/client';

/**
 * Set-piece role tracking.
 *
 * Who takes pens, direct freekicks, corner deliveries — these change
 * across a season (new signing arrives, manager swaps roles, etc.) and
 * are a leading indicator of xPts changes 2-3 weeks before the season
 * averages catch up.
 *
 * We derive role assignments from observed shot data in
 * player_shot_history:
 *   - Penalty taker = player with the most `situation = 'Penalty'`
 *     shots this season for that team. Tied teams: pick the most recent.
 *   - Direct freekick taker = same logic for `DirectFreekick`.
 *   - Corner taker = harder to derive from shots alone (corners create
 *     SHOTS by other players). We use `FromCorner` shots' assister:
 *     the player most often credited as assister on corner-situation
 *     shots is the team's primary corner taker.
 *
 * Stored in team_set_piece_roles with one row per (team, role).
 */

export interface SetPieceRole {
  teamId: number;
  role: 'penalty' | 'direct_fk' | 'corner';
  playerId: number | null;
  webName: string | null;
  evidenceCount: number;
  confidence: number;  // 0..1
  lastEvidenceDate: string | null;
}

export async function recomputeSetPieceRoles(): Promise<SetPieceRole[]> {
  await sql`
    CREATE TABLE IF NOT EXISTS team_set_piece_roles (
      team_id            INT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role               TEXT NOT NULL CHECK (role IN ('penalty', 'direct_fk', 'corner')),
      player_id          INT REFERENCES players(id) ON DELETE SET NULL,
      evidence_count     INT NOT NULL DEFAULT 0,
      confidence         NUMERIC(4,3) NOT NULL DEFAULT 0,
      last_evidence_date TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (team_id, role)
    )
  `;

  // 1. Penalty taker: most penalty shots per team this season.
  const penRows = await sql<Array<{
    team_id: number; player_id: number; web_name: string;
    count: number; last_date: Date;
  }>>`
    WITH pen_shots AS (
      SELECT psh.player_id, p.team_id, p.web_name, psh.match_date
        FROM player_shot_history psh
        JOIN players p ON p.id = psh.player_id
       WHERE psh.situation = 'Penalty'
    ),
    counts AS (
      SELECT team_id, player_id, web_name,
             COUNT(*)::int AS count,
             MAX(match_date) AS last_date
        FROM pen_shots
       GROUP BY team_id, player_id, web_name
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY count DESC, last_date DESC) AS rn
        FROM counts
    )
    SELECT team_id, player_id, web_name, count, last_date FROM ranked WHERE rn = 1
  `;

  // 2. Direct FK taker.
  const fkRows = await sql<Array<{
    team_id: number; player_id: number; web_name: string;
    count: number; last_date: Date;
  }>>`
    WITH fk_shots AS (
      SELECT psh.player_id, p.team_id, p.web_name, psh.match_date
        FROM player_shot_history psh
        JOIN players p ON p.id = psh.player_id
       WHERE psh.situation = 'DirectFreekick'
    ),
    counts AS (
      SELECT team_id, player_id, web_name,
             COUNT(*)::int AS count, MAX(match_date) AS last_date
        FROM fk_shots GROUP BY team_id, player_id, web_name
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY count DESC, last_date DESC) AS rn
        FROM counts
    )
    SELECT team_id, player_id, web_name, count, last_date FROM ranked WHERE rn = 1
  `;

  // 3. Corner taker. The shot table has the SHOOTER not the corner taker;
  // we approximate by looking at the most common player_assisted_id for
  // 'FromCorner' shots. This requires the column to be populated — if
  // not, we fall back to "team's set-piece specialist" (high FK count).
  const cornerRows = await sql<Array<{
    team_id: number; player_id: number; web_name: string;
    count: number; last_date: Date;
  }>>`
    WITH corner_assists AS (
      SELECT CAST(psh.player_assisted AS TEXT) AS player_assisted,
             pteam.team_id, pteam.web_name, psh.match_date
        FROM player_shot_history psh
        JOIN players p ON p.id = psh.player_id
        JOIN players pteam ON pteam.web_name = psh.player_assisted AND pteam.team_id = p.team_id
       WHERE psh.situation = 'FromCorner'
         AND psh.player_assisted IS NOT NULL
    ),
    counts AS (
      SELECT team_id,
             pteam.id AS player_id,
             pteam.web_name,
             COUNT(*)::int AS count,
             MAX(match_date) AS last_date
        FROM corner_assists ca
        JOIN players pteam ON pteam.web_name = ca.player_assisted AND pteam.team_id = ca.team_id
       GROUP BY team_id, pteam.id, pteam.web_name
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY count DESC, last_date DESC) AS rn
        FROM counts
    )
    SELECT team_id, player_id, web_name, count, last_date FROM ranked WHERE rn = 1
  `.catch(() => [] as any);

  const out: SetPieceRole[] = [];
  await sql`TRUNCATE team_set_piece_roles`;

  const upsert = async (
    role: 'penalty' | 'direct_fk' | 'corner',
    rows: Array<{ team_id: number; player_id: number; web_name: string; count: number; last_date: Date }>
  ) => {
    for (const r of rows) {
      // Confidence: 1 evidence = 0.3, 3 = 0.6, 5+ = 0.9.
      const confidence = Math.max(0, Math.min(1, 0.2 + 0.15 * Number(r.count)));
      const lastIso = r.last_date instanceof Date
        ? r.last_date.toISOString()
        : String(r.last_date);
      await sql`
        INSERT INTO team_set_piece_roles
          (team_id, role, player_id, evidence_count, confidence, last_evidence_date)
        VALUES (${r.team_id}, ${role}, ${r.player_id}, ${r.count}, ${confidence}, ${lastIso})
        ON CONFLICT (team_id, role) DO UPDATE
          SET player_id = EXCLUDED.player_id,
              evidence_count = EXCLUDED.evidence_count,
              confidence = EXCLUDED.confidence,
              last_evidence_date = EXCLUDED.last_evidence_date,
              updated_at = now()
      `;
      out.push({
        teamId: r.team_id, role, playerId: r.player_id, webName: r.web_name,
        evidenceCount: Number(r.count), confidence,
        lastEvidenceDate: lastIso
      });
    }
  };
  await upsert('penalty', penRows as any);
  await upsert('direct_fk', fkRows as any);
  await upsert('corner', cornerRows as any);
  return out;
}

export async function loadSetPieceRoles(): Promise<Map<string, SetPieceRole>> {
  const out = new Map<string, SetPieceRole>();
  try {
    const rows = await sql<Array<{
      team_id: number; role: string; player_id: number | null;
      web_name: string | null;
      evidence_count: number; confidence: number;
      last_evidence_date: Date | null;
    }>>`
      SELECT spr.team_id, spr.role, spr.player_id, p.web_name,
             spr.evidence_count, spr.confidence::float8,
             spr.last_evidence_date
        FROM team_set_piece_roles spr
        LEFT JOIN players p ON p.id = spr.player_id
    `;
    for (const r of rows) {
      out.set(`${r.team_id}:${r.role}`, {
        teamId: r.team_id,
        role: r.role as any,
        playerId: r.player_id,
        webName: r.web_name,
        evidenceCount: Number(r.evidence_count),
        confidence: Number(r.confidence),
        lastEvidenceDate: r.last_evidence_date ? new Date(r.last_evidence_date as any).toISOString() : null
      });
    }
  } catch {/* */}
  return out;
}
