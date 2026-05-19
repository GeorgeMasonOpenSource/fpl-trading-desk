import { Card } from './ui/Card';
import { SubmitButton } from './SubmitButton';
import { addOverrideForm } from '@/app/actions/overrides';

const KIND_PRESETS = [
  { kind: 'availability',  example: '{"expected":"out"}',               note: 'Mark a player as expected to miss the match.' },
  { kind: 'minutes_cap',   example: '{"cap":60}',                       note: 'Cap expected minutes (manager said 60 max on return).' },
  { kind: 'penalty_taker', example: '{"share":0.95}',                   note: 'Confirm penalty share for the upcoming GW.' },
  { kind: 'set_piece',     example: '{"share":0.6,"type":"corners"}',   note: 'Set-piece share (corners / direct FKs).' },
  { kind: 'role',          example: '{"role":"LW","role_type":"primary"}', note: 'Override the role matrix for a player.' },
  { kind: 'rotation',      example: '{"likely":true,"reason":"pre-UCL"}', note: 'Flag likely rotation ahead of a European fixture.' }
];

export function OverrideForm() {
  return (
    <Card title="Add a manual override" subtitle="Structured factual overrides only. Never opinion-based recommendations.">
      <form action={addOverrideForm} className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-ink-dim">Scope</span>
            <select
              name="scope"
              defaultValue="player"
              className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-2 text-sm font-mono"
            >
              <option value="player">player</option>
              <option value="team">team</option>
              <option value="fixture">fixture</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-ink-dim">Scope ID</span>
            <input
              name="scopeId" type="number" inputMode="numeric" required
              placeholder="player_id / team_id / fixture_id"
              className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-2 text-sm font-mono"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-ink-dim">Kind</span>
            <input
              name="kind" required
              list="kind-presets"
              placeholder="e.g. minutes_cap"
              className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-2 text-sm font-mono"
            />
            <datalist id="kind-presets">
              {KIND_PRESETS.map(p => <option key={p.kind} value={p.kind} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-widest text-ink-dim">Reason (optional)</span>
            <input
              name="reason"
              placeholder="presser link, training report, etc."
              className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-2 text-sm"
            />
          </label>
        </div>
        <label className="block">
          <span className="text-[10px] uppercase tracking-widest text-ink-dim">Value (JSON)</span>
          <input
            name="value" required
            placeholder='{"cap":60}'
            className="mt-1 w-full bg-bg-inset border border-line rounded-md px-2 py-2 text-sm font-mono"
          />
        </label>
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer text-ink-dim hover:text-ink">Examples</summary>
          <ul className="mt-2 space-y-1">
            {KIND_PRESETS.map(p => (
              <li key={p.kind} className="font-mono">
                <span className="text-accent-violet">{p.kind}</span>{' '}
                <span className="text-ink">{p.example}</span>{' '}
                <span className="text-ink-dim">— {p.note}</span>
              </li>
            ))}
          </ul>
        </details>
        <div className="flex justify-end">
          <SubmitButton>Add override</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
