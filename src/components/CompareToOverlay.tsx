'use client';

/**
 * "Compare to" overlay — paste a competitor suggestion (FPL Review, FPL Harry,
 * any creator) and see the same EV decomposition our model assigns to that
 * swap. Side-by-side with the planner's top-1 it answers
 *
 *   "why does the model disagree with FPL Review?"
 *
 * The component holds local form state and calls `priceCompareSwap`. The
 * server action handles ambiguity (e.g. "Williams" matches multiple players)
 * by returning a list of candidates; we render them as clickable chips that
 * resubmit with the disambiguating web_name.
 */
import { useState, useTransition } from 'react';
import { priceCompareSwap } from '@/app/actions/compare-swap';
import type { CompareSwapResult } from '@/app/actions/compare-swap.types';
import { EvDecompositionBar } from './EvDecompositionBar';
import { fmt } from '@/lib/util/fmt';

interface CompareToOverlayProps {
  /** Top-1 transfer from the planner, used as the reference comparison. */
  reference?: {
    label: string;          // e.g. "Anderson → Mbeumo (our #1)"
    netEv: number;
  };
}

export function CompareToOverlay({ reference }: CompareToOverlayProps) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<CompareSwapResult | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(query: string) {
    const fd = new FormData();
    fd.set('swap', query);
    startTransition(async () => {
      const r = await priceCompareSwap(fd);
      setResult(r);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <label className="block flex-1">
          <span className="text-[10px] uppercase tracking-widest text-ink-dim">
            Paste a competitor suggestion
          </span>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder='e.g. "FPL Review: Gyökeres → Bowen"'
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(input); } }}
            className="mt-1 w-full bg-bg-inset border border-line rounded-md px-3 py-2 text-sm font-mono"
          />
        </label>
        <button
          type="button"
          onClick={() => submit(input)}
          disabled={!input.trim() || pending}
          className="bg-accent-blue text-bg px-3 py-2 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? 'Scoring…' : 'Compare'}
        </button>
      </div>

      <p className="text-[11px] text-ink-dim">
        Accepts <code className="font-mono text-ink">A → B</code>,{' '}
        <code className="font-mono text-ink">A to B</code>, or a labelled form like{' '}
        <code className="font-mono text-ink">FPL Review: A → B</code>. Names are matched
        against your players table (web name, surname, or full name).
      </p>

      {result && !result.ok && (
        <div className="bg-bg-inset border border-accent-red/40 rounded-md p-3 space-y-2 text-sm">
          <div className="text-accent-red font-medium">Couldn&apos;t price this swap</div>
          <div className="text-ink-muted">{result.error}</div>
          {result.ambiguities && result.ambiguities.length > 0 && (
            <div className="space-y-2 pt-1">
              {result.ambiguities.map(a => (
                <div key={a.query} className="text-xs">
                  <div className="text-ink-dim">Did you mean (for &ldquo;{a.query}&rdquo;):</div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {a.candidates.map(c => (
                      <button
                        key={c.playerId}
                        onClick={() => {
                          // Re-submit with this exact web_name swapped in.
                          // Replace the ambiguous token in the original input
                          // with the candidate's unique web_name + team_short.
                          const replaced = input.replace(
                            new RegExp(a.query, 'i'),
                            `${c.webName} (${c.teamShort})`
                          );
                          setInput(replaced);
                          submit(replaced);
                        }}
                        className="bg-bg-card hover:bg-bg-raised border border-line rounded px-2 py-0.5 text-[11px] font-mono"
                      >
                        {c.webName} <span className="text-ink-dim">{c.position}·{c.teamShort}·£{(c.nowCost/10).toFixed(1)}m</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {result?.ok && result.delta && result.outResolved && result.inResolved && (
        <div className="bg-bg-inset border border-line rounded-md p-3 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="font-medium">
              {result.source && (
                <span className="text-ink-dim mr-1.5">{result.source}:</span>
              )}
              <span>{result.outResolved.webName}</span>
              <span className="mx-1.5 text-ink-dim">→</span>
              <span>{result.inResolved.webName}</span>
              <span className="ml-2 text-[10px] text-ink-dim font-mono">
                {result.outResolved.position} · {result.outResolved.teamShort}
                {' → '}
                {result.inResolved.position} · {result.inResolved.teamShort}
              </span>
            </div>
            <div className="text-xs font-mono">
              <span className={(result.netEv ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}>
                model says: {(result.netEv ?? 0) >= 0 ? '+' : ''}{fmt(result.netEv, 2)} EV
              </span>
              {reference && (
                <span className="ml-2 text-ink-dim">
                  vs our top: {reference.netEv >= 0 ? '+' : ''}{fmt(reference.netEv, 2)} EV
                  ({result.netEv != null && result.netEv > reference.netEv ? 'better' :
                    result.netEv != null && Math.abs(result.netEv - reference.netEv) < 0.1 ? 'tied' :
                    'worse'})
                </span>
              )}
            </div>
          </div>
          <EvDecompositionBar delta={result.delta} perGw={result.perGw} />
        </div>
      )}
    </div>
  );
}
