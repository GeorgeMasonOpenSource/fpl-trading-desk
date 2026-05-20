import type { EvComponents, PerGwDelta } from '@/lib/transfers/insights';
import { fmt } from '@/lib/util/fmt';

/**
 * Stacked bar showing where a transfer's EV gain comes from, plus a per-GW
 * delta table. Components shown in fixed order so a user comparing two rows
 * can read the bars at a glance:
 *
 *   goals · assists · clean_sheet · bonus · defcon · appearance · saves
 *   ─ then negatives ─
 *   concede · cards · owngoal
 *
 * Positive segments stack left-to-right above zero; negative segments stack
 * right-to-left below zero. We render percentages of the total absolute span
 * so the bar always fills the row.
 *
 * Caller passes the already-computed delta (IN - OUT). This component is pure
 * — no fetching, no state.
 */
export interface EvDecompositionBarProps {
  delta: EvComponents;
  perGw?: PerGwDelta[];
}

interface Segment {
  key: keyof EvComponents;
  label: string;
  value: number;
  colorClass: string;
}

const SEGMENT_ORDER: Array<{ key: keyof EvComponents; label: string; pos: string; neg: string }> = [
  { key: 'goals',      label: 'goals',  pos: 'bg-accent-green',   neg: 'bg-accent-red' },
  { key: 'assists',    label: 'assists', pos: 'bg-accent-green/80', neg: 'bg-accent-red/80' },
  { key: 'cleanSheet', label: 'CS',     pos: 'bg-accent-blue',    neg: 'bg-accent-red/70' },
  { key: 'bonus',      label: 'bonus',  pos: 'bg-accent-violet',  neg: 'bg-accent-red/60' },
  { key: 'defcon',     label: 'defcon', pos: 'bg-accent-amber',   neg: 'bg-accent-red/50' },
  { key: 'appearance', label: 'apps',   pos: 'bg-ink-muted',      neg: 'bg-accent-red/40' },
  { key: 'saves',      label: 'saves',  pos: 'bg-accent-blue/70', neg: 'bg-accent-red/40' },
  { key: 'penSave',    label: 'penSv',  pos: 'bg-accent-blue/60', neg: 'bg-accent-red/40' },
  // Negatives — when the IN player loses MORE points to these, that's bad for the swap.
  { key: 'concede',    label: 'concede', pos: 'bg-accent-green/40', neg: 'bg-accent-red' },
  { key: 'cards',      label: 'cards',   pos: 'bg-accent-green/40', neg: 'bg-accent-red/80' },
  { key: 'owngoal',    label: 'OG',      pos: 'bg-accent-green/40', neg: 'bg-accent-red/40' }
];

export function EvDecompositionBar({ delta, perGw }: EvDecompositionBarProps) {
  const segments: Segment[] = SEGMENT_ORDER
    .map(s => ({
      key: s.key,
      label: s.label,
      value: Number((delta[s.key] ?? 0).toFixed(3)),
      colorClass: (delta[s.key] ?? 0) >= 0 ? s.pos : s.neg
    }))
    .filter(s => Math.abs(s.value) > 0.01);

  const posSum = segments.filter(s => s.value > 0).reduce((a, s) => a + s.value, 0);
  const negSum = segments.filter(s => s.value < 0).reduce((a, s) => a + Math.abs(s.value), 0);
  const span = Math.max(posSum + negSum, 0.0001);

  // Width allotted to positive side of zero, as a percentage of the full bar.
  // The zero line sits where positives end / negatives begin.
  const posPct = (posSum / span) * 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-ink-dim">EV breakdown (horizon)</div>
        <div className="text-[11px] font-mono">
          <span className={delta.total >= 0 ? 'text-accent-green' : 'text-accent-red'}>
            net {delta.total >= 0 ? '+' : ''}{fmt(delta.total, 2)}
          </span>
        </div>
      </div>

      {/* The bar itself. Two halves separated by a zero line. */}
      <div className="relative h-3 rounded bg-bg-inset overflow-hidden ring-1 ring-line">
        <div className="absolute inset-y-0 left-0 flex" style={{ width: `${posPct}%` }}>
          {segments.filter(s => s.value > 0).map(s => (
            <div
              key={s.key}
              className={`${s.colorClass} h-full`}
              style={{ width: `${(s.value / Math.max(posSum, 0.0001)) * 100}%` }}
              title={`${s.label} +${fmt(s.value, 2)}`}
            />
          ))}
        </div>
        <div className="absolute inset-y-0" style={{ left: `${posPct}%`, width: `${100 - posPct}%` }}>
          <div className="flex h-full">
            {segments.filter(s => s.value < 0).map(s => (
              <div
                key={s.key}
                className={`${s.colorClass} h-full`}
                style={{ width: `${(Math.abs(s.value) / Math.max(negSum, 0.0001)) * 100}%` }}
                title={`${s.label} ${fmt(s.value, 2)}`}
              />
            ))}
          </div>
        </div>
        {/* Zero line marker — only render when both sides have content. */}
        {posSum > 0 && negSum > 0 && (
          <div
            className="absolute inset-y-0 w-px bg-ink/70"
            style={{ left: `${posPct}%` }}
          />
        )}
      </div>

      {/* Legend — one chip per non-trivial segment. */}
      <div className="flex flex-wrap gap-1 text-[10px] font-mono">
        {segments.length === 0 ? (
          <span className="text-ink-dim">Components within 0.01 of zero — swap is a wash by component.</span>
        ) : segments.map(s => (
          <span key={s.key} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-bg-inset border border-line">
            <span className={`inline-block w-2 h-2 rounded-sm ${s.colorClass}`} />
            <span className="text-ink-muted">{s.label}</span>
            <span className={s.value >= 0 ? 'text-accent-green' : 'text-accent-red'}>
              {s.value >= 0 ? '+' : ''}{fmt(s.value, 2)}
            </span>
          </span>
        ))}
      </div>

      {/* Per-GW delta strip — concrete, fixture-by-fixture. */}
      {perGw && perGw.length > 0 && (
        <div className="pt-1">
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">
            Per-GW xPts (in vs out)
          </div>
          <div className="overflow-x-auto">
            <table className="text-[10px] font-mono w-full min-w-[480px]">
              <thead className="text-ink-dim">
                <tr>
                  <th className="text-left pr-2">GW</th>
                  <th className="text-left pr-2">in fixt</th>
                  <th className="text-right pr-2">in xP</th>
                  <th className="text-left pr-2">out fixt</th>
                  <th className="text-right pr-2">out xP</th>
                  <th className="text-right">Δ</th>
                </tr>
              </thead>
              <tbody>
                {perGw.map(row => (
                  <tr key={row.gameweekId} className="border-t border-line/40">
                    <td className="pr-2">{row.gameweekId}</td>
                    <td className="pr-2 text-ink-muted">
                      {row.inOpp ? `${row.inOpp}${row.inHome ? '(H)' : '(A)'}` : <span className="text-ink-dim">blank</span>}
                    </td>
                    <td className="pr-2 text-right">{fmt(row.inXpts, 2)}</td>
                    <td className="pr-2 text-ink-muted">
                      {row.outOpp ? `${row.outOpp}${row.outHome ? '(H)' : '(A)'}` : <span className="text-ink-dim">blank</span>}
                    </td>
                    <td className="pr-2 text-right">{fmt(row.outXpts, 2)}</td>
                    <td className={`text-right ${row.delta >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                      {row.delta >= 0 ? '+' : ''}{fmt(row.delta, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
