import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { sql } from '@/lib/db/client';
import { currentGameweek } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RotationRadar() {
  const gw = await currentGameweek();
  if (!gw) return <p>Run ingestion first.</p>;

  const ghostPoints = await sql<any[]>`
    SELECT p.web_name, t.short_name AS team_short, p.position,
           SUM(pr.xpts_total) AS xpts, AVG(mp.start_prob) AS start_prob,
           AVG(mp.rotation_risk) AS rotation_risk
    FROM projections pr
    JOIN players p ON p.id = pr.player_id
    JOIN teams t   ON t.id = p.team_id
    LEFT JOIN minutes_projections mp ON mp.player_id = pr.player_id
      AND mp.fixture_id = pr.fixture_id
    WHERE pr.gameweek_id = ${gw.id} AND pr.xpts_total > 4 AND mp.start_prob < 0.7
    GROUP BY p.web_name, t.short_name, p.position
    ORDER BY xpts DESC LIMIT 25
  `;
  const ironMen = await sql<any[]>`
    SELECT p.web_name, t.short_name AS team_short, p.position,
           AVG(mp.start_prob) AS start_prob, AVG(mp.ninety_prob) AS ninety_prob,
           AVG(mp.reliability_index) AS reliability
    FROM minutes_projections mp
    JOIN players p ON p.id = mp.player_id
    JOIN teams t   ON t.id = p.team_id
    JOIN fixtures f ON f.id = mp.fixture_id AND f.gameweek_id = ${gw.id}
    WHERE mp.reliability_index > 0.85 AND mp.start_prob > 0.9
    GROUP BY p.web_name, t.short_name, p.position
    ORDER BY reliability DESC LIMIT 25
  `;
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Rotation radar</div>
        <h1 className="text-2xl font-semibold">Watchlist · {gw.name}</h1>
      </header>
      <Card title="High xPts, bad minutes security" subtitle="Players the model rates but who might not start">
        <Table>
          <THead><TH>Player</TH><TH>Team</TH><TH>Pos</TH><TH className="text-right">xPts</TH><TH className="text-right">Start prob</TH><TH className="text-right">Rotation risk</TH></THead>
          <tbody>
            {ghostPoints.map((r: any) => (
              <TR key={r.web_name}>
                <TD className="font-semibold">{r.web_name}</TD><TD>{r.team_short}</TD><TD>{r.position}</TD>
                <TD className="text-right font-mono"><Badge tone="amber">{Number(r.xpts).toFixed(2)}</Badge></TD>
                <TD className="text-right font-mono">{(Number(r.start_prob)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.rotation_risk)*100).toFixed(0)}%</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title="Iron men" subtitle="High reliability + near-certain start. Use the data, don't trust names.">
        <Table>
          <THead><TH>Player</TH><TH>Team</TH><TH>Pos</TH><TH className="text-right">Start</TH><TH className="text-right">90 prob</TH><TH className="text-right">Reliability</TH></THead>
          <tbody>
            {ironMen.map((r: any) => (
              <TR key={r.web_name}>
                <TD className="font-semibold">{r.web_name}</TD><TD>{r.team_short}</TD><TD>{r.position}</TD>
                <TD className="text-right font-mono"><Badge tone="green">{(Number(r.start_prob)*100).toFixed(0)}%</Badge></TD>
                <TD className="text-right font-mono">{(Number(r.ninety_prob)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.reliability)*100).toFixed(0)}%</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
