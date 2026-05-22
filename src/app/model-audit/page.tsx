/**
 * Model Audit page
 *
 * Always-on equivalent of the player-xray CLI tool. Pick any player, see
 * the full input/output decomposition: every signal the projection engine
 * used + every component of the xPts they got. Designed so structural
 * gaps to FPLReview / other reference models are spot-able in seconds.
 *
 * What it surfaces per player:
 *   - Team Bayesian ratings (attack, defence) — the dominant team xG driver
 *   - Opponent ratings — multiplied against own team's
 *   - Understat shot aggregates — open-play vs pen xG (if resolved)
 *   - Hierarchical per-90 estimates with shrinkage weight
 *   - Minutes inputs (recent avg/app, season avg/app, motivation, injuries)
 *   - Minutes outputs (start_prob, sixty_plus_prob, expected_mins)
 *   - Projection breakdown (apps / goals / assists / CS / bonus / defcon)
 *   - Reason strings from the engine
 *
 * Use it to answer: "why is the model giving Bowen 3.02?"
 */
import { sql } from '@/lib/db/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ModelAuditPicker } from '@/components/ModelAuditPicker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ModelAuditPage({ searchParams }: {
  searchParams: { q?: string; gw?: string };
}) {
  const q = (searchParams.q ?? '').trim();

  // Resolve target gameweek.
  const gwArg = searchParams.gw ? Number(searchParams.gw) : null;
  const gwRow = gwArg
    ? await sql<Array<{ id: number; name: string }>>`
        SELECT id, name FROM gameweeks WHERE id = ${gwArg} LIMIT 1
      `
    : await sql<Array<{ id: number; name: string }>>`
        SELECT id, name FROM gameweeks
         WHERE is_next = TRUE OR is_current = TRUE
         ORDER BY is_next DESC, is_current DESC LIMIT 1
      `;
  const gw = gwRow[0];
  if (!gw) {
    return <p className="text-ink-muted">No gameweek data. Run db:seed.</p>;
  }

  // Player list for the searchable picker.
  const allPlayers = await sql<Array<{
    id: number; web_name: string; full_name: string; team_short: string; position: string;
  }>>`
    SELECT p.id, p.web_name,
           (p.first_name || ' ' || p.second_name) AS full_name,
           t.short_name AS team_short, p.position
      FROM players p JOIN teams t ON t.id = p.team_id
     WHERE p.status <> 'u'
     ORDER BY p.web_name
  `;

  // If we have a query, resolve the player.
  let audit: AuditData | null = null;
  if (q) {
    audit = await loadAudit(q, gw.id);
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Model audit</div>
        <h1 className="text-2xl font-semibold">Why is this player rated the way they are?</h1>
        <p className="text-sm text-ink-muted mt-1">
          Full input + output decomposition for any player. Pick from the search box;
          everything the projection engine saw is shown below.
        </p>
      </header>

      <ModelAuditPicker
        players={allPlayers.map(p => ({
          id: p.id, label: `${p.web_name} (${p.team_short}, ${p.position})`,
          search: `${p.web_name} ${p.full_name} ${p.team_short} ${p.position}`.toLowerCase()
        }))}
        gwId={gw.id}
        initialQuery={q}
      />

      {!audit && q && (
        <Card title="No match">
          <p className="text-sm text-ink-muted">
            No player matched &ldquo;{q}&rdquo;. Try a different web name or surname.
          </p>
        </Card>
      )}

      {audit && <AuditView audit={audit} gwName={gw.name} />}
    </div>
  );
}

/* ─── data load ─────────────────────────────────────────────────────────── */

interface AuditData {
  player: {
    id: number; webName: string; firstName: string; secondName: string;
    position: 'GKP'|'DEF'|'MID'|'FWD'; teamId: number; teamShort: string; teamName: string;
    status: string; chanceOfPlayingNext: number | null;
    nowCost: number; sellingPrice: number | null;
    seasonMinutes: number; seasonStarts: number;
    seasonXg: number; seasonXa: number; seasonBonus: number;
    seasonDefconPer90: number;
  };
  team: {
    attack: number; defence: number; motivation: number | null;
  };
  fixtures: Array<{
    isHome: boolean; opponentName: string; opponentShort: string;
    opponentAttack: number; opponentDefence: number;
    kickoffTime: string | null;
  }>;
  shots: {
    openPlayShots: number; openPlayXg: number; openPlayGoals: number;
    penaltyShots: number; penaltyXg: number; penaltyGoals: number;
    lastMatchDate: string | null;
  } | null;
  hierarchical: { xg90: number; xa90: number; bonus90: number; ownWeight: number } | null;
  minutes: Array<{
    startProb: number; sixtyPlusProb: number; expectedMinutes: number;
    rotationRisk: number; reasons: any;
  }>;
  projection: Array<{
    xptsTotal: number; xptsAppearance: number; xptsGoals: number;
    xptsAssists: number; xptsCleanSheet: number; xptsBonus: number; xptsDefcon: number;
    floor: number; ceiling: number;
    reasons: any;
  }>;
}

async function loadAudit(query: string, gwId: number): Promise<AuditData | null> {
  // Resolve player (fuzzy match).
  const players = await sql<Array<{
    id: number; web_name: string; first_name: string; second_name: string;
    position: 'GKP'|'DEF'|'MID'|'FWD'; team_id: number; team_short: string; team_name: string;
    status: string; chance_of_playing_next_round: number | null;
    now_cost: number;
    season_minutes: number; season_starts: number; season_xg: number;
    season_xa: number; season_bonus: number; season_defcon_per_90: number;
  }>>`
    SELECT p.id, p.web_name, p.first_name, p.second_name, p.position,
           p.team_id, t.short_name AS team_short, t.name AS team_name,
           p.status, p.chance_of_playing_next_round,
           p.now_cost,
           COALESCE(p.season_minutes, 0) AS season_minutes,
           COALESCE(p.season_starts, 0) AS season_starts,
           COALESCE(p.season_xg, 0) AS season_xg,
           COALESCE(p.season_xa, 0) AS season_xa,
           COALESCE(p.season_bonus, 0) AS season_bonus,
           COALESCE(p.season_defcon_per_90, 0) AS season_defcon_per_90
      FROM players p JOIN teams t ON t.id = p.team_id
     WHERE LOWER(p.web_name)    = ${query.toLowerCase()}
        OR LOWER(p.second_name) = ${query.toLowerCase()}
        OR LOWER(p.first_name || ' ' || p.second_name) LIKE ${`%${query.toLowerCase()}%`}
     LIMIT 1
  `;
  const p = players[0];
  if (!p) return null;

  const teamRow = await sql<Array<{
    attacking_style: number; defensive_solidity: number; motivation_score: number | null;
  }>>`
    SELECT COALESCE(attacking_style, 1.0)::float8 AS attacking_style,
           COALESCE(defensive_solidity, 1.0)::float8 AS defensive_solidity,
           motivation_score
      FROM teams WHERE id = ${p.team_id}
  `;
  const t = teamRow[0]!;

  const fixRows = await sql<Array<{
    id: number; team_h: number; team_a: number;
    home_name: string; away_name: string;
    home_short: string; away_short: string;
    home_attack: number; home_defence: number;
    away_attack: number; away_defence: number;
    kickoff_time: string | Date | null;
  }>>`
    SELECT f.id, f.team_h, f.team_a,
           th.name AS home_name, ta.name AS away_name,
           th.short_name AS home_short, ta.short_name AS away_short,
           COALESCE(th.attacking_style, 1.0)::float8    AS home_attack,
           COALESCE(th.defensive_solidity, 1.0)::float8 AS home_defence,
           COALESCE(ta.attacking_style, 1.0)::float8    AS away_attack,
           COALESCE(ta.defensive_solidity, 1.0)::float8 AS away_defence,
           f.kickoff_time
      FROM fixtures f
      JOIN teams th ON th.id = f.team_h
      JOIN teams ta ON ta.id = f.team_a
     WHERE f.gameweek_id = ${gwId}
       AND (f.team_h = ${p.team_id} OR f.team_a = ${p.team_id})
  `;
  const fixtures = fixRows.map(f => {
    const isHome = f.team_h === p.team_id;
    return {
      isHome,
      opponentName:   isHome ? f.away_name  : f.home_name,
      opponentShort:  isHome ? f.away_short : f.home_short,
      opponentAttack: isHome ? f.away_attack : f.home_attack,
      opponentDefence: isHome ? f.away_defence : f.home_defence,
      kickoffTime: f.kickoff_time
        ? (f.kickoff_time instanceof Date ? f.kickoff_time.toISOString() : String(f.kickoff_time))
        : null
    };
  });

  let shots = null;
  try {
    const shotRows = await sql<Array<{
      shots_open_play: number; shots_penalty: number;
      xg_open_play: number; xg_penalty: number;
      goals_open_play: number; goals_penalty: number;
      last_match_date: Date | string | null;
    }>>`
      SELECT shots_open_play::int, shots_penalty::int,
             xg_open_play::float8, xg_penalty::float8,
             goals_open_play::int, goals_penalty::int,
             last_match_date
        FROM player_shot_aggregates WHERE player_id = ${p.id}
    `;
    if (shotRows[0]) {
      const s = shotRows[0];
      shots = {
        openPlayShots: Number(s.shots_open_play),
        openPlayXg:    Number(s.xg_open_play),
        openPlayGoals: Number(s.goals_open_play),
        penaltyShots:  Number(s.shots_penalty),
        penaltyXg:     Number(s.xg_penalty),
        penaltyGoals:  Number(s.goals_penalty),
        lastMatchDate: s.last_match_date
          ? (s.last_match_date instanceof Date ? s.last_match_date.toISOString() : String(s.last_match_date))
          : null
      };
    }
  } catch {/* table may not exist yet */}

  let hierarchical = null;
  try {
    const hierRows = await sql<Array<{
      xg90: number; xa90: number; bonus90: number; own_weight: number;
    }>>`
      SELECT xg90::float8, xa90::float8, bonus90::float8, own_weight::float8
        FROM player_hierarchical_estimates WHERE player_id = ${p.id}
    `;
    if (hierRows[0]) {
      hierarchical = {
        xg90:      Number(hierRows[0].xg90),
        xa90:      Number(hierRows[0].xa90),
        bonus90:   Number(hierRows[0].bonus90),
        ownWeight: Number(hierRows[0].own_weight)
      };
    }
  } catch {/* table may not exist yet */}

  const minsRows = await sql<Array<{
    start_prob: number; sixty_plus_prob: number; expected_minutes: number;
    rotation_risk: number; reasons: any;
  }>>`
    SELECT start_prob::float8, sixty_plus_prob::float8,
           expected_minutes::float8, rotation_risk::float8, reasons
      FROM minutes_projections
     WHERE player_id = ${p.id}
       AND fixture_id IN (SELECT id FROM fixtures WHERE gameweek_id = ${gwId})
  `;
  const projRows = await sql<Array<{
    xpts_total: number; xpts_appearance: number; xpts_goals: number;
    xpts_assists: number; xpts_clean_sheet: number; xpts_bonus: number; xpts_defcon: number;
    floor: number; ceiling: number; reasons: any;
  }>>`
    SELECT xpts_total::float8, xpts_appearance::float8, xpts_goals::float8,
           xpts_assists::float8, xpts_clean_sheet::float8, xpts_bonus::float8,
           xpts_defcon::float8, floor::float8, ceiling::float8, reasons
      FROM projections
     WHERE player_id = ${p.id} AND gameweek_id = ${gwId}
  `;

  return {
    player: {
      id: p.id, webName: p.web_name, firstName: p.first_name, secondName: p.second_name,
      position: p.position, teamId: p.team_id,
      teamShort: p.team_short, teamName: p.team_name,
      status: p.status, chanceOfPlayingNext: p.chance_of_playing_next_round,
      nowCost: Number(p.now_cost), sellingPrice: null,
      seasonMinutes: Number(p.season_minutes), seasonStarts: Number(p.season_starts),
      seasonXg: Number(p.season_xg), seasonXa: Number(p.season_xa),
      seasonBonus: Number(p.season_bonus),
      seasonDefconPer90: Number(p.season_defcon_per_90)
    },
    team: {
      attack: t.attacking_style, defence: t.defensive_solidity,
      motivation: t.motivation_score == null ? null : Number(t.motivation_score)
    },
    fixtures,
    shots,
    hierarchical,
    minutes: minsRows.map(m => ({
      startProb: Number(m.start_prob),
      sixtyPlusProb: Number(m.sixty_plus_prob),
      expectedMinutes: Number(m.expected_minutes),
      rotationRisk: Number(m.rotation_risk),
      reasons: m.reasons
    })),
    projection: projRows.map(pr => ({
      xptsTotal: Number(pr.xpts_total),
      xptsAppearance: Number(pr.xpts_appearance),
      xptsGoals: Number(pr.xpts_goals),
      xptsAssists: Number(pr.xpts_assists),
      xptsCleanSheet: Number(pr.xpts_clean_sheet),
      xptsBonus: Number(pr.xpts_bonus),
      xptsDefcon: Number(pr.xpts_defcon),
      floor: Number(pr.floor), ceiling: Number(pr.ceiling),
      reasons: pr.reasons
    }))
  };
}

/* ─── render ────────────────────────────────────────────────────────────── */

function AuditView({ audit, gwName }: { audit: AuditData; gwName: string }) {
  const a = audit;
  const p = a.player;
  const mph = p.seasonStarts > 0 ? p.seasonMinutes / p.seasonStarts : 0;
  const totalShotXg = (a.shots?.openPlayXg ?? 0) + (a.shots?.penaltyXg ?? 0);
  return (
    <div className="space-y-4">
      <Card
        title={`${p.webName} (${p.firstName} ${p.secondName})`}
        subtitle={`${p.position} · ${p.teamShort} · £${(p.nowCost/10).toFixed(1)}m · status="${p.status}" · COP=${p.chanceOfPlayingNext ?? 'n/a'}`}
        action={a.projection[0] && (
          <Badge tone={a.projection[0].xptsTotal >= 4 ? 'green' : a.projection[0].xptsTotal >= 2 ? 'amber' : 'red'}>
            {a.projection[0].xptsTotal.toFixed(2)} xPts ({gwName})
          </Badge>
        )}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
          <Stat label="Season mins" value={`${p.seasonMinutes}`} />
          <Stat label="Season starts" value={`${p.seasonStarts}`} />
          <Stat label="Mins / start" value={mph.toFixed(1)} tone={mph >= 80 ? 'green' : mph >= 60 ? 'amber' : 'red'} />
          <Stat label="Season xG" value={p.seasonXg.toFixed(2)} />
          <Stat label="Season xA" value={p.seasonXa.toFixed(2)} />
          <Stat label="Season bonus" value={`${p.seasonBonus}`} />
          <Stat label="DEFCON / 90" value={p.seasonDefconPer90.toFixed(1)} />
        </div>
      </Card>

      <Card
        title="Team ratings (after Bayesian recompute)"
        subtitle={`${a.team.motivation != null ? `Motivation ${(a.team.motivation*100).toFixed(0)}%` : 'Motivation: n/a'}`}
      >
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs font-mono">
          <Stat label={`${p.teamShort} attack`} value={a.team.attack.toFixed(3)}
                tone={a.team.attack >= 1.2 ? 'green' : a.team.attack >= 0.85 ? 'amber' : 'red'} />
          <Stat label={`${p.teamShort} defence`} value={a.team.defence.toFixed(3)}
                tone={a.team.defence <= 0.85 ? 'green' : a.team.defence <= 1.15 ? 'amber' : 'red'} />
          {a.fixtures.map((f, i) => (
            <Stat key={i}
              label={`${f.isHome ? 'vs' : '@'} ${f.opponentShort}`}
              value={`atk ${f.opponentAttack.toFixed(2)} / def ${f.opponentDefence.toFixed(2)}`}
            />
          ))}
        </div>
      </Card>

      <Card
        title="Understat per-shot data"
        subtitle={a.shots ? `Last match ${a.shots.lastMatchDate?.slice(0, 10) ?? '—'}` : ''}
        action={a.shots
          ? <Badge tone="green">RESOLVED</Badge>
          : <Badge tone="red">NOT RESOLVED</Badge>}
      >
        {a.shots ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs font-mono">
            <Stat label="Open-play shots" value={`${a.shots.openPlayShots}`} />
            <Stat label="Open-play xG"    value={a.shots.openPlayXg.toFixed(2)} tone="green" />
            <Stat label="Open-play goals" value={`${a.shots.openPlayGoals}`} />
            <Stat label="Penalty shots"   value={`${a.shots.penaltyShots}`} />
            <Stat label="Penalty xG"      value={a.shots.penaltyXg.toFixed(2)} />
            <Stat label="Penalty goals"   value={`${a.shots.penaltyGoals}`} />
            <Stat label="Total xG (shots)" value={totalShotXg.toFixed(2)} />
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            ⚠️ Not in <code className="text-xs">player_shot_aggregates</code>.
            Name-match failed during understat ingest — engine falls back to
            season totals heuristic which over-credits pen takers.
          </p>
        )}
      </Card>

      <Card title="Hierarchical per-90 estimates">
        {a.hierarchical ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
            <Stat label="xG / 90"      value={a.hierarchical.xg90.toFixed(2)} />
            <Stat label="xA / 90"      value={a.hierarchical.xa90.toFixed(2)} />
            <Stat label="Bonus / 90"   value={a.hierarchical.bonus90.toFixed(2)} />
            <Stat label="Own weight"   value={`${(a.hierarchical.ownWeight*100).toFixed(0)}%`}
                  tone={a.hierarchical.ownWeight >= 0.7 ? 'green' : 'amber'} />
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Not computed yet. Run <code className="text-xs">recompute:all</code>.</p>
        )}
      </Card>

      <Card title={`Minutes projection · ${gwName}`}>
        {a.minutes.length === 0 ? (
          <p className="text-sm text-ink-muted">No minutes row yet. Run <code className="text-xs">recompute:all</code>.</p>
        ) : a.minutes.map((m, i) => (
          <div key={i} className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
            <Stat label="Start prob"      value={`${(m.startProb*100).toFixed(0)}%`}
                  tone={m.startProb >= 0.85 ? 'green' : m.startProb >= 0.5 ? 'amber' : 'red'} />
            <Stat label="60+ prob"        value={`${(m.sixtyPlusProb*100).toFixed(0)}%`} />
            <Stat label="Expected mins"   value={m.expectedMinutes.toFixed(1)}
                  tone={m.expectedMinutes >= 80 ? 'green' : m.expectedMinutes >= 60 ? 'amber' : 'red'} />
            <Stat label="Rotation risk"   value={`${(m.rotationRisk*100).toFixed(0)}%`}
                  tone={m.rotationRisk <= 0.2 ? 'green' : m.rotationRisk <= 0.5 ? 'amber' : 'red'} />
            {Array.isArray(m.reasons) && m.reasons.length > 0 && (
              <div className="md:col-span-4 mt-2 text-[11px] text-ink-muted">
                <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">Reasons</div>
                <ul className="space-y-0.5">
                  {m.reasons.slice(0, 10).map((r: any, j: number) => (
                    <li key={j} className="font-mono">
                      <span className="text-ink-dim">{r.kind}</span> — {r.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card title={`Projection breakdown · ${gwName}`}>
        {a.projection.length === 0 ? (
          <p className="text-sm text-ink-muted">No projection row for this GW.</p>
        ) : a.projection.map((pr, i) => (
          <div key={i} className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono">
              <Stat label="xPts total"   value={pr.xptsTotal.toFixed(2)} tone="green" />
              <Stat label="Apps pts"     value={pr.xptsAppearance.toFixed(2)} />
              <Stat label="Goal pts"     value={pr.xptsGoals.toFixed(2)} />
              <Stat label="Assist pts"   value={pr.xptsAssists.toFixed(2)} />
              <Stat label="Clean-sheet"  value={pr.xptsCleanSheet.toFixed(2)} />
              <Stat label="Bonus pts"    value={pr.xptsBonus.toFixed(2)} />
              <Stat label="DEFCON pts"   value={pr.xptsDefcon.toFixed(2)} />
              <Stat label="Floor / Ceil" value={`${pr.floor.toFixed(1)} / ${pr.ceiling.toFixed(1)}`} />
            </div>
            {Array.isArray(pr.reasons) && pr.reasons.length > 0 && (
              <div className="text-[11px] text-ink-muted">
                <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">Engine reasons</div>
                <ul className="space-y-0.5">
                  {pr.reasons.slice(0, 15).map((r: any, j: number) => (
                    <li key={j} className="font-mono">
                      <span className="text-ink-dim">{r.kind}</span> — {r.detail ?? JSON.stringify(r)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green'|'amber'|'red' }) {
  const colour = tone === 'green' ? 'text-accent-green'
    : tone === 'amber' ? 'text-accent-amber'
    : tone === 'red'   ? 'text-accent-red'
    : 'text-ink';
  return (
    <div className="bg-bg-inset rounded-md py-2 px-3">
      <div className={`text-base font-semibold ${colour}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-ink-dim">{label}</div>
    </div>
  );
}
