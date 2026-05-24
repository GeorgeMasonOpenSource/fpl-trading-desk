import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { compareTransferScenarios, rankTopTransfers } from '@/lib/transfers/optimiser';
import { runLpPlan } from '@/lib/transfers/lp-runner';
import {
  getTransferInsights,
  getTransferEvBreakdown,
  diffComponents,
  pairPerFixture
} from '@/lib/transfers/insights';
import { TransferWhy } from '@/components/TransferWhy';
import { TransferReasons } from '@/components/TransferReasons';
import { transferReasons } from '@/lib/transfers/transfer-reasons';
import { loadMinutesContext } from '@/lib/transfers/minutes-context';
import { EvDecompositionBar } from '@/components/EvDecompositionBar';
import { CompareToOverlay } from '@/components/CompareToOverlay';
import { TransferPreview, type PreviewPlayer, type PreviewSwap } from '@/components/TransferPreview';
import { getGameweeks, managerSummary } from '@/lib/db/queries';
import { getManagerId } from '@/lib/session';
import { NotConnected } from '@/components/NotConnected';
import { WhatIfTransfer } from '@/components/WhatIfTransfer';
import { listMySquad, listCandidates } from '@/app/actions/whatif';
import { fmt } from '@/lib/util/fmt';
import { sql } from '@/lib/db/client';

// Horizon (in GWs) used for the EV decomposition bar. We use 3 GW so a fixture
// swing doesn't dominate (a single big-difficulty week would otherwise paint
// the whole bar). 3 GW also matches the optimiser's primary EV horizon, so
// the bar's "net" lines up with the +pts column in the row.
const EV_BREAKDOWN_HORIZON_GWS = 3;
// Heuristic value of a banked FT — used purely for the counterfactual line on
// the transfer planner ("rolling banks a transfer worth ~X EV"). The number is
// the long-run average EV gain of the top-1 transfer in the next GW assuming
// the same squad; we use 0.5 as a conservative constant rather than simulating
// next week. Tune later if backtesting suggests a different floor.
const BANKED_FT_EV = 0.5;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function TransferPlanner() {
  const managerId = getManagerId();
  if (!managerId) return <NotConnected where="Transfer Planner" />;
  // Use the planning gameweek (next not-yet-deadline GW) when one exists,
  // otherwise fall back to current. This matches the dashboard's "planning"
  // behaviour so the rankings line up with where you'll actually transfer.
  const gws = await getGameweeks();
  const gw = gws.planning ?? gws.current ?? gws.next;
  if (!gw) return <p className="text-ink-muted">No gameweek data yet — hit Refresh.</p>;

  const summary = await managerSummary(managerId);
  const [scenarios, topTransfers, lpPlan1, lpPlan3] = await Promise.all([
    compareTransferScenarios({
      managerId, startGameweek: gw.id,
      freeTransfers: summary?.free_transfers ?? 1,
      evThreshold:  Number(process.env.EV_TRANSFER_THRESHOLD ?? 0.6),
      hitThreshold: Number(process.env.EV_HIT_THRESHOLD ?? 1.5)
    }),
    rankTopTransfers(managerId, gw.id, 20),
    // LP optimiser, 1-GW horizon: the globally-optimal single move for THIS
    // gameweek given the budget + 3-per-club + position-shape constraints.
    // Matches FPLReview's "Linear Optimiser" output.
    runLpPlan({
      managerId,
      startGameweek: gw.id,
      horizon: 1,
      freeTransfers: summary?.free_transfers ?? 1,
      allowHits: false
    }).catch(err => ({
      feasible: false as const,
      reason: (err as Error).message,
      horizon: 1, totalXpts: 0, hitsTaken: 0, bank: 0, spend: 0,
      transfersIn: [], transfersOut: [], finalSquad: []
    })),
    // 3-GW horizon — useful when you have 2 FTs and want to think about the
    // medium-term squad. Less critical for GW38 (last GW) but the planner
    // shows both so the user can compare horizons.
    runLpPlan({
      managerId,
      startGameweek: gw.id,
      horizon: 3,
      freeTransfers: summary?.free_transfers ?? 1,
      allowHits: false
    }).catch(err => ({
      feasible: false as const,
      reason: (err as Error).message,
      horizon: 3, totalXpts: 0, hitsTaken: 0, bank: 0, spend: 0,
      transfersIn: [], transfersOut: [], finalSquad: []
    }))
  ]);

  // Pull the recent-form + upcoming-fixture context for every player involved
  // in the top-10 list (both sides), so the user can audit each suggestion.
  // We also batch-fetch the projection component breakdown across the next
  // EV_BREAKDOWN_HORIZON_GWS gameweeks so each row can render its own
  // stacked-bar decomposition + per-GW delta without an extra round-trip.
  const involvedIds = Array.from(new Set(
    topTransfers.flatMap(t => [t.out.playerId, t.in.playerId])
  ));
  const [insights, evBreakdowns, defconStats, currentSquadForPreview, minutesCtx] = await Promise.all([
    getTransferInsights(involvedIds, gw.id),
    getTransferEvBreakdown(involvedIds, gw.id, EV_BREAKDOWN_HORIZON_GWS),
    // Pull season DEFCON-per-90 + total DEFCON points for every player on
    // the top-10. Lets the row table flag "Le Fée scores 4 points because
    // he averages 9 def-actions/90 — borderline" vs "Anderson is 11/90, safe".
    loadDefconStats(involvedIds),
    loadCurrentSquadForPreview(managerId, gw.id),
    // §minutes uncertainty surface — pull expected_mins + start_prob for
    // every involved player so the reasoner can flag <70-min forecasts
    // explicitly. This is the single biggest "why does the model think
    // this?" question users have, so we surface it loudly.
    loadMinutesContext(involvedIds, gw.id)
  ]);

  // Build the swap list for the Transfer Preview: LP top pick first, then
  // the top-5 greedy suggestions so the user can flip between them and see
  // exactly which players come in / out for each. Each PreviewSwap carries
  // the metrics needed for the badges.
  const previewSwaps: PreviewSwap[] = [];
  if (lpPlan1.feasible && lpPlan1.transfersIn.length > 0) {
    previewSwaps.push({
      label: `LP optimal · GW${gw.id} · ${lpPlan1.transfersOut.map(p => p.webName).join(', ')} → ${lpPlan1.transfersIn.map(p => p.webName).join(', ')}`,
      transfersOut: lpPlan1.transfersOut,
      transfersIn:  lpPlan1.transfersIn,
      metrics: [
        { label: 'Total xPts', value: lpPlan1.totalXpts.toFixed(2), tone: 'green' },
        { label: 'Hits',       value: String(lpPlan1.hitsTaken), tone: lpPlan1.hitsTaken === 0 ? 'green' : 'amber' },
        { label: 'Net spend',  value: lpPlan1.spend === 0 ? '£0' : `${lpPlan1.spend > 0 ? '-' : '+'}£${(Math.abs(lpPlan1.spend) / 10).toFixed(1)}m`, tone: lpPlan1.spend > 0 ? 'amber' : 'green' }
      ]
    });
  }
  for (const t of topTransfers.slice(0, 5)) {
    const outP = currentSquadForPreview.find(s => s.playerId === t.out.playerId);
    if (!outP) continue;
    previewSwaps.push({
      label: `Top-${t.rank} · ${t.out.webName} → ${t.in.webName}`,
      transfersOut: [{
        playerId: t.out.playerId, webName: t.out.webName,
        position: t.out.position as 'GKP'|'DEF'|'MID'|'FWD',
        teamShort: t.out.teamShort, cost: t.out.cost,
        sellingPrice: outP.sellingPrice,
        xptsPerGw: t.out.xpts1
      }],
      transfersIn: [{
        playerId: t.in.playerId, webName: t.in.webName,
        position: t.in.position as 'GKP'|'DEF'|'MID'|'FWD',
        teamShort: t.in.teamShort, cost: t.in.cost,
        xptsPerGw: t.in.xpts1
      }],
      metrics: [
        { label: 'Gain (1 GW)', value: `+${t.evGain1.toFixed(2)}`, tone: t.evGain1 > 1 ? 'green' : 'steel' },
        { label: 'Gain (3 GW)', value: `+${t.evGain3.toFixed(2)}`, tone: t.evGain3 > 1 ? 'green' : 'steel' },
        { label: 'Net £',       value: t.netCost === 0 ? '—' : `${t.netCost > 0 ? '-' : '+'}£${(Math.abs(t.netCost) / 10).toFixed(1)}m`, tone: t.netCost <= 0 ? 'green' : 'amber' }
      ]
    });
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Transfer planner</div>
        <h1 className="text-2xl font-semibold">Routes from {gw.name}</h1>
        <p className="text-sm text-ink-muted mt-1">
          Every route is priced. Do nothing and roll are always live options. A move is
          only recommended if EV clears the threshold.
        </p>
      </header>
      <Card
        title="LP optimiser — globally optimal plan"
        subtitle="Mirrors FPLReview's Linear Optimiser. Solves jointly across all constraints (budget, 3-per-club, 1/5/5/3 shape, free transfers). Beats the greedy ranker when the best move requires a budget reshuffle."
      >
        <LpPlanBlock plan={lpPlan1} horizonLabel={`GW${gw.id}`} />
        {lpPlan3.feasible && (
          <div className="mt-6 pt-6 border-t border-line">
            <div className="text-xs uppercase tracking-widest text-ink-dim mb-3">
              3-GW horizon (looking ahead, not just GW{gw.id})
            </div>
            <LpPlanBlock plan={lpPlan3} horizonLabel="3 GW" />
          </div>
        )}
      </Card>

      {previewSwaps.length > 0 && currentSquadForPreview.length === 15 && (
        <TransferPreview currentSquad={currentSquadForPreview} swaps={previewSwaps} defaultSelected={0} />
      )}

      <Card title="Scenario comparison" subtitle="EV gains over 1, 3, 6 and 8 GW horizons">
        <Table>
          <THead>
            <TH>Scenario</TH>
            <TH className="text-right">EV (3 GW)</TH>
            <TH className="text-right">1 GW</TH>
            <TH className="text-right">6 GW</TH>
            <TH className="text-right">8 GW</TH>
            <TH className="text-right">Risk</TH>
            <TH className="text-right">Confidence</TH>
            <TH className="text-right">Flex</TH>
            <TH>Moves</TH>
          </THead>
          <tbody>
            {scenarios.map(s => (
              <TR key={s.scenario}>
                <TD><Badge tone={s.ev > 1.5 ? 'green' : s.ev > 0 ? 'amber' : 'steel'}>{s.scenario}</Badge></TD>
                <TD className="text-right font-mono">{s.ev.toFixed(2)}</TD>
                <TD className="text-right font-mono">{s.evGainByHorizon[1].toFixed(2)}</TD>
                <TD className="text-right font-mono">{s.evGainByHorizon[6].toFixed(2)}</TD>
                <TD className="text-right font-mono">{s.evGainByHorizon[8].toFixed(2)}</TD>
                <TD className="text-right font-mono">{(s.risk*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(s.confidence*100).toFixed(0)}%</TD>
                <TD className="text-right font-mono">{(s.flexibilityScore*100).toFixed(0)}%</TD>
                <TD className="text-xs text-ink-muted">
                  {s.moves.map(m => `${m.out.webName} → ${m.in.webName}`).join('; ') || '—'}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card
        title={`Top 20 transfers for ${gw.name}`}
        subtitle="XI-only — only includes swaps where the incoming player would start in your auto-picked XI. Bench-only depth moves are filtered out. Ranked by next-GW Starting-XI EV gain, captain doubling included."
      >
        {topTransfers.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No legal upgrades found — your squad is at maximum projected XI EV
            given your bank and the 3-per-club cap.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[24px_1fr_1fr_64px_64px_64px_64px_90px] gap-x-3 px-3 py-2 text-[10px] uppercase tracking-widest text-ink-dim border-b border-line">
              <div>#</div><div>Out</div><div>In</div>
              <div className="text-right">+pts GW{gw.id}</div>
              <div className="text-right">+3 GW</div>
              <div className="text-right">+6 GW</div>
              <div className="text-right">Net £</div>
              <div>Flags</div>
            </div>
            {topTransfers.map(t => {
              const inBreak  = evBreakdowns.get(t.in.playerId);
              const outBreak = evBreakdowns.get(t.out.playerId);
              const delta = inBreak && outBreak
                ? diffComponents(inBreak.components, outBreak.components)
                : null;
              const perGw = inBreak && outBreak
                ? pairPerFixture(inBreak.perFixture, outBreak.perFixture)
                : [];
              // Generate plain-English reasoning bullets so the user sees the
              // WHY of every suggestion, not just the EV delta. We compute it
              // once per row and pass it to both the summary preview (top 2
              // headlines) and the expanded panel (full list).
              const outMinutes = minutesCtx.get(t.out.playerId);
              const inMinutes  = minutesCtx.get(t.in.playerId);
              const reasons = transferReasons({
                outName: t.out.webName,
                inName:  t.in.webName,
                outInsight: insights.get(t.out.playerId),
                inInsight:  insights.get(t.in.playerId),
                componentDelta: delta,
                perGw,
                netCost: t.netCost,
                evGain1: t.evGain1,
                evGain3: t.evGain3,
                changesCaptain: t.changesCaptain,
                startsImmediately: t.startsImmediately,
                position: t.in.position,
                outMinutes, inMinutes
              });
              // If EITHER side has expected_mins < 70 we paint an amber
              // "rot risk" badge on the row so the user can spot fragile
              // suggestions at a glance without expanding.
              const inIsRotRisk  = inMinutes  && inMinutes.expectedMinutes  < 70;
              const outIsRotRisk = outMinutes && outMinutes.expectedMinutes < 70;
              const topHeadlines = reasons
                .filter(r => r.tone !== 'negative')
                .slice(0, 2)
                .map(r => r.headline)
                .join(' · ');
              // §3c counterfactual — the EV gain from rolling is: you give up
              // this week's projected gain (-evGain1) but bank a transfer for
              // next week (worth ~BANKED_FT_EV). The optimiser scores `roll`
              // as zero EV by construction; this line surfaces the implicit
              // trade-off so the user can see it on each row.
              const rollNet = BANKED_FT_EV - t.evGain1;
              return (
              <details
                key={`${t.out.playerId}-${t.in.playerId}`}
                className="group bg-bg-card border border-line rounded-md open:bg-bg-inset"
              >
                <summary className="cursor-pointer list-none px-3 py-2 hover:bg-bg-inset rounded-md">
                  <div className="grid grid-cols-[24px_1fr_1fr_64px_64px_64px_64px_90px] gap-x-3 items-center">
                    <div className="font-mono text-ink-dim">{t.rank}</div>
                    <div>
                      <div className="font-medium">
                        {t.out.webName}
                        <span className="ml-2 font-mono text-xs text-ink-dim">{fmt(t.out.xpts1, 2)} xPts</span>
                      </div>
                      <div className="text-[10px] text-ink-dim font-mono flex items-center gap-1.5">
                        <span>{t.out.position} · {t.out.teamShort} · £{(t.out.cost / 10).toFixed(1)}m</span>
                        <DefconChip stat={defconStats.get(t.out.playerId)} pos={t.out.position} />
                      </div>
                    </div>
                    <div>
                      <div className="font-medium">
                        {t.in.webName}
                        <span className="ml-2 font-mono text-xs text-accent-green">{fmt(t.in.xpts1, 2)} xPts</span>
                      </div>
                      <div className="text-[10px] text-ink-dim font-mono flex items-center gap-1.5">
                        <span>{t.in.position} · {t.in.teamShort} · £{(t.in.cost / 10).toFixed(1)}m</span>
                        <DefconChip stat={defconStats.get(t.in.playerId)} pos={t.in.position} />
                      </div>
                    </div>
                    <div className={`text-right font-mono ${t.evGain1 > 0.5 ? 'text-accent-green' : ''}`}>
                      +{fmt(t.evGain1, 2)}
                    </div>
                    <div className="text-right font-mono">+{fmt(t.evGain3, 2)}</div>
                    <div className="text-right font-mono">+{fmt(t.evGain6, 2)}</div>
                    <div className={`text-right font-mono ${t.netCost <= 0 ? 'text-accent-green' : 'text-ink-muted'}`}>
                      {t.netCost === 0 ? '—' : `${t.netCost > 0 ? '-' : '+'}£${(Math.abs(t.netCost) / 10).toFixed(1)}m`}
                    </div>
                    <div className="space-x-1">
                      {t.startsImmediately && <Badge tone="green">starts</Badge>}
                      {t.changesCaptain && <Badge tone="violet">new C</Badge>}
                      {inIsRotRisk && (
                        <Badge tone="amber" title={`Model has ${t.in.webName} at ${inMinutes!.expectedMinutes.toFixed(0)} expected mins (${(inMinutes!.startProb*100).toFixed(0)}% start)`}>
                          rot {inMinutes!.expectedMinutes.toFixed(0)}′
                        </Badge>
                      )}
                      {outIsRotRisk && !inIsRotRisk && (
                        <Badge tone="amber" title={`Out player ${t.out.webName} only at ${outMinutes!.expectedMinutes.toFixed(0)} expected mins — biggest argument for the swap`}>
                          out rot
                        </Badge>
                      )}
                    </div>
                  </div>
                  {topHeadlines && (
                    <div className="mt-1.5 text-[11px] text-ink-muted">
                      <span className="text-accent-green">●</span>{' '}
                      <span className="font-medium text-ink">{topHeadlines}</span>
                      <span className="text-ink-dim"> — click for full reasoning</span>
                    </div>
                  )}
                  <div className="mt-1 flex items-center justify-between text-[10px] text-ink-dim">
                    <span className="group-open:hidden">
                      click to see why, EV breakdown, and recent form →
                    </span>
                    <span
                      className={`font-mono ${rollNet >= 0 ? 'text-accent-amber' : 'text-ink-dim'}`}
                      title="Rolling banks a transfer; we estimate a banked FT is worth ~0.5 EV."
                    >
                      {rollNet >= 0
                        ? `roll instead: net +${fmt(rollNet, 2)} EV (bank FT)`
                        : `vs roll: −${fmt(-rollNet, 2)} EV given up by rolling`}
                    </span>
                  </div>
                </summary>
                <div className="px-3 py-3 border-t border-line space-y-4">
                  <TransferReasons reasons={reasons} />
                  {delta && (
                    <EvDecompositionBar delta={delta} perGw={perGw} />
                  )}
                  <TransferWhy
                    outName={t.out.webName}
                    inName={t.in.webName}
                    outInsight={insights.get(t.out.playerId)}
                    inInsight={insights.get(t.in.playerId)}
                  />
                </div>
              </details>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title="Compare to a competitor suggestion"
        subtitle="Paste what FPL Review / a creator recommended; see our EV decomposition for that swap."
      >
        <CompareToOverlay
          reference={
            topTransfers[0]
              ? {
                  label: `${topTransfers[0].out.webName} → ${topTransfers[0].in.webName} (our #1)`,
                  netEv: topTransfers[0].evGain3
                }
              : undefined
          }
        />
      </Card>

      <Card title="Why these routes?">
        <ul className="text-sm text-ink-muted space-y-2">
          {scenarios.map(s => (
            <li key={s.scenario}><span className="font-mono text-ink">{s.scenario}:</span> {s.reasons.join(' ')}</li>
          ))}
        </ul>
      </Card>

      <WhatIfPanel />
    </div>
  );
}

/**
 * Render an LP-solver plan: the recommended IN/OUT swaps and the resulting
 * total xPts. If infeasible (no candidate squad fits the constraints) shows
 * the reason instead.
 */
function LpPlanBlock({ plan, horizonLabel }: { plan: import('@/lib/transfers/lp-runner').LpPlanResult; horizonLabel: string }) {
  if (!plan.feasible) {
    return (
      <div className="text-sm text-ink-muted">
        <span className="text-accent-amber">LP solver unavailable</span>
        {plan.reason && <span className="ml-2 font-mono text-xs">— {plan.reason}</span>}
        <p className="mt-2 text-xs text-ink-dim">
          Install the solver locally with <span className="font-mono">npm install javascript-lp-solver</span>,
          then redeploy. The greedy ranker below still runs in the meantime.
        </p>
      </div>
    );
  }
  if (plan.transfersIn.length === 0) {
    return (
      <div className="text-sm text-ink-muted">
        <Badge tone="green">No transfer recommended</Badge>
        <span className="ml-3">
          Your current 15 is already the optimal squad over the {horizonLabel} horizon
          given budget and 3-per-club constraints. Roll the FT.
        </span>
        <p className="mt-2 text-xs text-ink-dim font-mono">
          Total expected xPts over horizon: {plan.totalXpts.toFixed(2)}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge tone={plan.hitsTaken === 0 ? 'green' : 'amber'}>
          {plan.transfersIn.length} transfer{plan.transfersIn.length === 1 ? '' : 's'}
          {plan.hitsTaken > 0 ? ` (incl. ${plan.hitsTaken} -4 hit${plan.hitsTaken === 1 ? '' : 's'})` : ''}
        </Badge>
        <span className="font-mono text-ink-muted">
          Total xPts over {horizonLabel}: <span className="text-ink">{plan.totalXpts.toFixed(2)}</span>
        </span>
        <span className="font-mono text-ink-muted">
          Net spend: <span className={plan.spend > 0 ? 'text-accent-amber' : 'text-accent-green'}>
            {plan.spend === 0 ? '£0.0m' : `${plan.spend > 0 ? '-' : '+'}£${(Math.abs(plan.spend) / 10).toFixed(1)}m`}
          </span>
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">Sell</div>
          <div className="space-y-1">
            {plan.transfersOut.map(p => (
              <div key={p.playerId} className="flex items-center justify-between bg-bg-card border border-line rounded px-3 py-2">
                <div>
                  <div className="font-medium">{p.webName}</div>
                  <div className="text-[10px] text-ink-dim font-mono">
                    {p.position} · {p.teamShort} · £{(p.sellingPrice / 10).toFixed(1)}m
                  </div>
                </div>
                <div className="font-mono text-xs text-ink-muted">
                  {p.xptsPerGw.toFixed(2)}/GW
                </div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-2">Buy</div>
          <div className="space-y-1">
            {plan.transfersIn.map(p => (
              <div key={p.playerId} className="flex items-center justify-between bg-bg-card border border-line rounded px-3 py-2">
                <div>
                  <div className="font-medium">{p.webName}</div>
                  <div className="text-[10px] text-ink-dim font-mono">
                    {p.position} · {p.teamShort} · £{(p.cost / 10).toFixed(1)}m
                  </div>
                </div>
                <div className="font-mono text-xs text-accent-green">
                  {p.xptsPerGw.toFixed(2)}/GW
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

async function WhatIfPanel() {
  const squad = await listMySquad();
  // Build a candidates map keyed by position so the client can swap dropdowns
  // without round-tripping for each pick.
  const byPos: Record<string, Awaited<ReturnType<typeof listCandidates>>> = {};
  for (const pos of ['GKP', 'DEF', 'MID', 'FWD']) {
    byPos[pos] = await listCandidates(pos, 150);
  }
  return <WhatIfTransfer squad={squad} candidatesByPosition={byPos} />;
}

/**
 * Tiny inline chip showing a player's DEFCON reliability tier + per-90
 * value. Coloured green / amber / red so the user can eyeball whether
 * a recommended 4-pointer actually earns the +2 defcon points consistently.
 */
function DefconChip({ stat, pos }: { stat: DefconStat | undefined; pos: 'GKP'|'DEF'|'MID'|'FWD' }) {
  if (!stat) return null;
  // GKP don't get defcon — they have saves instead. Hide the chip.
  if (pos === 'GKP') return null;
  const tone =
    stat.reliability === 'high'    ? 'text-accent-green' :
    stat.reliability === 'medium'  ? 'text-accent-amber' :
    stat.reliability === 'low'     ? 'text-accent-red'   :
                                     'text-ink-dim';
  const threshold = pos === 'DEF' ? 10 : 12;
  return (
    <span
      title={
        stat.reliability === 'unknown'
          ? 'Not enough minutes this season to estimate defcon reliability'
          : `Season DEFCON ${stat.defconPer90.toFixed(1)}/90 vs ${threshold} threshold for ${pos}`
      }
      className={`font-mono ${tone}`}
    >
      defcon {stat.defconPer90.toFixed(1)}/90
    </span>
  );
}

interface DefconStat {
  defconPer90: number;     // mean defensive actions per 90 mins this season
  defconPoints: number;    // total 2-pt awards earned this season
  reliability: 'high' | 'medium' | 'low' | 'unknown';
}

/**
 * Pull season DEFCON stats for the involved players so the top-10 row UI can
 * show "how reliable is this 4-pointer". Threshold tiers:
 *   - high    ≥ 10 def-actions/90 (for DEF) or 12 (for MID/FWD)
 *   - medium  within 2 of the threshold
 *   - low     more than 2 below threshold
 *   - unknown insufficient minutes (< 270 this season)
 */
/**
 * Pull the user's current 15 in a shape ready for the TransferPreview
 * component: position, team-short, current cost, owner's selling_price,
 * and the player's 1-GW xPts. Sorted by position so the GKP appears
 * first, then DEF/MID/FWD.
 */
async function loadCurrentSquadForPreview(managerId: number, gameweekId: number): Promise<PreviewPlayer[]> {
  const rows = await sql<Array<{
    player_id: number; web_name: string;
    position: 'GKP'|'DEF'|'MID'|'FWD';
    team_short: string;
    now_cost: number;
    selling_price: number | null;
    xpts: number;
  }>>`
    SELECT mp.player_id,
           p.web_name,
           p.position,
           t.short_name AS team_short,
           p.now_cost,
           mp.selling_price,
           COALESCE((
             SELECT SUM(pr.xpts_total)
               FROM projections pr
              WHERE pr.player_id = p.id
                AND pr.gameweek_id = ${gameweekId}
           ), 0)::float8 AS xpts
      FROM manager_picks mp
      JOIN players p ON p.id = mp.player_id
      JOIN teams   t ON t.id = p.team_id
     WHERE mp.manager_id = ${managerId}
       AND mp.gameweek_id = (
         SELECT MAX(gameweek_id) FROM manager_picks
          WHERE manager_id = ${managerId}
            AND gameweek_id <= ${gameweekId}
       )
  `;
  return rows.map(r => ({
    playerId:     r.player_id,
    webName:      r.web_name,
    position:     r.position,
    teamShort:    r.team_short,
    cost:         Number(r.now_cost),
    sellingPrice: r.selling_price == null ? Number(r.now_cost) : Number(r.selling_price),
    xptsPerGw:    Number(r.xpts) || 0
  }));
}

async function loadDefconStats(playerIds: number[]): Promise<Map<number, DefconStat>> {
  if (playerIds.length === 0) return new Map();
  const rows = await sql<Array<{
    id: number; position: 'GKP'|'DEF'|'MID'|'FWD';
    season_defcon_per_90: number;
    season_minutes: number;
  }>>`
    SELECT id, position,
           COALESCE(season_defcon_per_90, 0) AS season_defcon_per_90,
           COALESCE(season_minutes, 0)       AS season_minutes
      FROM players
     WHERE id IN ${sql(playerIds as any)}
  `;
  // DEFCON awards: 2 pts at 10 def actions for DEF, 12 for MID/FWD. We can
  // approximate season points-from-defcon as floor(per_90 × games_played
  // × hit_rate) but we don't have games_played handy without another join,
  // so we report per_90 and leave points-earned for a future enhancement.
  const out = new Map<number, DefconStat>();
  for (const r of rows) {
    const per90 = Number(r.season_defcon_per_90) || 0;
    const threshold = r.position === 'DEF' ? 10 : 12;
    let reliability: DefconStat['reliability'];
    if (Number(r.season_minutes) < 270) {
      reliability = 'unknown';
    } else if (per90 >= threshold) {
      reliability = 'high';
    } else if (per90 >= threshold - 2) {
      reliability = 'medium';
    } else {
      reliability = 'low';
    }
    out.set(r.id, { defconPer90: per90, defconPoints: 0, reliability });
  }
  return out;
}
