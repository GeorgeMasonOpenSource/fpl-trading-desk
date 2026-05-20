import { Badge } from './ui/Badge';
import type { SquadRiskRow, RiskBand } from '@/lib/risk/squad-risk';
import { fmt } from '@/lib/util/fmt';

/**
 * Squad Rotation Watchlist — surfaces end-of-season rotation risk on every
 * player in the user's squad, with a "swap to a safer alternative" chip.
 *
 * Visual order: trim > watch > safe. Within a band, sorted by composite
 * risk (highest first). The bands use the same colour palette as the rest
 * of the dashboard so a quick glance at red rows = "do something this week".
 *
 * Pure presentational — the caller fetches via getSquadRotationRisk.
 */
export function SquadRotationWatchlist({ rows }: { rows: SquadRiskRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No squad data yet — run the seed/ingest to populate manager_picks.
      </p>
    );
  }

  const counts = {
    trim:  rows.filter(r => r.band === 'trim').length,
    watch: rows.filter(r => r.band === 'watch').length,
    safe:  rows.filter(r => r.band === 'safe').length
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Badge tone="red">trim · {counts.trim}</Badge>
        <Badge tone="amber">watch · {counts.watch}</Badge>
        <Badge tone="green">safe · {counts.safe}</Badge>
        <span className="text-ink-dim ml-1">
          (composite blends start prob, early-sub risk, minutes confidence,
          injury doubt, team motivation, and last-3-GW trend)
        </span>
      </div>

      <ul className="divide-y divide-line">
        {rows.map(r => (
          <li key={r.playerId} className="py-3">
            <RotationRow row={r} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RotationRow({ row }: { row: SquadRiskRow }) {
  const tone = bandTone(row.band);
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-3 items-start">
      <div className="space-y-2">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="font-medium">{row.webName}</div>
          <span className="text-[10px] font-mono text-ink-dim">
            {row.position} · {row.teamShort} · £{(row.cost / 10).toFixed(1)}m
          </span>
          {row.isCaptain && <Badge tone="violet">C</Badge>}
          {row.isVice    && <Badge tone="blue">VC</Badge>}
          <Badge tone={tone}>
            {row.band.toUpperCase()} · risk {(row.compositeRisk * 100).toFixed(0)}%
          </Badge>
        </div>

        <RiskMeter value={row.compositeRisk} />

        <div className="flex flex-wrap gap-1.5 text-[10px]">
          {row.flags.length === 0 ? (
            <span className="text-ink-dim italic">no specific warnings</span>
          ) : (
            row.flags.map((f, i) => (
              <Badge key={i} tone={tone}>{f}</Badge>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] font-mono text-ink-muted">
          <span>last 3 GW mins:</span>
          {row.recentMinutes.length === 0 ? (
            <span className="text-ink-dim italic">no history rows</span>
          ) : (
            <span className="flex items-end gap-1 h-5">
              {row.recentMinutes.slice().reverse().map((m, i) => (
                <MinutesBar key={i} m={m} />
              ))}
            </span>
          )}
          <span className="text-ink-dim">·</span>
          <span>1 GW xPts <span className="text-ink">{fmt(row.xpts1, 2)}</span></span>
          <span>3 GW xPts <span className="text-ink">{fmt(row.xpts3, 2)}</span></span>
        </div>
      </div>

      <div className="border-l border-line pl-3 min-h-[60px]">
        {row.saferSwap ? <SaferSwapPanel row={row} /> : <NoSwap row={row} />}
      </div>
    </div>
  );
}

function RiskMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  // Tri-colour bar: green up to 30%, amber 30-60%, red above 60%. We render
  // the meter at the *value*, not the band, so a 59% sits visually right
  // next to the amber/red boundary.
  const fill =
    value >= 0.6 ? 'bg-accent-red' :
    value >= 0.3 ? 'bg-accent-amber' :
                   'bg-accent-green';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-full max-w-md bg-bg-inset rounded ring-1 ring-line overflow-hidden">
        <div className={`h-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MinutesBar({ m }: { m: { minutes: number; started: boolean; gameweekId: number } }) {
  // 90 minutes maps to a full 20px bar; 0 to a tiny stub. Bars are coloured
  // by start status — green if they started, amber if they came off the
  // bench, faded steel if DNP.
  const heightPct = Math.min(100, (m.minutes / 90) * 100);
  const fill = m.minutes === 0 ? 'bg-bg-inset border border-line'
             : m.started      ? 'bg-accent-green'
             :                  'bg-accent-amber';
  return (
    <span
      title={`GW${m.gameweekId} — ${m.minutes}′${m.started ? ' (started)' : m.minutes ? ' (sub)' : ' (DNP)'}`}
      className={`inline-block w-3 ${fill} rounded-sm`}
      style={{ height: `${Math.max(2, heightPct / 5)}px` }}
    />
  );
}

function SaferSwapPanel({ row }: { row: SquadRiskRow }) {
  const s = row.saferSwap!;
  const riskDelta = row.compositeRisk - s.compositeRisk;
  const xptsDelta = s.xpts3 - row.xpts3;
  const costDelta = s.cost - row.cost;
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-widest text-ink-dim">
        Safer alternative
      </div>
      <div className="font-medium">{s.webName}</div>
      <div className="text-[10px] text-ink-dim font-mono">
        {s.position} · {s.teamShort} · £{(s.cost / 10).toFixed(1)}m
      </div>
      <div className="text-[11px] font-mono space-x-2">
        <span className="text-accent-green">−{(riskDelta * 100).toFixed(0)}% risk</span>
        <span className={xptsDelta >= 0 ? 'text-accent-green' : 'text-ink-muted'}>
          {xptsDelta >= 0 ? '+' : ''}{fmt(xptsDelta, 2)} 3-GW xPts
        </span>
        <span className={costDelta <= 0 ? 'text-accent-green' : 'text-ink-muted'}>
          {costDelta === 0 ? '£0' : `${costDelta > 0 ? '+' : ''}£${(costDelta / 10).toFixed(1)}m`}
        </span>
      </div>
      <div className="text-[10px] text-ink-dim font-mono">
        start {(s.startProb * 100).toFixed(0)}% · early-sub {(s.earlySubRisk * 100).toFixed(0)}%
      </div>
    </div>
  );
}

function NoSwap({ row }: { row: SquadRiskRow }) {
  if (row.band === 'safe') {
    return (
      <div className="text-[11px] text-ink-dim italic">
        No swap needed — minutes look secure.
      </div>
    );
  }
  return (
    <div className="text-[11px] text-ink-dim">
      No candidate within £{(5 / 10).toFixed(1)}m clears both the risk delta
      and the 85% xPts floor.
    </div>
  );
}

function bandTone(band: RiskBand): 'green' | 'amber' | 'red' {
  if (band === 'trim')  return 'red';
  if (band === 'watch') return 'amber';
  return 'green';
}
