'use client';

/**
 * Team picker + pitch view for the Predicted Lineups page.
 *
 * Client component because:
 *   - The team selection lives in client state (no need to round-trip a
 *     server action just to change which team is shown)
 *   - The predicted XI is the same for everyone — no per-user data, so
 *     we pre-render every team's XI server-side and just toggle visibility
 *
 * Each team renders as:
 *   - kickoff line + fixture (HOME vs AWAY)
 *   - pitch with 11 jerseys grouped by row (GK / DEF / MID / FWD)
 *   - bench: 5 most-likely subs
 *   - confidence badge: CONFIRMED (FotMob has published) or PREDICTED
 */
import { useState } from 'react';
import { Card } from './ui/Card';
import { Badge } from './ui/Badge';
import { teamColour } from '@/lib/util/colours';

interface Player {
  player_id: number;
  web_name: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  team_id: number;
  expected_minutes: number;
  start_prob: number;
  sixty_plus_prob: number;
  status: string;
  chance_of_playing_next_round: number | null;
  xpts: number;
}

interface Predicted {
  teamId: number;
  teamName: string;
  teamShort: string;
  opponentShort: string;
  isHome: boolean;
  kickoffTime: string | null;
  starters: Player[];
  bench: Player[];
}

export function TeamLineupPicker({ predicted }: { predicted: Predicted[] }) {
  const [selectedTeamId, setSelectedTeamId] = useState<number>(
    predicted[0]?.teamId ?? 0
  );
  const current = predicted.find(p => p.teamId === selectedTeamId) ?? predicted[0];

  if (!current) {
    return (
      <Card title="No fixtures">
        <p className="text-sm text-ink-muted">No upcoming fixtures found.</p>
      </Card>
    );
  }

  const isConfirmed = current.starters.length > 0 &&
    current.starters.every(p => p.start_prob >= 0.99);

  return (
    <div className="space-y-4">
      {/* Team tabs — horizontally scrollable on mobile, wrapping on desktop. */}
      <div className="flex flex-wrap gap-1.5">
        {predicted.map(p => {
          const c = teamColour(p.teamShort);
          const isActive = p.teamId === selectedTeamId;
          return (
            <button
              key={p.teamId}
              type="button"
              onClick={() => setSelectedTeamId(p.teamId)}
              className={`text-xs font-mono px-3 py-1.5 rounded border transition-colors ${
                isActive
                  ? 'border-accent-green text-ink bg-bg-card'
                  : 'border-line text-ink-muted bg-bg-inset hover:bg-bg-card hover:text-ink'
              }`}
              style={isActive ? { borderColor: c.primary } : undefined}
            >
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                style={{ background: c.primary }}
              />
              {p.teamShort}
            </button>
          );
        })}
      </div>

      {/* Header: fixture + confidence */}
      <Card
        title={`${current.teamName} ${current.isHome ? 'vs' : '@'} ${current.opponentShort}`}
        subtitle={current.kickoffTime
          ? `Kickoff: ${formatKickoff(current.kickoffTime)}`
          : 'Kickoff TBC'}
        action={
          <Badge tone={isConfirmed ? 'green' : 'steel'}>
            {isConfirmed ? 'CONFIRMED XI' : 'PREDICTED'}
          </Badge>
        }
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
          {/* Pitch */}
          <div className="relative overflow-hidden rounded-card border border-line bg-bg-card aspect-[3/4] lg:aspect-[2/3]">
            <Pitch />
            <PitchLayout players={current.starters} teamShort={current.teamShort} />
            <div className="absolute top-3 left-4 text-[11px] uppercase tracking-widest text-white/80 font-mono drop-shadow">
              Predicted XI · {current.teamShort}
            </div>
            <div className="absolute top-3 right-4 text-right text-white/90 drop-shadow">
              <div className="font-mono text-lg leading-none">
                {current.starters.reduce((s, p) => s + Number(p.expected_minutes), 0).toFixed(0)}′
              </div>
              <div className="text-[10px] uppercase tracking-widest">total mins</div>
            </div>
          </div>

          {/* Side panel: starters + bench */}
          <aside className="bg-bg-card border border-line rounded-card p-3 space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-ink-dim">Starting XI</div>
              <ol className="mt-2 space-y-1">
                {current.starters.map((p, i) => (
                  <PlayerRow key={p.player_id} idx={i + 1} player={p} />
                ))}
              </ol>
            </div>
            <div className="pt-2 border-t border-line">
              <div className="text-[10px] uppercase tracking-widest text-ink-dim">Bench (most likely subs)</div>
              <ol className="mt-2 space-y-1">
                {current.bench.map((p, i) => (
                  <PlayerRow key={p.player_id} idx={i + 1} player={p} bench />
                ))}
              </ol>
            </div>
          </aside>
        </div>
      </Card>
    </div>
  );
}

function PitchLayout({ players, teamShort }: { players: Player[]; teamShort: string }) {
  const gk  = players.filter(p => p.position === 'GKP');
  const def = players.filter(p => p.position === 'DEF');
  const mid = players.filter(p => p.position === 'MID');
  const fwd = players.filter(p => p.position === 'FWD');
  return (
    <div className="absolute inset-0 grid grid-rows-4 gap-2 px-4 py-6">
      <PitchRow players={gk}  teamShort={teamShort} />
      <PitchRow players={def} teamShort={teamShort} />
      <PitchRow players={mid} teamShort={teamShort} />
      <PitchRow players={fwd} teamShort={teamShort} />
    </div>
  );
}

function PitchRow({ players, teamShort }: { players: Player[]; teamShort: string }) {
  return (
    <div className="flex items-center justify-around gap-2">
      {players.map(p => (
        <PitchPlayer key={p.player_id} player={p} teamShort={teamShort} />
      ))}
    </div>
  );
}

function PitchPlayer({ player, teamShort }: { player: Player; teamShort: string }) {
  const c = teamColour(teamShort);
  const mins = Math.round(Number(player.expected_minutes));
  const isConfirmed = Number(player.start_prob) >= 0.99;
  return (
    <div className="relative flex flex-col items-center gap-1 min-w-[72px]">
      {isConfirmed && (
        <span
          className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent-green ring-2 ring-bg-card"
          title="Confirmed in XI"
          aria-label="Confirmed"
        />
      )}
      <Jersey primary={c.primary} secondary={c.secondary} />
      <div className="bg-black/65 backdrop-blur px-1.5 py-0.5 rounded text-center min-w-[64px]">
        <div className="text-[11px] font-semibold text-white leading-tight truncate max-w-[78px]">
          {player.web_name}
        </div>
        <div className="text-[10px] text-white/80 leading-tight font-mono">
          {mins}′ · {player.position}
        </div>
      </div>
    </div>
  );
}

function PlayerRow({ idx, player, bench }: { idx: number; player: Player; bench?: boolean }) {
  const isConfirmed = Number(player.start_prob) >= 0.99;
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="w-4 text-[10px] text-ink-dim font-mono text-right">{idx}</span>
      <span
        className={`inline-block w-2 h-2 rounded-full ${
          isConfirmed ? 'bg-accent-green' : 'bg-ink-dim'
        }`}
        aria-hidden="true"
      />
      <span className={`font-medium truncate flex-1 ${bench ? 'text-ink-muted' : ''}`}>
        {player.web_name}
      </span>
      <span className="text-[10px] text-ink-dim font-mono w-8">{player.position}</span>
      <span className="font-mono text-xs w-10 text-right">
        {Math.round(Number(player.expected_minutes))}′
      </span>
      <span className="font-mono text-xs w-10 text-right text-ink-muted">
        {Number(player.xpts).toFixed(1)}
      </span>
    </li>
  );
}

function Jersey({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <svg viewBox="0 0 40 44" width="34" height="38" aria-hidden="true">
      <defs>
        <linearGradient id={`g-${primary}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={primary} />
          <stop offset="100%" stopColor={secondary} />
        </linearGradient>
      </defs>
      <path
        d="M5 6 L13 2 L17 6 L23 6 L27 2 L35 6 L33 14 L28 12 L28 40 L12 40 L12 12 L7 14 Z"
        fill={`url(#g-${primary})`}
        stroke="rgba(0,0,0,0.4)"
        strokeWidth="0.75"
      />
    </svg>
  );
}

function Pitch() {
  return (
    <svg viewBox="0 0 400 600" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
      <defs>
        <linearGradient id="grass2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d3b22" />
          <stop offset="50%" stopColor="#0a3320" />
          <stop offset="100%" stopColor="#082c1c" />
        </linearGradient>
        <pattern id="stripes2" patternUnits="userSpaceOnUse" width="400" height="60">
          <rect x="0" y="0" width="400" height="60" fill="url(#grass2)" />
          <rect x="0" y="30" width="400" height="30" fill="rgba(255,255,255,0.025)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="400" height="600" fill="url(#stripes2)" />
      <rect x="14" y="14" width="372" height="572" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" />
      <line x1="14" y1="300" x2="386" y2="300" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <circle cx="200" cy="300" r="48" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <rect x="110" y="14" width="180" height="78" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <rect x="155" y="14" width="90" height="30" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <rect x="110" y="508" width="180" height="78" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <rect x="155" y="556" width="90" height="30" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
    </svg>
  );
}

function formatKickoff(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch {
    return iso;
  }
}
