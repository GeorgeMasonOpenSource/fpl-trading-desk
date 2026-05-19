import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PlayerCard, PlayerCardData } from '@/components/PlayerCard';
import { NotConnected } from '@/components/NotConnected';
import { currentGameweek, squadForGameweek, managerSummary } from '@/lib/db/queries';
import { getManagerId } from '@/lib/session';
import { n, fmt } from '@/lib/util/fmt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function MyTeam() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="My Team" />;
  const gw = await currentGameweek();
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;
  const squad = await squadForGameweek(managerId, gw.id);
  const summary = await managerSummary(managerId);
  const starters = squad.filter(p => p.position <= 11);
  const bench    = squad.filter(p => p.position >  11);
  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">My team</div>
        <h1 className="text-2xl font-semibold">{summary?.name ?? `Manager ${managerId}`}</h1>
        <div className="flex gap-2 mt-2 text-xs">
          <Badge tone="blue">£{fmt(n(summary?.team_value) / 10, 1)}m team value</Badge>
          <Badge tone="steel">£{fmt(n(summary?.bank) / 10, 1)}m bank</Badge>
          <Badge tone="violet">FT {n(summary?.free_transfers, 1)}</Badge>
        </div>
      </header>
      <Card title="Starting XI">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {starters.map(p => <PlayerCard key={p.player_id} p={toCard(p)} />)}
        </div>
      </Card>
      <Card title="Bench">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {bench.map(p => <PlayerCard key={p.player_id} p={toCard(p)} />)}
        </div>
      </Card>
    </div>
  );
}

function toCard(p: any): PlayerCardData {
  return {
    player_id: p.player_id, web_name: p.web_name, position: p.pos,
    team_short: p.team_short, xpts_total: Number(p.xpts_total),
    start_prob: Number(p.start_prob), sixty_plus_prob: Number(p.sixty_plus_prob),
    ninety_prob: Number(p.ninety_prob), sub_prob: Number(p.sub_prob),
    bench_unused_prob: Number(p.bench_unused_prob),
    injury_absence_prob: Number(p.injury_absence_prob),
    expected_minutes: Number(p.expected_minutes), rotation_risk: Number(p.rotation_risk),
    rotation_resistance: Number(p.rotation_resistance), reliability_index: Number(p.reliability_index),
    minutes_confidence: Number(p.minutes_confidence), confidence_score: Number(p.confidence_score),
    floor: Number(p.floor), ceiling: Number(p.ceiling), risk_score: Number(p.risk_score),
    reasons: p.reasons_json ? JSON.parse(p.reasons_json as string) : null
  };
}
