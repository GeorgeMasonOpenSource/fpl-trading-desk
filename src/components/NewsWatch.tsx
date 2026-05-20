import { Card } from './ui/Card';
import { Badge } from './ui/Badge';

/**
 * News watch — surfaces every squad player flagged by FPL's official feed.
 * Sourced from players.news + chance_of_playing_next_round (populated on
 * every bootstrap fetch). No scraping; deterministic; same data the YouTube
 * creators are reading from upstream.
 *
 * The point: see the official red flag the moment FPL publishes it, then
 * (optionally) open the Manual Overrides page to lock in your interpretation.
 */
export interface NewsItem {
  player_id: number;
  web_name: string;
  team_short: string;
  position: string;
  status: string;
  news: string | null;
  news_added_at: string | null;
  chance_of_playing_next_round: number | null;
  chance_of_playing_this_round: number | null;
  owned: boolean;          // is this player in the user's squad?
}

export function NewsWatch({ items }: { items: NewsItem[] }) {
  if (items.length === 0) {
    return (
      <Card title="Squad news watch">
        <p className="text-sm text-ink-muted">
          No injury or availability flags on any of your players. FPL hasn't
          published anything concerning for your 15.
        </p>
      </Card>
    );
  }
  return (
    <Card
      title="Squad news watch"
      subtitle="Official FPL news + chance-of-playing. Click 'Add override' on any player to lock in your interpretation."
    >
      <ul className="space-y-2 text-sm">
        {items.map(p => {
          const chance = p.chance_of_playing_next_round;
          const tone =
            chance == null ? 'amber' :
            chance >= 75 ? 'green' :
            chance >= 25 ? 'amber' :
            'red';
          const borderTone =
            tone === 'red' ? 'border-l-accent-red' :
            tone === 'amber' ? 'border-l-accent-amber' :
            'border-l-accent-green';
          return (
            <li
              key={p.player_id}
              className={`bg-bg-inset border border-line border-l-4 ${borderTone} rounded-md p-3`}
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold">{p.web_name}</span>
                  <span className="text-[11px] text-ink-dim font-mono">
                    {p.position} · {p.team_short}
                  </span>
                  {p.owned && <Badge tone="blue">in squad</Badge>}
                  <Badge tone={tone as any}>
                    {chance == null ? `status: ${p.status}` : `${chance}% chance`}
                  </Badge>
                </div>
                {p.news_added_at && (
                  <span className="text-[10px] text-ink-dim font-mono">
                    {new Date(p.news_added_at).toLocaleString()}
                  </span>
                )}
              </div>
              {p.news && (
                <p className="text-xs text-ink-muted mt-1 leading-snug">{p.news}</p>
              )}
              <div className="mt-2 flex gap-2 text-[10px]">
                <a
                  href={`/manual-overrides?player_id=${p.player_id}`}
                  className="text-accent-blue hover:underline"
                >
                  Add override →
                </a>
                <a
                  href={`https://www.google.com/search?q=${encodeURIComponent(`${p.web_name} ${p.team_short} injury news`)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-ink-muted hover:text-ink"
                >
                  Search press conferences ↗
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
