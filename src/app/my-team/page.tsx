import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PlayerCard, PlayerCardData } from '@/components/PlayerCard';
import { NotConnected } from '@/components/NotConnected';
import { SquadRotationWatchlist } from '@/components/SquadRotationWatchlist';
import { currentGameweek, squadForGameweek, managerSummary } from '@/lib/db/queries';
import { getManagerId } from '@/lib/session';
import { getSquadRotationRisk } from '@/lib/risk/squad-risk';
import { explainXi, type XiStarterReason } from '@/lib/pick/xi-narrative';
import { n, fmt } from '@/lib/util/fmt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function MyTeam() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="My Team" />;
  const gw = await currentGameweek();
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;
  const [squad, summary, rotationRisk] = await Promise.all([
    squadForGameweek(managerId, gw.id),
    managerSummary(managerId),
    getSquadRotationRisk(managerId, gw.id)
  ]);

  // Compute the optimal XI from the 15-man squad rather than trusting the
  // user's saved FPL XI. This is the recommendation the model would make,
  // and the basis for the per-card narrative.
  const autoInput = squad.map(p => ({
    player_id: p.player_id,
    web_name: p.web_name,
    pos: p.pos as 'GKP'|'DEF'|'MID'|'FWD',
    team_short: p.team_short,
    xpts_total: Number(p.xpts_total) || 0,
    expected_minutes: Number(p.expected_minutes) || 0,
    raw: p  // carry the full row through so we can render after
  }));
  const narrative = explainXi(autoInput);
  const reasonById = new Map<number, XiStarterReason>(
    narrative.starterReasons.map(r => [r.player_id, r])
  );

  const starters = narrative.pick.starters.map(s => s.player.raw);
  const bench    = narrative.pick.bench.map(b => b.player.raw);
  const f = narrative.formation;
  const ru = narrative.runnerUpFormation;
  const xiOnlyTotal = narrative.pick.totalXpts - narrative.pick.captainXpts / 2;

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

      <Card
        title={`Recommended XI · ${f.def}-${f.mid}-${f.fwd}`}
        subtitle={`${fmt(xiOnlyTotal, 2)} xP starting XI (${fmt(narrative.pick.totalXpts, 2)} including captain ×2). Expand any player to see why they start over the bench alternative.`}
      >
        <div className="space-y-3 text-[12px]">
          {ru ? (
            <div className="bg-bg-inset rounded-md p-3 space-y-1">
              <div className="text-ink">
                <span className="font-medium">Why {f.def}-{f.mid}-{f.fwd} over {ru.formation.def}-{ru.formation.mid}-{ru.formation.fwd}:</span>{' '}
                <span className="text-ink-muted">{ru.swapDescription}.</span>
              </div>
              <div className="text-ink-dim text-[11px]">
                Runner-up formation total: {fmt(ru.totalXpts, 2)} xP · gap: +{fmt(ru.gap, 2)} xP. Every other legal formation scores lower.
              </div>
            </div>
          ) : (
            <div className="text-ink-dim text-[11px]">No alternative formation available — squad position counts force this one.</div>
          )}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-bg-inset rounded-md py-2">
              <div className="font-mono text-base">{f.def}</div>
              <div className="text-[10px] text-ink-dim uppercase tracking-wide">defenders</div>
            </div>
            <div className="bg-bg-inset rounded-md py-2">
              <div className="font-mono text-base">{f.mid}</div>
              <div className="text-[10px] text-ink-dim uppercase tracking-wide">midfielders</div>
            </div>
            <div className="bg-bg-inset rounded-md py-2">
              <div className="font-mono text-base">{f.fwd}</div>
              <div className="text-[10px] text-ink-dim uppercase tracking-wide">forwards</div>
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Rotation watchlist"
        subtitle="End-of-season rotation risk per squad player, with a safer alternative when one exists. Sorted by composite risk."
      >
        <SquadRotationWatchlist rows={rotationRisk} />
      </Card>

      <Card title="Starting XI">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {starters.map(p => (
            <PlayerCard
              key={p.player_id}
              p={toCard(p, reasonById.get(p.player_id) ?? null)}
            />
          ))}
        </div>
      </Card>
      <Card title="Bench" subtitle="Ordered by sub priority — first comes on if a starter doesn't play.">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {bench.map(p => <PlayerCard key={p.player_id} p={toCard(p, null)} />)}
        </div>
      </Card>
    </div>
  );
}

function toCard(p: any, reason: XiStarterReason | null): PlayerCardData {
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
    reasons: p.reasons_json ? JSON.parse(p.reasons_json as string) : null,
    xiNarrative: reason ? {
      isCaptain: reason.isCaptain,
      isVice: reason.isVice,
      nearestBenchAlt: reason.nearestBenchAlternative
        ? { web_name: reason.nearestBenchAlternative.web_name, xpts: reason.nearestBenchAlternative.xpts }
        : null,
      xpGap: reason.xpGap,
      bullets: reason.bullets
    } : null
  };
}
