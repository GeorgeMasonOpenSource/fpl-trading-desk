/**
 * GW Decision page — mobile-first, single-purpose.
 *
 * Replaces the wall-of-cards dashboard with one screen that answers:
 *   "What should I do this gameweek?"
 *
 * Stacked, narrow, no horizontal scroll. Each card answers ONE question:
 *   1. Make this transfer (LP-optimal or top-1 greedy)
 *   2. Captain this player (risk-adjusted recommended)
 *   3. Bank or play chip (chip recommendation if any are available)
 *   4. Squad-news watch (only if there's actually urgent news)
 *   5. Mini-league context (only if EO data exists)
 *
 * Everything else is one tap away on the existing /transfer-planner,
 * /captaincy, etc. pages — but the user doesn't need them for the basic
 * gameweek decision.
 */
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { getGameweeks, managerSummary, newsWatch, squadForGameweek } from '@/lib/db/queries';
import { compareTransferScenarios, rankTopTransfers } from '@/lib/transfers/optimiser';
import { rankCaptains } from '@/lib/captaincy/engine';
import { getManagerId, getLeagueId, getUsedChips } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { sql } from '@/lib/db/client';
import { loadCalibrationContext, calibrateOne } from '@/lib/projections/calibration';
import Link from 'next/link';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 60;

export default async function GwDecisionPage() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="GW Decision" />;
  const leagueId = getLeagueId() ?? undefined;
  const { planning } = await getGameweeks();
  if (!planning) {
    return <p className="text-ink-muted">No upcoming gameweek. Run db:seed.</p>;
  }

  // Pull data in parallel for snappy load.
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  const [summary, scenarios, topTransfers, captains, squad, news, calCtx, urgentNewsCount] = await Promise.all([
    safe(() => managerSummary(managerId), null),
    safe(() => compareTransferScenarios({
      managerId, startGameweek: planning.id,
      freeTransfers: 1, evThreshold: 0.6, hitThreshold: 1.5
    }), [] as any),
    safe(() => rankTopTransfers(managerId, planning.id, 3), []),
    safe(() => rankCaptains(managerId, planning.id, leagueId), null),
    safe(() => squadForGameweek(managerId, planning.id), [] as any),
    safe(() => newsWatch(managerId, planning.id), [] as any),
    safe(() => loadCalibrationContext(planning.id), {
      calibrationByPosition: new Map(),
      benchmarksByPlayer: new Map(),
      consensusByPlayer: new Map()
    }),
    safe(() => sql<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c
        FROM player_news_log pnl
        JOIN manager_picks mp ON mp.player_id = pnl.player_id
       WHERE mp.manager_id = ${managerId}
         AND mp.gameweek_id = ${planning.id}
         AND pnl.created_at > now() - interval '48 hours'
    `, [{ c: 0 }] as any)
  ]);

  // Filter chip scenarios by used chips.
  const usedChips = getUsedChips();
  const scenarioBlockedByChip: Record<string, string> = {
    wildcard:       'WC', free_hit:       'FH',
    bench_boost:    'BB', triple_captain: 'TC'
  };
  const availableScenarios = scenarios.filter((s: any) => {
    const chipCode = scenarioBlockedByChip[s.scenario];
    if (!chipCode) return true;
    return !usedChips.has(chipCode as any);
  });
  const recommendedScenario = availableScenarios
    .slice().sort((a: any, b: any) => b.ev - a.ev)[0] ?? null;

  // The headline transfer: prefer LP/top-1 greedy ranker.
  const headline = topTransfers[0] ?? null;
  // Apply calibration to headline xPts.
  const calibrateHeadline = (p: { playerId: number; position: string; xpts1: number }) => {
    return calibrateOne({
      rawXpts: p.xpts1,
      playerId: p.playerId,
      position: p.position as 'GKP'|'DEF'|'MID'|'FWD',
      calibrationByPosition: calCtx.calibrationByPosition,
      benchmarkForPlayer: calCtx.benchmarksByPlayer.get(p.playerId),
      consensusForPlayer: calCtx.consensusByPlayer.get(p.playerId)
    });
  };

  // Captain: recommended from the risk-adjusted ranker.
  const captainPick = captains?.recommended ?? captains?.aggressive ?? null;
  const safeCaptain = captains?.safe ?? null;

  return (
    <div className="space-y-4 max-w-md mx-auto">
      {/* Header — minimal */}
      <header className="pt-2">
        <div className="text-[11px] uppercase tracking-widest text-ink-dim">{planning.name}</div>
        <h1 className="text-xl font-semibold mt-0.5">Your move</h1>
        {summary?.free_transfers != null && (
          <div className="mt-1 flex gap-2 text-[11px] text-ink-muted">
            <span>{summary.free_transfers} FT</span>
            <span>·</span>
            <span>£{(Number(summary.bank ?? 0) / 10).toFixed(1)}m bank</span>
            {urgentNewsCount?.[0]?.c > 0 && (
              <>
                <span>·</span>
                <Link href="/my-team" className="text-accent-amber">
                  ⚠ {urgentNewsCount[0].c} news
                </Link>
              </>
            )}
          </div>
        )}
      </header>

      {/* HEADLINE: Recommended transfer */}
      {headline ? (
        <Card title="" subtitle="">
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">
            Recommended transfer
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <div className="text-xs text-ink-muted line-through">
                {headline.out.webName} <span className="font-mono text-[10px]">{headline.out.xpts1.toFixed(1)}</span>
              </div>
              <div className="text-xl font-semibold mt-0.5 flex items-center gap-2">
                {headline.in.webName}
                <span className="font-mono text-sm text-accent-green">
                  {calibrateHeadline(headline.in).calibrated.toFixed(1)}
                </span>
              </div>
              <div className="text-[10px] text-ink-dim font-mono mt-0.5">
                {headline.in.position} · {headline.in.teamShort} · £{(headline.in.cost / 10).toFixed(1)}m
              </div>
            </div>
            <Badge tone={headline.evGain1 > 1.5 ? 'green' : headline.evGain1 > 0.5 ? 'amber' : 'steel'}>
              +{headline.evGain1.toFixed(1)} EV
            </Badge>
          </div>
          {/* Why it's the move — collapsible, hidden by default on mobile */}
          <details className="mt-3 group">
            <summary className="text-[11px] text-ink-dim cursor-pointer list-none flex items-center">
              <span className="group-open:rotate-90 transition-transform inline-block w-3">›</span>
              <span className="ml-1">Why this transfer</span>
            </summary>
            <div className="mt-2 text-[11px] text-ink-muted space-y-1.5 pl-4">
              <div>
                <span className="text-accent-green">+ {headline.in.webName}</span> projects{' '}
                <span className="font-mono">{headline.in.xpts1.toFixed(1)}</span> xPts ({headline.in.position}, {headline.in.teamShort})
              </div>
              <div>
                <span className="text-accent-red">− {headline.out.webName}</span> projects{' '}
                <span className="font-mono">{headline.out.xpts1.toFixed(1)}</span> xPts
              </div>
              <div className="text-ink-dim">
                Net £{headline.netCost === 0 ? '0' : `${headline.netCost > 0 ? '-' : '+'}${(Math.abs(headline.netCost) / 10).toFixed(1)}m`} ·
                Δ 3 GW {headline.evGain3.toFixed(1)} ·
                {headline.changesCaptain ? ' new captain' : ' same captain'}
              </div>
              {(() => {
                const cs = calCtx.consensusByPlayer.get(headline.in.playerId);
                if (!cs || cs.distinctCreators === 0) return null;
                return <div className="text-accent-violet">📺 {cs.reason}</div>;
              })()}
              <Link href="/transfer-planner" className="block mt-2 text-accent-green underline">
                see top 10 →
              </Link>
            </div>
          </details>
        </Card>
      ) : (
        <Card title="No move recommended">
          <p className="text-sm text-ink-muted">
            No transfer clears the EV threshold. Roll your FT.
          </p>
        </Card>
      )}

      {/* CAPTAIN */}
      {captainPick && (
        <Card>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">
            Captain
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <div className="text-xl font-semibold flex items-center gap-2">
                {captainPick.webName}
                <Badge tone="violet">C</Badge>
              </div>
              <div className="text-[10px] text-ink-dim font-mono mt-0.5">
                {captainPick.position} · {captainPick.teamShort}
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-lg text-accent-green">
                {captainPick.projection.toFixed(1)}
              </div>
              <div className="text-[9px] text-ink-dim uppercase tracking-widest">×2 xPts</div>
            </div>
          </div>
          <details className="mt-3 group">
            <summary className="text-[11px] text-ink-dim cursor-pointer list-none flex items-center">
              <span className="group-open:rotate-90 transition-transform inline-block w-3">›</span>
              <span className="ml-1">Alternatives + risk</span>
            </summary>
            <div className="mt-2 text-[11px] text-ink-muted space-y-1.5 pl-4">
              <div>
                Floor <span className="font-mono">{captainPick.floor.toFixed(1)}</span> ·
                Ceiling <span className="font-mono">{captainPick.ceiling.toFixed(1)}</span> ·
                Start <span className="font-mono">{(captainPick.startProb * 100).toFixed(0)}%</span>
              </div>
              {safeCaptain && safeCaptain.playerId !== captainPick.playerId && (
                <div>
                  Safer: <span className="text-ink">{safeCaptain.webName}</span>{' '}
                  <span className="font-mono">{safeCaptain.projection.toFixed(1)}</span>
                </div>
              )}
              {captainPick.reasons?.length > 0 && (
                <ul className="space-y-0.5 mt-1">
                  {captainPick.reasons.slice(0, 3).map((r: string, i: number) => (
                    <li key={i} className="text-ink-dim">· {r}</li>
                  ))}
                </ul>
              )}
              <Link href="/captaincy" className="block mt-2 text-accent-green underline">
                full ranking →
              </Link>
            </div>
          </details>
        </Card>
      )}

      {/* CHIPS — only if any are still available and any scenario has EV > 1 */}
      {(() => {
        const availableChips = (['WC','FH','BB','TC'] as const).filter(c => !usedChips.has(c));
        if (availableChips.length === 0) return null;
        const chipScenario = availableScenarios.find((s: any) => Object.values(scenarioBlockedByChip).includes(scenarioBlockedByChip[s.scenario]));
        if (!chipScenario || chipScenario.ev < 1.0) {
          return (
            <Card>
              <div className="text-[10px] uppercase tracking-widest text-ink-dim">
                Chips available
              </div>
              <div className="mt-1 text-sm">
                {availableChips.join(' · ')}
                <span className="ml-2 text-ink-dim text-xs">— no chip clears 1 EV threshold this week</span>
              </div>
            </Card>
          );
        }
        return null;
      })()}

      {/* SQUAD NEWS — only urgent items, only show count + link */}
      {Array.isArray(news) && news.length > 0 && (
        <Card>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">
            ⚠ {news.length} squad alert{news.length === 1 ? '' : 's'}
          </div>
          <ul className="space-y-1.5 text-sm">
            {news.slice(0, 3).map((n: any, i: number) => (
              <li key={i} className="flex items-center justify-between">
                <span>{n.web_name ?? n.webName} <span className="text-[10px] text-ink-dim">({n.team_short})</span></span>
                <Badge tone={n.severity === 'high' ? 'red' : 'amber'}>
                  {n.status_label ?? n.statusLabel ?? '?'}
                </Badge>
              </li>
            ))}
          </ul>
          {news.length > 3 && (
            <Link href="/my-team" className="block mt-2 text-[11px] text-accent-green underline">
              {news.length - 3} more →
            </Link>
          )}
        </Card>
      )}

      {/* Footer nav to old pages */}
      <div className="grid grid-cols-2 gap-2 pt-4">
        <Link href="/transfer-planner" className="bg-bg-card border border-line rounded-lg px-3 py-3 text-sm text-center hover:bg-bg-inset">
          Transfer planner
        </Link>
        <Link href="/captaincy" className="bg-bg-card border border-line rounded-lg px-3 py-3 text-sm text-center hover:bg-bg-inset">
          Captaincy
        </Link>
        <Link href="/predicted-lineups" className="bg-bg-card border border-line rounded-lg px-3 py-3 text-sm text-center hover:bg-bg-inset">
          Lineups
        </Link>
        <Link href="/model-audit" className="bg-bg-card border border-line rounded-lg px-3 py-3 text-sm text-center hover:bg-bg-inset">
          Why?
        </Link>
        <Link href="/my-team" className="bg-bg-card border border-line rounded-lg px-3 py-3 text-sm text-center hover:bg-bg-inset">
          My team
        </Link>
        <Link href="/mini-league" className="bg-bg-card border border-line rounded-lg px-3 py-3 text-sm text-center hover:bg-bg-inset">
          Mini-league
        </Link>
      </div>
    </div>
  );
}
