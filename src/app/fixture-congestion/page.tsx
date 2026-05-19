import { Card } from '@/components/ui/Card';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { sql } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function FixtureCongestionPage() {
  const fixtures = await sql<any[]>`
    SELECT f.id, f.kickoff_time, gw.id AS gw, gw.name AS gw_name,
           th.short_name AS home, ta.short_name AS away,
           f.team_h_difficulty, f.team_a_difficulty
    FROM fixtures f
    JOIN gameweeks gw ON gw.id = f.gameweek_id
    JOIN teams th ON th.id = f.team_h
    JOIN teams ta ON ta.id = f.team_a
    WHERE f.finished = FALSE
    ORDER BY f.kickoff_time
    LIMIT 100
  `;
  const europeanByTeam = await sql<any[]>`
    SELECT t.short_name, e.competition, e.kickoff_time, e.is_home, e.opponent, e.importance
    FROM european_fixtures e
    JOIN teams t ON t.id = e.team_id
    WHERE e.kickoff_time >= now() - interval '1 day'
    ORDER BY e.kickoff_time
    LIMIT 50
  `;
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Fixture congestion</div>
        <h1 className="text-2xl font-semibold">Upcoming schedule pressure</h1>
        <p className="text-sm text-ink-muted mt-1">
          European and cup fixtures can be entered via the manual override API
          (POST /api/overrides with scope=&apos;team&apos;) until a free data source is added.
        </p>
      </header>
      <Card title="Premier League fixtures">
        <Table>
          <THead><TH>GW</TH><TH>Kickoff</TH><TH>Home</TH><TH>Away</TH><TH className="text-right">FDR (H)</TH><TH className="text-right">FDR (A)</TH></THead>
          <tbody>
            {fixtures.map((f: any) => (
              <TR key={f.id}>
                <TD>{f.gw_name}</TD>
                <TD className="font-mono text-xs">{new Date(f.kickoff_time).toISOString().slice(0,16).replace('T',' ')}</TD>
                <TD>{f.home}</TD><TD>{f.away}</TD>
                <TD className="text-right"><Badge tone={fdrTone(f.team_h_difficulty)}>{f.team_h_difficulty}</Badge></TD>
                <TD className="text-right"><Badge tone={fdrTone(f.team_a_difficulty)}>{f.team_a_difficulty}</Badge></TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title="European / cup fixtures (manually entered)">
        <Table>
          <THead><TH>Team</TH><TH>Comp</TH><TH>Kickoff</TH><TH>Opponent</TH><TH className="text-right">Importance</TH></THead>
          <tbody>
            {europeanByTeam.map((e: any, i: number) => (
              <TR key={i}>
                <TD>{e.short_name}</TD>
                <TD><Badge tone="violet">{e.competition}</Badge></TD>
                <TD className="font-mono text-xs">{new Date(e.kickoff_time).toISOString().slice(0,16).replace('T',' ')}</TD>
                <TD>{e.is_home ? 'H ' : 'A '}{e.opponent}</TD>
                <TD className="text-right font-mono">{Number(e.importance).toFixed(1)}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function fdrTone(d: number) {
  return d <= 2 ? 'green' : d === 3 ? 'amber' : 'red';
}
