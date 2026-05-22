'use client';

/**
 * Side-by-side "before / after" view for a proposed transfer set.
 *
 * The user clicks a suggested transfer (LP plan recommendation or a row
 * from the top-10 ranker). This component shows the full 15-player squad
 * with the outgoing players struck-through in red and the incoming players
 * highlighted in green, so the user can visualise what their team would
 * look like after pulling the trigger.
 *
 * Pure client component — no server roundtrip. All player data is passed
 * in from the parent, which is a server component that already loads the
 * squad + candidates. State here is just "which transfer suggestion is
 * currently selected".
 *
 * Reusable for both the LP plan card and the Top-10 list — both pass the
 * same shape: { transfersOut, transfersIn } where each side is a tagged
 * player object.
 */
import { useState } from 'react';
import { Card } from './ui/Card';
import { Badge } from './ui/Badge';

export interface PreviewPlayer {
  playerId: number;
  webName: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  teamShort: string;
  cost: number;          // tenths
  sellingPrice?: number; // tenths — owned players only
  xptsPerGw: number;
}

export interface PreviewSwap {
  /** Display label, e.g. "LP optimal · GW38" or "#1 Gyökeres → Bowen". */
  label: string;
  transfersOut: PreviewPlayer[];
  transfersIn: PreviewPlayer[];
  /** Optional metrics surfaced under the title. */
  metrics?: { label: string; value: string; tone?: 'green' | 'amber' | 'red' | 'steel' }[];
}

interface Props {
  currentSquad: PreviewPlayer[];
  swaps: PreviewSwap[];
  /** index of the swap to show initially. Default 0 (the first). */
  defaultSelected?: number;
}

export function TransferPreview({ currentSquad, swaps, defaultSelected = 0 }: Props) {
  const [selected, setSelected] = useState(defaultSelected);
  const swap = swaps[selected] ?? swaps[0];

  if (!swap) {
    return (
      <Card title="Transfer preview">
        <p className="text-sm text-ink-muted">No transfers to preview — your squad is optimal.</p>
      </Card>
    );
  }

  // Build the "after" squad: drop the OUT players, add the IN players.
  const outIds = new Set(swap.transfersOut.map(p => p.playerId));
  const kept = currentSquad.filter(p => !outIds.has(p.playerId));
  const incoming = swap.transfersIn;
  const afterSquad = [...kept, ...incoming].sort((a, b) =>
    positionOrder(a.position) - positionOrder(b.position) ||
    b.xptsPerGw - a.xptsPerGw
  );

  // Totals
  const beforeTotal = currentSquad.reduce((s, p) => s + p.xptsPerGw, 0);
  const afterTotal  = afterSquad.reduce((s, p) => s + p.xptsPerGw, 0);
  const ownedSellRev = swap.transfersOut.reduce(
    (s, p) => s + (p.sellingPrice ?? p.cost), 0
  );
  const buyCost = incoming.reduce((s, p) => s + p.cost, 0);
  const netSpend = buyCost - ownedSellRev;

  return (
    <Card
      title="Transfer preview"
      subtitle="See exactly which players move in and out of your 15. No changes are submitted to FPL."
    >
      {/* Swap picker — only shown when there's more than one suggestion */}
      {swaps.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {swaps.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSelected(i)}
              className={`text-xs font-mono px-3 py-1.5 rounded border ${
                i === selected
                  ? 'bg-accent-green text-bg border-accent-green'
                  : 'bg-bg-inset text-ink-muted border-line hover:bg-bg-card hover:text-ink'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div className="text-sm font-medium mb-1">{swap.label}</div>

      {/* Metrics row */}
      {swap.metrics && swap.metrics.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {swap.metrics.map((m, i) => (
            <Badge key={i} tone={m.tone ?? 'steel'}>
              {m.label}: {m.value}
            </Badge>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* BEFORE */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-widest text-ink-dim">Current 15</div>
            <div className="font-mono text-xs text-ink-muted">
              {beforeTotal.toFixed(1)} xPts/GW
            </div>
          </div>
          <PositionGroup
            label="GKP"
            players={currentSquad.filter(p => p.position === 'GKP')}
            outIds={outIds}
            highlightOut
          />
          <PositionGroup
            label="DEF"
            players={currentSquad.filter(p => p.position === 'DEF')}
            outIds={outIds}
            highlightOut
          />
          <PositionGroup
            label="MID"
            players={currentSquad.filter(p => p.position === 'MID')}
            outIds={outIds}
            highlightOut
          />
          <PositionGroup
            label="FWD"
            players={currentSquad.filter(p => p.position === 'FWD')}
            outIds={outIds}
            highlightOut
          />
        </div>

        {/* AFTER */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-widest text-ink-dim">After this transfer</div>
            <div className="font-mono text-xs">
              <span className={afterTotal > beforeTotal ? 'text-accent-green' : afterTotal < beforeTotal ? 'text-accent-red' : 'text-ink-muted'}>
                {afterTotal.toFixed(1)} xPts/GW
                {' '}
                ({afterTotal >= beforeTotal ? '+' : ''}{(afterTotal - beforeTotal).toFixed(2)})
              </span>
            </div>
          </div>
          <PositionGroup
            label="GKP"
            players={afterSquad.filter(p => p.position === 'GKP')}
            incomingIds={new Set(incoming.map(p => p.playerId))}
            highlightIn
          />
          <PositionGroup
            label="DEF"
            players={afterSquad.filter(p => p.position === 'DEF')}
            incomingIds={new Set(incoming.map(p => p.playerId))}
            highlightIn
          />
          <PositionGroup
            label="MID"
            players={afterSquad.filter(p => p.position === 'MID')}
            incomingIds={new Set(incoming.map(p => p.playerId))}
            highlightIn
          />
          <PositionGroup
            label="FWD"
            players={afterSquad.filter(p => p.position === 'FWD')}
            incomingIds={new Set(incoming.map(p => p.playerId))}
            highlightIn
          />
        </div>
      </div>

      {/* Money */}
      <div className="mt-4 pt-3 border-t border-line flex flex-wrap items-center gap-4 text-xs font-mono">
        <span className="text-ink-muted">
          Sell revenue: <span className="text-ink">£{(ownedSellRev / 10).toFixed(1)}m</span>
        </span>
        <span className="text-ink-muted">
          Buy cost: <span className="text-ink">£{(buyCost / 10).toFixed(1)}m</span>
        </span>
        <span className="text-ink-muted">
          Net spend:{' '}
          <span className={netSpend > 0 ? 'text-accent-amber' : 'text-accent-green'}>
            {netSpend === 0 ? '£0.0m' : `${netSpend > 0 ? '-' : '+'}£${(Math.abs(netSpend) / 10).toFixed(1)}m`}
          </span>
        </span>
      </div>
    </Card>
  );
}

function PositionGroup({
  label, players, outIds, incomingIds, highlightOut, highlightIn
}: {
  label: string;
  players: PreviewPlayer[];
  outIds?: Set<number>;
  incomingIds?: Set<number>;
  highlightOut?: boolean;
  highlightIn?: boolean;
}) {
  if (players.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="text-[10px] uppercase tracking-widest text-ink-dim mb-1">{label}</div>
      <div className="space-y-1">
        {players.map(p => {
          const isOut = highlightOut && outIds?.has(p.playerId);
          const isIn  = highlightIn  && incomingIds?.has(p.playerId);
          const rowClass = isOut
            ? 'bg-accent-red/10 border-accent-red/40 text-accent-red line-through'
            : isIn
              ? 'bg-accent-green/10 border-accent-green/40'
              : 'bg-bg-card border-line';
          return (
            <div key={p.playerId} className={`flex items-center justify-between px-3 py-1.5 border rounded ${rowClass}`}>
              <div className="flex items-center gap-2">
                {isOut && <span className="text-[10px] uppercase tracking-widest font-mono">OUT</span>}
                {isIn  && <span className="text-[10px] uppercase tracking-widest text-accent-green font-mono">IN</span>}
                <span className="font-medium">{p.webName}</span>
                <span className="text-[10px] text-ink-dim font-mono">
                  · {p.teamShort} · £{((p.sellingPrice ?? p.cost) / 10).toFixed(1)}m
                </span>
              </div>
              <span className={`font-mono text-xs ${isIn ? 'text-accent-green' : isOut ? '' : 'text-ink-muted'}`}>
                {p.xptsPerGw.toFixed(2)}/GW
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function positionOrder(p: 'GKP'|'DEF'|'MID'|'FWD'): number {
  return p === 'GKP' ? 0 : p === 'DEF' ? 1 : p === 'MID' ? 2 : 3;
}
