'use client';
import { selectLeague, type MyLeague } from '@/app/actions/leagues';

/**
 * Dropdown of every league the connected manager belongs to. Submits via
 * a server action — no client-side fetch, no JSON wrangling. The currently
 * active league is highlighted; switching reloads the war room view.
 */
export function LeaguePicker({ leagues, activeLeagueId }: {
  leagues: MyLeague[];
  activeLeagueId: number | null;
}) {
  if (leagues.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No leagues found yet. Run <span className="font-mono">db:seed</span> or
        hit <span className="font-mono">Refresh now</span> to auto-pull them
        from FPL.
      </p>
    );
  }
  return (
    <form action={selectLeague} className="flex items-center gap-2 flex-wrap">
      <label className="text-xs uppercase tracking-widest text-ink-dim">Active league</label>
      <select
        name="leagueId"
        defaultValue={activeLeagueId ?? ''}
        className="bg-bg-inset border border-line rounded-md px-2 py-1 text-sm font-mono min-w-[280px]"
      >
        <option value="">— pick a league —</option>
        {leagues.map(l => (
          <option key={l.leagueId} value={l.leagueId}>
            {l.name} {l.entryRank ? `· #${l.entryRank}` : ''} {l.scoring === 'h' ? ' (H2H)' : ''}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="bg-accent-green/90 hover:bg-accent-green text-bg px-3 py-1 rounded-md text-sm font-medium"
      >
        Switch
      </button>
    </form>
  );
}
