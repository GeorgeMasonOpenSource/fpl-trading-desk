import { teamColour } from '@/lib/util/colours';
import { fmt, n } from '@/lib/util/fmt';
import type { AutoPickResult, AutoPickInput } from '@/lib/pick/autoPick';

/**
 * Pitch-view renderer. Lays out the auto-picked XI on a 4-row grid (GK, DEF,
 * MID, FWD) over a generic football pitch SVG, with bench listed below. No
 * official club assets — jerseys are abstract two-colour blocks derived from
 * the team palette in lib/util/colours.
 */
export function PitchView<T extends AutoPickInput>({ picked, planningLabel }: {
  picked: AutoPickResult<T>;
  planningLabel: string;
}) {
  const starters = picked.starters;
  const gk  = starters.filter(s => s.player.pos === 'GKP');
  const def = starters.filter(s => s.player.pos === 'DEF');
  const mid = starters.filter(s => s.player.pos === 'MID');
  const fwd = starters.filter(s => s.player.pos === 'FWD');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
      <div className="relative overflow-hidden rounded-card border border-line bg-bg-card">
        <Pitch />
        <div className="absolute inset-0 grid grid-rows-4 gap-2 px-4 py-6">
          <PitchRow players={gk}  />
          <PitchRow players={def} />
          <PitchRow players={mid} />
          <PitchRow players={fwd} />
        </div>
        <div className="absolute top-3 left-4 text-[11px] uppercase tracking-widest text-white/80 font-mono drop-shadow">
          Auto XI · {planningLabel}
        </div>
        <div className="absolute top-3 right-4 text-right text-white/90 drop-shadow">
          <div className="font-mono text-lg leading-none">{fmt(picked.totalXpts, 1)}</div>
          <div className="text-[10px] uppercase tracking-widest">total xPts</div>
        </div>
        <div className="absolute bottom-3 left-4 text-[11px] font-mono text-white/70 drop-shadow">
          Formation {picked.formation.def}-{picked.formation.mid}-{picked.formation.fwd}
          {' · '}captain doubled
        </div>
      </div>

      <aside className="bg-bg-card border border-line rounded-card p-3 space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-dim">Starting XI</div>
          <ol className="mt-2 space-y-1">
            {[...starters].sort((a, b) => b.player.xpts_total - a.player.xpts_total).map((s, i) => (
              <StackedRow key={s.player.player_id} idx={i + 1} pick={s} />
            ))}
          </ol>
        </div>
        <div className="pt-2 border-t border-line">
          <div className="text-[10px] uppercase tracking-widest text-ink-dim">Bench (auto-sub order)</div>
          <ol className="mt-2 space-y-1">
            {picked.bench.map((b, i) => (
              <StackedRow key={b.player.player_id} idx={i + 1} pick={b} />
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}

function PitchRow<T extends AutoPickInput>({ players }: {
  players: { player: T; isCaptain: boolean; isVice: boolean }[]
}) {
  return (
    <div className="flex items-center justify-around gap-2">
      {players.map(p => (
        <PitchPlayer key={p.player.player_id} pick={p} />
      ))}
    </div>
  );
}

function PitchPlayer<T extends AutoPickInput>({ pick }: {
  pick: { player: T; isCaptain: boolean; isVice: boolean }
}) {
  const c = teamColour(pick.player.team_short);
  return (
    <div className="relative flex flex-col items-center gap-1 min-w-[78px]">
      {(pick.isCaptain || pick.isVice) && (
        <span
          className={`absolute -top-1 -left-1 w-5 h-5 rounded-full text-[10px] font-mono font-bold flex items-center justify-center ring-2 ring-white/40 ${
            pick.isCaptain ? 'bg-yellow-400 text-black' : 'bg-white/90 text-black'
          }`}
          aria-label={pick.isCaptain ? 'Captain' : 'Vice-captain'}
        >
          {pick.isCaptain ? 'C' : 'V'}
        </span>
      )}
      <Jersey primary={c.primary} secondary={c.secondary} />
      <div className="bg-black/60 backdrop-blur px-1.5 py-0.5 rounded text-center min-w-[68px]">
        <div className="text-[11px] font-semibold text-white leading-tight truncate max-w-[78px]">
          {pick.player.web_name}
        </div>
        <div className="text-[10px] text-white/70 leading-tight font-mono">
          {fmt(pick.player.xpts_total, 1)} xPts
        </div>
        <div className="text-[9px] text-white/60 leading-tight font-mono">
          {Math.round(n(pick.player.expected_minutes))}′ · {pick.player.team_short}
        </div>
      </div>
    </div>
  );
}

function Jersey({ primary, secondary }: { primary: string; secondary: string }) {
  // Generic, abstract jersey silhouette. No real kit / sponsor / logo / badge.
  // Sleeves stay the secondary colour as a visual hook so two players from the
  // same club look identical and two from different clubs look distinct.
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <path
        d="M9 8 L14 5 L17 7 Q20 9 23 7 L26 5 L31 8 L34 11 L31 14 L29 13 L29 32 Q29 34 27 34 L13 34 Q11 34 11 32 L11 13 L9 14 L6 11 Z"
        fill={primary}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth="0.8"
      />
      {/* sleeves accent */}
      <path d="M9 8 L6 11 L9 14 L11 13 L11 11 Z" fill={secondary} opacity="0.85" />
      <path d="M31 8 L34 11 L31 14 L29 13 L29 11 Z" fill={secondary} opacity="0.85" />
      {/* collar V */}
      <path d="M17 7 Q20 9 23 7 L22 11 Q20 12 18 11 Z" fill={secondary} opacity="0.7" />
    </svg>
  );
}

function StackedRow<T extends AutoPickInput>({ idx, pick }: {
  idx: number;
  pick: { player: T; isCaptain: boolean; isVice: boolean }
}) {
  const c = teamColour(pick.player.team_short);
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="w-4 text-[10px] text-ink-dim font-mono text-right">{idx}</span>
      <span
        className="inline-block w-2 h-4 rounded-sm"
        style={{ background: `linear-gradient(180deg, ${c.primary}, ${c.secondary})` }}
        aria-hidden="true"
      />
      <span className="font-medium truncate flex-1">{pick.player.web_name}</span>
      <span className="text-[10px] text-ink-dim font-mono">{pick.player.pos}</span>
      <span className="font-mono text-xs w-12 text-right">{fmt(pick.player.xpts_total, 1)}</span>
      {pick.isCaptain && (
        <span className="text-[9px] font-mono bg-yellow-400 text-black px-1 rounded">C</span>
      )}
      {pick.isVice && (
        <span className="text-[9px] font-mono bg-white/90 text-black px-1 rounded">V</span>
      )}
    </li>
  );
}

function Pitch() {
  // Abstract green-tone pitch. No real club ground / sponsor.
  return (
    <svg viewBox="0 0 400 600" preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
      <defs>
        <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d3b22" />
          <stop offset="50%" stopColor="#0a3320" />
          <stop offset="100%" stopColor="#082c1c" />
        </linearGradient>
        <pattern id="stripes" patternUnits="userSpaceOnUse" width="400" height="60">
          <rect x="0" y="0" width="400" height="60" fill="url(#grass)" />
          <rect x="0" y="30" width="400" height="30" fill="rgba(255,255,255,0.025)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="400" height="600" fill="url(#stripes)" />
      {/* outer box */}
      <rect x="14" y="14" width="372" height="572" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" />
      {/* halfway line + centre circle */}
      <line x1="14" y1="300" x2="386" y2="300" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <circle cx="200" cy="300" r="48" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      {/* top box */}
      <rect x="110" y="14" width="180" height="78" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <rect x="155" y="14" width="90"  height="30" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      {/* bottom box */}
      <rect x="110" y="508" width="180" height="78" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      <rect x="155" y="556" width="90"  height="30" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
    </svg>
  );
}
