'use client';

/**
 * In-page transfer playground.
 *
 * The user picks one player from their squad and one player to bring in.
 * We call the `tryTransfer` server action and render the EV delta over 1/3/6/8
 * GW horizons plus any rule violations (budget, 3-per-club, position).
 *
 * Nothing here writes to manager_picks — it's a sandbox so you can find the
 * trade you want before opening the FPL app.
 */
import { useMemo, useState, useTransition } from 'react';
import { tryTransfer, type WhatIfResult } from '@/app/actions/whatif';
import { Card } from './ui/Card';
import { Badge } from './ui/Badge';

interface SquadMember {
  player_id: number; web_name: string; position: string; team_short: string;
  now_cost: number; selling_price: number | null;
}
interface Candidate {
  player_id: number; web_name: string; team_short: string; now_cost: number; h3: number;
}

export function WhatIfTransfer({
  squad, candidatesByPosition
}: { squad: SquadMember[]; candidatesByPosition: Record<string, Candidate[]> }) {
  const [outId, setOutId] = useState<number | null>(squad[0]?.player_id ?? null);
  const [inId,  setInId]  = useState<number | null>(null);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [pending, startTransition] = useTransition();

  const outPlayer = squad.find(s => s.player_id === outId) ?? null;
  const candidates = outPlayer ? candidatesByPosition[outPlayer.position] ?? [] : [];

  // Reset the incoming player whenever the outgoing position changes.
  const positionKey = outPlayer?.position ?? '';
  useMemo(() => { setInId(null); setResult(null); }, [positionKey]);

  function submit() {
    if (!outId || !inId) return;
    const fd = new FormData();
    fd.set('outId', String(outId));
    fd.set('inId', String(inId));
    startTransition(async () => {
      const r = await tryTransfer(fd);
      setResult(r);
    });
  }

  return (
    <Card
      title="What-if transfer"
      subtitle="Price a hypothetical swap. No changes are submitted to FPL."
    >
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-ink-dim">Sell</span>
          <select
            value={outId ?? ''}
            onChange={e => setOutId(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-2 text-sm font-mono"
          >
            <option value="">— pick from your squad —</option>
            {squad.map(s => (
              <option key={s.player_id} value={s.player_id}>
                {s.position} · {s.web_name} ({s.team_short}) · £{((s.selling_price ?? s.now_cost)/10).toFixed(1)}m
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-ink-dim">Buy</span>
          <select
            value={inId ?? ''}
            onChange={e => setInId(e.target.value ? Number(e.target.value) : null)}
            disabled={!outPlayer}
            className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-2 text-sm font-mono disabled:opacity-50"
          >
            <option value="">{outPlayer ? '— pick a candidate —' : 'pick a player to sell first'}</option>
            {candidates.map(c => (
              <option key={c.player_id} value={c.player_id}>
                {c.web_name} ({c.team_short}) · £{(c.now_cost/10).toFixed(1)}m · 3GW xPts {c.h3.toFixed(1)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={!outId || !inId || pending}
          className="bg-accent-green text-bg px-3 py-2 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Pricing…' : 'Price this swap'}
        </button>
      </div>

      {result?.ok && result.out && result.in && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="steel">{result.out.web_name} ({result.out.team_short})</Badge>
            <span className="text-ink-dim">→</span>
            <Badge tone="blue">{result.in.web_name} ({result.in.team_short})</Badge>
            <Badge tone={result.netCost <= 0 ? 'green' : result.remainingBank >= 0 ? 'amber' : 'red'}>
              net £{(result.netCost/10).toFixed(1)}m · bank after £{(result.remainingBank/10).toFixed(1)}m
            </Badge>
          </div>
          <div className="grid grid-cols-4 gap-2 font-mono text-center">
            <Stat label="EV 1 GW" value={result.ev.h1} />
            <Stat label="EV 3 GW" value={result.ev.h3} accent />
            <Stat label="EV 6 GW" value={result.ev.h6} />
            <Stat label="EV 8 GW" value={result.ev.h8} />
          </div>
          {result.violations.length > 0 && (
            <ul className="text-xs text-accent-red space-y-0.5">
              {result.violations.map((v, i) => <li key={i}>· {v}</li>)}
            </ul>
          )}
          {result.violations.length === 0 && (
            <div className="text-xs text-accent-green">All FPL constraints clear.</div>
          )}
        </div>
      )}
      {result && !result.ok && (
        <p className="mt-3 text-sm text-accent-red">{result.error}</p>
      )}
    </Card>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  const tone = value > 0.6 ? 'text-accent-green' : value < -0.6 ? 'text-accent-red' : 'text-ink';
  return (
    <div className="bg-bg-inset rounded-md py-2">
      <div className={`text-lg ${accent ? 'font-semibold' : ''} ${tone}`}>{value.toFixed(2)}</div>
      <div className="text-[10px] text-ink-dim">{label}</div>
    </div>
  );
}
