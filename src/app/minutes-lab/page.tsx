import { Card } from '@/components/ui/Card';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { ProbabilityBar } from '@/components/ui/Badge';
import { sql } from '@/lib/db/client';
import { currentGameweek } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function MinutesLab() {
  const gw = await currentGameweek();
  if (!gw) return <p>Run ingestion first.</p>;
  const rows = await sql<Array<any>>`
    SELECT p.web_name, p.position, t.short_name AS team_short,
           mp.start_prob, mp.sixty_plus_prob, mp.ninety_prob,
           mp.sub_prob, mp.bench_unused_prob, mp.injury_absence_prob,
           mp.rotation_risk, mp.rotation_resistance, mp.reliability_index,
           mp.minutes_confidence
    FROM minutes_projections mp
    JOIN players p ON p.id = mp.player_id
    JOIN teams t ON t.id = p.team_id
    JOIN fixtures f ON f.id = mp.fixture_id AND f.gameweek_id = ${gw.id}
    ORDER BY mp.start_prob DESC, mp.ninety_prob DESC
    LIMIT 200
  `;
  return (
    <div className="space-y-4">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Minutes lab</div>
        <h1 className="text-2xl font-semibold">Minutes distribution · {gw.name}</h1>
      </header>
      <Card>
        <Table>
          <THead>
            <TH>Player</TH><TH>Team</TH><TH>Pos</TH>
            <TH>Start</TH><TH>60+</TH><TH>90</TH>
            <TH>Sub</TH><TH>Bench</TH><TH>Out</TH>
            <TH className="text-right">Rot risk</TH>
            <TH className="text-right">Resistance</TH>
            <TH className="text-right">Reliability</TH>
            <TH className="text-right">Min conf</TH>
          </THead>
          <tbody>
            {rows.map(r => (
              <TR key={r.web_name}>
                <TD className="font-semibold">{r.web_name}</TD>
                <TD>{r.team_short}</TD>
                <TD>{r.position}</TD>
                <TD><ProbabilityBar value={Number(r.start_prob)} tone="green" /></TD>
                <TD><ProbabilityBar value={Number(r.sixty_plus_prob)} tone="green" /></TD>
                <TD><ProbabilityBar value={Number(r.ninety_prob)} tone="blue" /></TD>
                <TD><ProbabilityBar value={Number(r.sub_prob)} tone="amber" /></TD>
                <TD><ProbabilityBar value={Number(r.bench_unused_prob)} tone="amber" /></TD>
                <TD><ProbabilityBar value={Number(r.injury_absence_prob)} tone="red" /></TD>
                <TD className="text-right font-mono">{(Number(r.rotation_risk)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.rotation_resistance)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.reliability_index)*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(Number(r.minutes_confidence)*100).toFixed(0)}%</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
