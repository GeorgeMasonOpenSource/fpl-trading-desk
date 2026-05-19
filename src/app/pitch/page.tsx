import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PitchView } from '@/components/PitchView';
import { NotConnected } from '@/components/NotConnected';
import { getGameweeks, squadForGameweek, managerSummary } from '@/lib/db/queries';
import { getManagerId } from '@/lib/session';
import { autoPick, type AutoPickInput } from '@/lib/pick/autoPick';
import { fmt } from '@/lib/util/fmt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PitchPage() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Pitch view" />;

  const { planning } = await getGameweeks();
  if (!planning) {
    return (
      <Card title="No gameweek data yet">
        <p className="text-sm text-ink-muted">
          Hit <span className="font-mono">Refresh now</span> in the bar above to
          fetch FPL data.
        </p>
      </Card>
    );
  }

  const squad   = await squadForGameweek(managerId, planning.id);
  const summary = await managerSummary(managerId);

  // Map DB rows to the shape autoPick expects.
  const inputs: AutoPickInput[] = squad.map(p => ({
    player_id: p.player_id,
    web_name:  p.web_name,
    pos:       p.pos as 'GKP' | 'DEF' | 'MID' | 'FWD',
    team_short: p.team_short,
    xpts_total: Number(p.xpts_total) || 0,
    expected_minutes: Number(p.expected_minutes) || 0
  }));

  const picked = autoPick(inputs);

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-ink-dim">Pitch view</div>
          <h1 className="text-2xl font-semibold">
            Auto-picked XI · {planning.name}
          </h1>
          <p className="text-sm text-ink-muted mt-1">
            Highest expected points from your 15-man squad. Captain doubled. Formation chosen across all legal splits.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Badge tone="green">{fmt(picked.totalXpts, 1)} xPts total</Badge>
          <Badge tone="blue">
            {picked.formation.def}-{picked.formation.mid}-{picked.formation.fwd}
          </Badge>
          {summary && <Badge tone="steel">FT {Number(summary.free_transfers ?? 0).toFixed(1)}</Badge>}
        </div>
      </header>

      <PitchView picked={picked} planningLabel={planning.name} />

      <Card title="How this XI was picked" subtitle="Deterministic — no opinion baked in">
        <ul className="text-sm text-ink-muted space-y-1">
          <li>· Enumerate every legal Premier League formation (8 splits in total).</li>
          <li>· For each split, take the highest-xPts players in each position.</li>
          <li>· Keep the split whose 11 players add up to the most expected points.</li>
          <li>· Captain = top xPts starter, vice = second.</li>
          <li>· Bench ordered so the most-likely auto-sub comes on first.</li>
        </ul>
      </Card>
    </div>
  );
}
