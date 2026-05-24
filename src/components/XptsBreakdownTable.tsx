import type { EvComponents, PlayerInsight } from '@/lib/transfers/insights';
import { fmt } from '@/lib/util/fmt';

/**
 * Side-by-side per-component xPts breakdown for an (OUT, IN) swap.
 *
 * Answers the "Cherki's per-90s are better, why is Le Fée projected higher?"
 * question by showing exactly how each component lands once expected
 * minutes scaling and player priors are applied.
 *
 * Reads `EvComponents` (the already-scaled engine output: position
 * multiplier × player prior already baked in) and the player's own
 * `PlayerInsight.season` per-90s + insight.priors so we can show the
 * input math too.
 *
 * Layout:
 *   component  · OUT (formula → result)  · IN (formula → result)  · Δ
 *
 * The formula column shows the season per-90 rate × mins-scale × prior
 * for the attacking components — the actual derivation visible to the
 * user. Defcon / appearance are listed without a derivation column
 * because they don't come from xG/xA/bonus per-90s.
 */
export interface XptsBreakdownProps {
  outName: string;
  inName:  string;
  outComponents: EvComponents;
  inComponents:  EvComponents;
  // Insights are optional — we'll render a "no inputs available" placeholder
  // if missing (the table still works, just without the formula column).
  outInsight?: PlayerInsight;
  inInsight?:  PlayerInsight;
  // Expected minutes for THIS GW per player. Powers the mins-scale column
  // ("× 89/90"). When null, derived approximation from start_prob+observed.
  outExpectedMinutes?: number | null;
  inExpectedMinutes?:  number | null;
  // Horizon being summed (1/3/6/8 GWs). Lets us label the table title.
  horizonGws: number;
}

interface Row {
  label:    string;
  formula:  (i?: PlayerInsight, mins?: number | null) => string;
  value:    (c: EvComponents) => number;
  tone?:    'pos' | 'neg';        // negative-direction component (e.g. concede)
}

const ROWS: Row[] = [
  {
    label: 'appearance',
    formula: (_, mins) =>
      mins == null ? '—' : mins >= 60 ? `${Math.round(mins)} mins → 2 pts` : `${Math.round(mins)} mins → 1 pt`,
    value: c => c.appearance
  },
  {
    label: 'goals',
    formula: (i, mins) => {
      if (!i || mins == null) return '—';
      const positionPts = i.position === 'FWD' ? 4 : i.position === 'MID' ? 5 : 6;
      const goalPrior = i.priors?.goalMult ?? 1;
      return `xG/90 ${fmt(i.season.xgPer90, 2)} × ${Math.round(mins)}/90 × ${positionPts} × prior ${fmt(goalPrior, 2)}`;
    },
    value: c => c.goals
  },
  {
    label: 'assists',
    formula: (i, mins) => {
      if (!i || mins == null) return '—';
      const assistPrior = i.priors?.assistMult ?? 1;
      return `xA/90 ${fmt(i.season.xaPer90, 2)} × ${Math.round(mins)}/90 × 3 × prior ${fmt(assistPrior, 2)}`;
    },
    value: c => c.assists
  },
  {
    label: 'clean sheet',
    formula: i =>
      !i ? '—' :
      i.position === 'GKP' || i.position === 'DEF'
        ? 'CS prob × 4 (team-defence × opp-attack)'
        : i.position === 'MID'
          ? 'CS prob × 1 (team-defence)'
          : 'no CS pts for FWD'
    ,
    value: c => c.cleanSheet
  },
  {
    label: 'bonus',
    formula: (i, mins) => {
      if (!i || mins == null) return '—';
      const bonusPrior = i.priors?.bonusMult ?? 1;
      return `bonus/90 ${fmt(i.season.bonusPer90, 2)} × ${Math.round(mins)}/90 × prior ${fmt(bonusPrior, 2)}`;
    },
    value: c => c.bonus
  },
  {
    label: 'defcon',
    formula: i => {
      if (!i || !i.season.defconPer90) return '—';
      return `${fmt(i.season.defconPer90, 1)} actions/90 × opp × P(≥12) → +2 if hit`;
    },
    value: c => c.defcon
  },
  { label: 'saves',   formula: i => i?.position === 'GKP' ? 'saves/3 × CS-adjusted' : '—', value: c => c.saves },
  { label: 'pen save', formula: i => i?.position === 'GKP' ? 'opp pen rate × pen save rate × 5' : '—', value: c => c.penSave },
  { label: 'concede',  formula: i =>
      i?.position === 'GKP' || i?.position === 'DEF' ? 'goals_conceded ≥ 2 → −1 per 2 (negative)' : '—',
    value: c => c.concede, tone: 'neg' },
  { label: 'cards',    formula: () => 'yellow rate × −1 + red rate × −3', value: c => c.cards, tone: 'neg' },
  { label: 'OG',       formula: () => 'own-goal rate × −2', value: c => c.owngoal, tone: 'neg' },
];

export function XptsBreakdownTable(props: XptsBreakdownProps) {
  const rows = ROWS
    .map(r => ({
      ...r,
      outValue: r.value(props.outComponents),
      inValue:  r.value(props.inComponents),
    }))
    // Hide rows where BOTH players are at zero on this component — keeps
    // the table tight (e.g. saves/penSave only show for GK swaps).
    .filter(r => Math.abs(r.outValue) > 0.005 || Math.abs(r.inValue) > 0.005);

  const totalOut = sum(props.outComponents);
  const totalIn  = sum(props.inComponents);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] uppercase tracking-widest text-ink-dim">
          xPts breakdown · {props.horizonGws}-GW horizon
        </div>
        <div className="text-[11px] font-mono">
          <span className="text-ink-dim">{props.outName} {fmt(totalOut, 2)} → {props.inName} {fmt(totalIn, 2)}</span>
          <span className={`ml-2 ${totalIn - totalOut >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
            net {totalIn - totalOut >= 0 ? '+' : ''}{fmt(totalIn - totalOut, 2)}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-[11px] font-mono w-full min-w-[640px]">
          <thead className="text-ink-dim">
            <tr>
              <th className="text-left pr-2">component</th>
              <th className="text-left pr-2">{props.outName} (OUT) formula</th>
              <th className="text-right pr-2">xPts</th>
              <th className="text-left pr-2">{props.inName} (IN) formula</th>
              <th className="text-right pr-2">xPts</th>
              <th className="text-right">Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const d = r.inValue - r.outValue;
              const dTone = (r.tone === 'neg' ? -d : d) >= 0 ? 'text-accent-green' : 'text-accent-red';
              return (
                <tr key={r.label} className="border-t border-line/40">
                  <td className="pr-2 text-ink-muted">{r.label}</td>
                  <td className="pr-2 text-ink-dim">{r.formula(props.outInsight, props.outExpectedMinutes)}</td>
                  <td className="pr-2 text-right">{fmt(r.outValue, 2)}</td>
                  <td className="pr-2 text-ink-dim">{r.formula(props.inInsight, props.inExpectedMinutes)}</td>
                  <td className="pr-2 text-right">{fmt(r.inValue, 2)}</td>
                  <td className={`text-right ${dTone}`}>{d >= 0 ? '+' : ''}{fmt(d, 2)}</td>
                </tr>
              );
            })}
            <tr className="border-t border-line font-semibold">
              <td className="pr-2 text-ink">total</td>
              <td className="pr-2" />
              <td className="pr-2 text-right">{fmt(totalOut, 2)}</td>
              <td className="pr-2" />
              <td className="pr-2 text-right">{fmt(totalIn, 2)}</td>
              <td className={`text-right ${totalIn - totalOut >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {totalIn - totalOut >= 0 ? '+' : ''}{fmt(totalIn - totalOut, 2)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-ink-dim leading-snug">
        Formula columns show the per-90 rate × minutes scaling × position multiplier
        × player prior — the engine&apos;s actual derivation. xPts column is the engine
        output AFTER calibration and priors are applied. Why a player with lower
        per-90 rates can still project higher: expected minutes scale every per-90 stat
        linearly, defcon adds a flat +2 when ≥12 actions are projected, and pen-takers
        get an extra ~0.8 xPts per pen attempt.
      </p>
    </div>
  );
}

function sum(c: EvComponents): number {
  return (
    c.appearance + c.goals + c.assists + c.cleanSheet + c.bonus +
    c.saves + c.penSave + c.cards + c.concede + c.owngoal + c.defcon
  );
}
