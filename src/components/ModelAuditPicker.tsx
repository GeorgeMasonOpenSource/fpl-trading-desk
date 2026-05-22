'use client';

/**
 * Searchable player picker for the Model Audit page. Filters client-side
 * (the full ~600-player list is light) and navigates to ?q=<web_name> on
 * pick so the server component reloads with the chosen player's audit.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from './ui/Card';

interface PickerPlayer {
  id: number;
  label: string;
  search: string;
}

export function ModelAuditPicker({
  players, gwId, initialQuery
}: {
  players: PickerPlayer[];
  gwId: number;
  initialQuery: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);

  const filtered = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return players
      .filter(p => p.search.includes(q))
      .slice(0, 12);
  }, [query, players]);

  function pickPlayer(label: string) {
    // Extract the web_name (everything before the first space-paren)
    const webName = label.split(' (')[0]!;
    router.push(`/model-audit?q=${encodeURIComponent(webName)}&gw=${gwId}`);
  }

  return (
    <Card title="Pick a player">
      <input
        type="text"
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Type a name (web name, surname, full name)…"
        className="w-full bg-bg-inset border border-line rounded-md px-3 py-2 text-sm font-mono"
      />
      {filtered.length > 0 && (
        <ul className="mt-2 space-y-0.5 max-h-72 overflow-y-auto">
          {filtered.map(p => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => pickPlayer(p.label)}
                className="w-full text-left px-3 py-1.5 rounded hover:bg-bg-inset text-sm font-mono text-ink"
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {query && filtered.length === 0 && (
        <p className="mt-2 text-sm text-ink-muted">No matches.</p>
      )}
    </Card>
  );
}
