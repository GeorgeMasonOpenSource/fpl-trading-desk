import { Card } from '@/components/ui/Card';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { sql } from '@/lib/db/client';
import { currentGameweek } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PlayerExplorer() {
  const gw = await currentGameweek();
  if (!gw) return <p>Run ingestion first.</p>;
  const rows = await sql<Array<any>>`
    SELECT p.id AS player_id, p.web_name, p.position, t.short_name AS team_short,
           p.now_cost,
           SUM(pr.xpts_total) AS xpts,
           SUM(pr.floor) AS floor,
           SUM(pr.ceiling) AS ceiling,
           MAX(mp.start_prob) AS start_prob,
           MAX(mp.expected_minutes) AS expected_minutes,
           MAX(mp.rotation_risk) AS rotation_risk,
           MAX(mp.reliability_index) AS reliability_index,
           MAX(pr.risk_score) AS risk_score,
           MAX(pr.confidence_score) AS confidence_score
    FROM projections pr
    JOIN players p ON p.id = pr.player_id
    JOIN teams t ON t.id = p.team_id
    LEFT JOIN minutes_projections mp ON mp.player_id = p.id AND mp.fixture_id = pr.fixture_id
    WHERE pr.gameweek_id = ${gw.id}
    GROUP BY p.id, p.web_name, p.position, t.short_name, p.now_cost
    ORDER BY xpts DESC NULLS LAST
    LIMIT 200
  `;
  return (
    <div className="space-y-4">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Player explorer</div>
        <h1 className="text-2xl font-semibold">{gw.name} · top 200 by xPts</h1>
      </header>
      <Card>
        <Table>
          <THead>
            <TH>Player</TH><TH>Pos</TH><TH>Team</TH>
            <TH className="text-right">£</TH>
            <TH className="text-right">xPts</TH>
            <TH className="text-right">Floor</TH><TH className="text-right">Ceiling</TH>
            <TH className="text-right">Start</TH>
            <TH className="text-right">xMins</TH>
            <TH className="text-right">Rot risk</TH>
            <TH className="text-right">Reliability</TH>
            <TH className="text-right">Risk</TH>
            <TH className="text-right">Confidence</TH>
          </THead>
          <tbody>
            {rows.map(r => (
              <TR key={r.player_id}>
                <TD className="font-semibold">{r.web_name}</TD>
                <TD>{r.position}</TD>
                <TD>{r.team_short}</TD>
                <TD className="text-right font-mono">£{(r.now_cost/10).toFixed(1)}</TD>
                <TD className="text-right font-mono"><Badge tone={Number(r.xpts) > 5 ? 'green' : 'steel'}>{Number(r.xpts ?? 0).toFixed(2)}</Badge></TD>
                <TD className="text-right font-mono">{Number(r.floor ?? 0).toFixed(2)}</TD>
                <TD className="text-right font-mono">{Number(r.ceiling ?? 0).toFixed(2)}</TD>
                <TD className="text-right font-mono">{(Number(r.start_prob ?? 0)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{Number(r.expected_minutes ?? 0).toFixed(0)}</TD>
                <TD className="text-right font-mono">{(Number(r.rotation_risk ?? 0)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.reliability_index ?? 0)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.risk_score ?? 0)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.confidence_score ?? 0)*100).toFixed(0)}%</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
