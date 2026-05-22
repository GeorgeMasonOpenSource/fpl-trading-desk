import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { sql } from '@/lib/db/client';
import type { BacktestSummary } from '@/lib/backtest/harness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Backtesting page — shows model performance over the season as a single
 * rigorous number. RMSE is the headline. Below it: per-position breakdown,
 * calibration buckets, hit rates, and a history of every backtest run so
 * we can compare model versions.
 *
 * Run a new backtest with `npm run backtest:run` from your laptop.
 */
export default async function BacktestingPage() {
  const runs = await sql<Array<{
    id: number; name: string;
    started_at: string; finished_at: string | null;
    summary: BacktestSummary | { error?: string } | null;
  }>>`
    SELECT id, name, started_at, finished_at, summary
      FROM backtest_runs
     ORDER BY started_at DESC
     LIMIT 20
  `;

  const latest = runs.find(r =>
    r.summary && !(r.summary as any).error && (r.summary as any).rmse != null
  );
  const latestSummary = latest?.summary as BacktestSummary | undefined;

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Backtesting</div>
        <h1 className="text-2xl font-semibold">Model performance</h1>
        <p className="text-sm text-ink-muted mt-1 max-w-3xl">
          Walk-forward residuals: for every finished gameweek, we compare the
          projection snapshot stored at the time vs the player&apos;s actual
          points. Aggregated to RMSE / MAE / bias plus per-position
          breakdowns and calibration buckets. Run a new one with{' '}
          <code className="font-mono">npm run backtest:run</code> after any
          model change.
        </p>
      </header>

      {latestSummary ? <HeadlineCard s={latestSummary} /> : <EmptyHeadline runs={runs} />}
      {latestSummary && <CalibrationCard s={latestSummary} />}
      {latestSummary && <PositionCard s={latestSummary} />}

      <Card title="Recent runs" subtitle="Compare across model versions. Label runs with BACKTEST_NAME=... when you run them.">
        <Table>
          <THead>
            <TH>Run</TH>
            <TH>GW window</TH>
            <TH>When</TH>
            <TH className="text-right">N</TH>
            <TH className="text-right">RMSE</TH>
            <TH className="text-right">MAE</TH>
            <TH className="text-right">Bias</TH>
            <TH className="text-right">Hit @6</TH>
          </THead>
          <tbody>
            {runs.map(r => {
              const s = r.summary as any;
              const err = s?.error;
              return (
                <TR key={r.id}>
                  <TD>
                    <span className="font-medium">{r.name}</span>
                    {err && <span className="ml-2 text-[10px] text-accent-red">error</span>}
                  </TD>
                  <TD className="text-xs text-ink-muted font-mono">
                    {s?.startGw && s?.endGw ? `GW${s.startGw}-${s.endGw}` : '—'}
                  </TD>
                  <TD className="text-xs text-ink-muted">
                    {r.started_at?.toString?.().slice(0, 16)}
                  </TD>
                  <TD className="text-right font-mono">{s?.totalRows ?? '—'}</TD>
                  <TD className="text-right font-mono">{s?.rmse?.toFixed?.(3) ?? '—'}</TD>
                  <TD className="text-right font-mono">{s?.mae?.toFixed?.(3) ?? '—'}</TD>
                  <TD className="text-right font-mono">{s?.bias != null ? (s.bias >= 0 ? '+' : '') + s.bias.toFixed(3) : '—'}</TD>
                  <TD className="text-right font-mono">{s?.hitRate6?.precision != null ? (s.hitRate6.precision * 100).toFixed(0) + '%' : '—'}</TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function HeadlineCard({ s }: { s: BacktestSummary }) {
  // RMSE tone — green if < 1.5, amber if 1.5-2.0, red if > 2.0.
  const rmseTone =
    s.rmse < 1.5 ? 'text-accent-green' :
    s.rmse < 2.0 ? 'text-accent-amber' :
    'text-accent-red';
  const biasTone = Math.abs(s.bias) < 0.1 ? 'text-accent-green' : 'text-accent-amber';
  return (
    <Card
      title={`Latest run · ${s.name}`}
      subtitle={`GW${s.startGw}-${s.endGw} · ${s.totalRows.toLocaleString()} (player, fixture) pairs`}
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-bg-inset rounded-md p-4">
          <div className={`text-3xl font-mono ${rmseTone}`}>{s.rmse.toFixed(2)}</div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mt-1">RMSE</div>
          <div className="text-[10px] text-ink-dim mt-1">target 1.2 · best public ~1.8</div>
        </div>
        <div className="bg-bg-inset rounded-md p-4">
          <div className="text-3xl font-mono">{s.mae.toFixed(2)}</div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mt-1">MAE</div>
          <div className="text-[10px] text-ink-dim mt-1">mean absolute error</div>
        </div>
        <div className="bg-bg-inset rounded-md p-4">
          <div className={`text-3xl font-mono ${biasTone}`}>{s.bias >= 0 ? '+' : ''}{s.bias.toFixed(2)}</div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mt-1">Bias</div>
          <div className="text-[10px] text-ink-dim mt-1">
            {s.bias > 0 ? 'under-predicting' : s.bias < 0 ? 'over-predicting' : 'calibrated'}
          </div>
        </div>
        <div className="bg-bg-inset rounded-md p-4">
          <div className="text-3xl font-mono">{(s.hitRate6.precision * 100).toFixed(0)}%</div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim mt-1">Hit-rate ≥6</div>
          <div className="text-[10px] text-ink-dim mt-1">
            of {s.hitRate6.count} predictions
          </div>
        </div>
      </div>
    </Card>
  );
}

function EmptyHeadline({ runs }: { runs: any[] }) {
  return (
    <Card title="No backtest runs yet">
      <p className="text-sm text-ink-muted">
        Run <code className="font-mono">npm run backtest:run</code> from your
        laptop to evaluate the model against historical projection snapshots.
        Needs at least one finished gameweek with snapshots in{' '}
        <code className="font-mono">projection_snapshots</code>.
        {runs.some(r => r.summary && (r.summary as any).error) && (
          <span className="block mt-2 text-accent-amber">
            Last attempted run errored — see the table below.
          </span>
        )}
      </p>
    </Card>
  );
}

function CalibrationCard({ s }: { s: BacktestSummary }) {
  return (
    <Card
      title="Calibration"
      subtitle="For predictions in each bucket: how do the mean predicted points compare to actuals? A well-calibrated model matches in every bucket."
    >
      <Table>
        <THead>
          <TH>Predicted bucket</TH>
          <TH className="text-right">N predictions</TH>
          <TH className="text-right">Mean predicted</TH>
          <TH className="text-right">Mean actual</TH>
          <TH className="text-right">Delta</TH>
        </THead>
        <tbody>
          {s.calibration.map(b => {
            const delta = b.meanActual - b.meanPredicted;
            const tone =
              Math.abs(delta) < 0.3 ? 'text-accent-green' :
              Math.abs(delta) < 0.7 ? 'text-accent-amber' :
              'text-accent-red';
            return (
              <TR key={b.bucket}>
                <TD className="font-mono">{b.bucket}</TD>
                <TD className="text-right font-mono">{b.count}</TD>
                <TD className="text-right font-mono">{b.meanPredicted.toFixed(2)}</TD>
                <TD className="text-right font-mono">{b.meanActual.toFixed(2)}</TD>
                <TD className={`text-right font-mono ${tone}`}>
                  {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
                </TD>
              </TR>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

function PositionCard({ s }: { s: BacktestSummary }) {
  return (
    <Card
      title="Per-position"
      subtitle="Where the model performs well vs poorly. Big gaps point to position-specific bugs."
    >
      <Table>
        <THead>
          <TH>Position</TH>
          <TH className="text-right">N</TH>
          <TH className="text-right">RMSE</TH>
          <TH className="text-right">MAE</TH>
          <TH className="text-right">Bias</TH>
        </THead>
        <tbody>
          {s.byPosition.filter(p => p.count > 0).map(p => (
            <TR key={p.position}>
              <TD>
                <Badge tone="steel">{p.position}</Badge>
              </TD>
              <TD className="text-right font-mono">{p.count}</TD>
              <TD className="text-right font-mono">{p.rmse.toFixed(2)}</TD>
              <TD className="text-right font-mono">{p.mae.toFixed(2)}</TD>
              <TD className={`text-right font-mono ${Math.abs(p.bias) < 0.1 ? 'text-accent-green' : 'text-accent-amber'}`}>
                {p.bias >= 0 ? '+' : ''}{p.bias.toFixed(2)}
              </TD>
            </TR>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
