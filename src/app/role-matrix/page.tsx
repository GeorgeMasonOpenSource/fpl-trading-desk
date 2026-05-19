import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { sql } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RoleMatrixPage() {
  const teams = await sql<Array<{ id: number; short_name: string }>>`
    SELECT id, short_name FROM teams ORDER BY short_name
  `;
  const rolesByTeam = new Map<number, Array<any>>();
  for (const t of teams) {
    const rs = await sql<Array<any>>`
      SELECT p.web_name, p.position, prm.role, prm.role_type, prm.suitability,
             prm.confidence, prm.evidence_level, prm.last_verified_at, prm.expires_at, prm.source
      FROM player_role_matrix prm
      JOIN players p ON p.id = prm.player_id
      WHERE p.team_id = ${t.id}
      ORDER BY prm.suitability DESC NULLS LAST
      LIMIT 30
    `;
    rolesByTeam.set(t.id, rs);
  }
  return (
    <div className="space-y-4">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Role matrix</div>
        <h1 className="text-2xl font-semibold">Roles inferred from this season's evidence</h1>
        <p className="text-sm text-ink-muted mt-1">
          Roles are derived from current-season lineups and minutes. Confidence decays
          if not verified within 4 weeks.
        </p>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {teams.map(t => (
          <Card key={t.id} title={t.short_name}>
            <table className="min-w-full text-sm font-tabular">
              <thead className="text-[10px] uppercase tracking-widest text-ink-dim">
                <tr><th className="text-left">Player</th><th className="text-left">Role</th><th className="text-right">Suit</th><th className="text-right">Conf</th><th>Source</th></tr>
              </thead>
              <tbody>
                {rolesByTeam.get(t.id)?.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-line">
                    <td className="py-1">{r.web_name}</td>
                    <td className="py-1"><Badge tone="violet">{r.role}</Badge> <span className="text-[10px] text-ink-dim">{r.role_type}</span></td>
                    <td className="py-1 text-right font-mono">{Number(r.suitability).toFixed(2)}</td>
                    <td className="py-1 text-right font-mono">{Number(r.confidence).toFixed(2)}</td>
                    <td className="py-1 text-[11px] text-ink-muted">{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
    </div>
  );
}
