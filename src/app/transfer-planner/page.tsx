import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { compareTransferScenarios, rankTopTransfers } from '@/lib/transfers/optimiser';
import {
  getTransferInsights,
  getTransferEvBreakdown,
  diffComponents,
  pairPerFixture
} from '@/lib/transfers/insights';
import { TransferWhy } from '@/components/TransferWhy';
import { EvDecompositionBar } from '@/components/EvDecompositionBar';
import { CompareToOverlay } from '@/components/CompareToOverlay';
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
  const [scenarios, topTransfers] = await Promise.all([
    compareTransferScenarios({
      managerId, startGameweek: gw.id,
      freeTransfers: summary?.free_transfers ?? 1,
      evThreshold:  Number(process.env.EV_TRANSFER_THRESHOLD ?? 0.6),
      hitThreshold: Number(process.env.EV_HIT_THRESHOLD ?? 1.5)
    }),
    rankTopTransfers(managerId, gw.id, 10)
  ]);

  // Pull the recent-form + upcoming-fixture context for every player involved
  // in the top-10 list (both sides), so the user can audit each suggestion.
  // We also batch-fetch the projection component breakdown across the next
  // EV_BREAKDOWN_HORIZON_GWS gameweeks so each row can render its own
  // stacked-bar decomposition + per-GW delta without an extra round-trip.
  const involvedIds = Array.from(new Set(
    topTransfers.flatMap(t => [t.out.playerId, t.in.playerId])
  ));
  const [insights, evBreakdowns, defconStats] = await Promise.all([
    getTransferInsights(involvedIds, gw.id),
    getTransferEvBreakdown(involvedIds, gw.id, EV_BREAKDOWN_HORIZON_GWS),
    // Pull season DEFCON-per-90 + total DEFCON points for every player on
    // the top-10. Lets the row table flag "Le Fée scores 4 points because
    // he averages 9 def-actions/90 — borderline" vs "Anderson is 11/90, safe".
    loadDefconStats(involvedIds)
  ]);

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
        title={`Top 10 transfers for ${gw.name}`}
        subtitle="Ranked by expected Starting-XI points gained next gameweek. Captain doubling and bench-utility factored in."
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
                    </div>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-ink-dim">
                    <span className="group-open:hidden">
                      click to see EV breakdown, fixtures, and recent form →
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
