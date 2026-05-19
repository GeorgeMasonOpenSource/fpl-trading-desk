import { Card } from '@/components/ui/Card';
import { Table, THead, TH, TR, TD } from '@/components/ui/Table';
import { sql } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function BacktestingPage() {
  const runs = await sql<any[]>`
    SELECT id, name, started_at, finished_at, summary
    FROM backtest_runs ORDER BY started_at DESC LIMIT 20
  `;
  return (
    <div className="space-y-4">
      <header>
        <div className="text-xs uppercase tracking-widest text-ink-dim">Backtesting</div>
        <h1 className="text-2xl font-semibold">Model performance over time</h1>
        <p className="text-sm text-ink-muted mt-1">
          POST to <span className="font-mono">/api/backtest</span> with a date range and rule toggles. Every metric is stored so we can promote or kill rules based on real impact.
        </p>
      </header>
      <Card title="Recent runs">
        <Table>
          <THead>
            <TH>Run</TH><TH>Started</TH><TH>Finished</TH>
            <TH className="text-right">MAE</TH><TH className="text-right">RMSE</TH>
            <TH className="text-right">Rank corr</TH><TH className="text-right">Cap T3 hit</TH>
          </THead>
          <tbody>
            {runs.map((r: any) => {
              const s = r.summary ?? {};
              return (
                <TR key={r.id}>
                  <TD>{r.name}</TD>
                  <TD className="text-xs text-ink-muted">{r.started_at?.toString?.().slice(0,19)}</TD>
                  <TD className="text-xs text-ink-muted">{r.finished_at?.toString?.().slice(0,19) ?? '—'}</TD>
                  <TD className="text-right font-mono">{s.mae?.toFixed?.(3) ?? '—'}</TD>
                  <TD className="text-right font-mono">{s.rmse?.toFixed?.(3) ?? '—'}</TD>
                  <TD className="text-right font-mono">{s.rank_correlation?.toFixed?.(3) ?? '—'}</TD>
                  <TD className="text-right font-mono">{s.captain_top3_hit?.toFixed?.(3) ?? '—'}</TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
