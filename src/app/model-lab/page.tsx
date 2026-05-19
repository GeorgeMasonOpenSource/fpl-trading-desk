import { Card } from '@/components/ui/Card';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { sql } from '@/lib/db/client';
import { classifyStage, weightsForStage } from '@/lib/util/season-stage';
import { currentGameweek } from '@/lib/db/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ModelLab() {
  const gw = await currentGameweek();
  const stage = gw ? classifyStage(gw.id) : 'mid';
  const w = weightsForStage(stage as any);
  const teamStrengths = await sql<any[]>`
    SELECT t.short_name, ts.attack_rating, ts.defence_rating, ts.home_advantage, ts.computed_at
    FROM team_strengths ts JOIN teams t ON t.id = ts.team_id
    ORDER BY ts.attack_rating DESC
  `;
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Model lab</div>
        <h1 className="text-2xl font-semibold">Inspect the model</h1>
      </header>
      <Card title="Season-stage weights" subtitle={`current stage: ${stage}`}>
        <Table>
          <THead><TH>Weight</TH><TH className="text-right">Value</TH></THead>
          <tbody>
            <TR><TD>currentSeasonWeight</TD><TD className="text-right font-mono">{w.currentSeasonWeight.toFixed(2)}</TD></TR>
            <TR><TD>baselineWeight</TD><TD className="text-right font-mono">{w.baselineWeight.toFixed(2)}</TD></TR>
            <TR><TD>newSigningUncertainty</TD><TD className="text-right font-mono">{w.newSigningUncertainty.toFixed(2)}</TD></TR>
            <TR><TD>managerChangeUncertainty</TD><TD className="text-right font-mono">{w.managerChangeUncertainty.toFixed(2)}</TD></TR>
            <TR><TD>teamObjectiveWeight</TD><TD className="text-right font-mono">{w.teamObjectiveWeight.toFixed(2)}</TD></TR>
            <TR><TD>fixtureWeight</TD><TD className="text-right font-mono">{w.fixtureWeight.toFixed(2)}</TD></TR>
          </tbody>
        </Table>
      </Card>
      <Card title="Team strengths (multiplicative)">
        <Table>
          <THead><TH>Team</TH><TH className="text-right">Attack</TH><TH className="text-right">Defence</TH><TH className="text-right">Home adv</TH><TH>Computed</TH></THead>
          <tbody>
            {teamStrengths.map((r: any) => (
              <TR key={r.short_name}>
                <TD>{r.short_name}</TD>
                <TD className="text-right font-mono">{Number(r.attack_rating).toFixed(3)}</TD>
                <TD className="text-right font-mono">{Number(r.defence_rating).toFixed(3)}</TD>
                <TD className="text-right font-mono">{Number(r.home_advantage).toFixed(2)}</TD>
                <TD className="text-xs text-ink-muted">{new Date(r.computed_at).toISOString().slice(0,16)}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
