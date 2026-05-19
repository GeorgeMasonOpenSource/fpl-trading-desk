import { Badge } from './ui/Badge';
import { SubmitButton } from './SubmitButton';
import { saveIdsOnly, disconnect, refreshNowForm } from '@/app/actions/session';

/**
 * Slim persistent strip at the top of the app showing the connected manager
 * and league. Includes an inline edit form (no JS required) and a "Refresh
 * now" button that re-runs ingestion + recompute server-side.
 */
export function ConnectionBar({
  managerId, leagueId, managerName, lastIngest
}: {
  managerId: number | null;
  leagueId: number | null;
  managerName: string | null;
  lastIngest: string | null;
}) {
  const connected = managerId != null;
  return (
    <div className="bg-bg-raised border-b border-line px-4 py-2 flex items-center gap-3 text-xs flex-wrap">
      <div className="flex items-center gap-2">
        {connected
          ? <Badge tone="green">connected</Badge>
          : <Badge tone="amber">not connected</Badge>}
        <span className="text-ink-muted">Manager</span>
        <span className="font-mono">{connected ? `${managerId}` : '—'}</span>
        {managerName && <span className="text-ink-dim">· {managerName}</span>}
        <span className="text-ink-muted ml-3">League</span>
        <span className="font-mono">{leagueId ?? '—'}</span>
      </div>
      <div className="flex-1" />
      <details className="relative">
        <summary className="list-none cursor-pointer text-ink-muted hover:text-ink select-none">
          edit
        </summary>
        <form
          action={saveIdsOnly}
          className="absolute right-0 mt-2 z-20 bg-bg-card border border-line rounded-card p-3 w-[320px] space-y-2 shadow-xl"
        >
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-ink-dim">Manager ID</span>
            <input
              name="managerId"
              type="number"
              inputMode="numeric"
              defaultValue={managerId ?? ''}
              className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-1 font-mono text-xs"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-ink-dim">League ID</span>
            <input
              name="leagueId"
              type="number"
              inputMode="numeric"
              defaultValue={leagueId ?? ''}
              className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-1 font-mono text-xs"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <SubmitButton variant="secondary" className="!px-2 !py-1 !text-xs">Save</SubmitButton>
          </div>
        </form>
      </details>
      <form action={refreshNowForm}>
        <SubmitButton variant="secondary" className="!px-2 !py-1 !text-xs">Refresh now</SubmitButton>
      </form>
      {connected && (
        <form action={disconnect}>
          <SubmitButton variant="danger" className="!px-2 !py-1 !text-xs">Disconnect</SubmitButton>
        </form>
      )}
      <span className="text-ink-dim font-mono">
        {lastIngest ? `last ingest ${new Date(lastIngest).toISOString().slice(0,16).replace('T',' ')}Z` : 'no data yet'}
      </span>
    </div>
  );
}
