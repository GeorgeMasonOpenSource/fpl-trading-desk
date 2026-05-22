import './globals.css';
import Link from 'next/link';
import { ConnectionBar } from '@/components/ConnectionBar';
import { getManagerId, getLeagueId } from '@/lib/session';
import { sql } from '@/lib/db/client';

export const metadata = {
  title: 'FPL Trading Desk',
  description: 'A deterministic, transparent Fantasy Premier League quant terminal.'
};

const NAV = [
  { href: '/gw',                 label: '★ This Gameweek' },
  { href: '/',                   label: 'Dashboard (full)' },
  { href: '/gw-checklist',       label: 'GW Checklist' },
  { href: '/pitch',              label: 'Pitch view' },
  { href: '/predicted-lineups',  label: 'Predicted Lineups' },
  { href: '/my-team',            label: 'My Team' },
  { href: '/transfer-planner',   label: 'Transfer Planner' },
  { href: '/captaincy',          label: 'Captaincy' },
  { href: '/chip-planner',       label: 'Chip Planner' },
  { href: '/mini-league',        label: 'Mini League War Room' },
  { href: '/creator-signals',    label: 'Creator Board' },
  { href: '/decision-matrix',    label: 'Decision Matrix' },
  { href: '/creator-lineups',    label: 'Creator Lineups' },
  { href: '/creator-accuracy',   label: 'Creator Accuracy' },
  { href: '/player-explorer',    label: 'Player Explorer' },
  { href: '/minutes-lab',        label: 'Minutes Lab' },
  { href: '/role-matrix',        label: 'Role Matrix' },
  { href: '/rotation-radar',     label: 'Rotation Radar' },
  { href: '/fixture-congestion', label: 'Fixture Congestion' },
  { href: '/model-lab',          label: 'Model Lab' },
  { href: '/model-audit',        label: 'Model Audit' },
  { href: '/backtesting',        label: 'Backtesting' },
  { href: '/settings',           label: 'Settings' },
  { href: '/manual-overrides',   label: 'Manual Overrides' }
];

async function loadConnectionContext() {
  const managerId = getManagerId();
  const leagueId  = getLeagueId();
  let managerName: string | null = null;
  let leagueName: string | null = null;
  let lastIngest: string | null = null;
  try {
    if (managerId) {
      const rows = await sql<Array<{ name: string | null }>>`
        SELECT name FROM manager_teams WHERE manager_id = ${managerId}
      `;
      managerName = rows[0]?.name ?? null;
    }
    if (managerId && leagueId) {
      const lrows = await sql<Array<{ name: string | null }>>`
        SELECT name FROM manager_leagues
        WHERE manager_id = ${managerId} AND league_id = ${leagueId}
        LIMIT 1
      `;
      leagueName = lrows[0]?.name ?? null;
    }
    const ing = await sql<Array<{ fetched_at: string | null }>>`
      SELECT MAX(fetched_at) AS fetched_at FROM raw_fpl_responses
    `;
    lastIngest = ing[0]?.fetched_at ?? null;
  } catch {
    // DB might not be reachable in dev / before migrations — render anyway.
  }
  return { managerId, leagueId, managerName, leagueName, lastIngest };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ctx = await loadConnectionContext();
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg text-ink font-sans">
        <div className="grid grid-cols-[220px_1fr] min-h-screen">
          <aside className="bg-bg-raised border-r border-line">
            <div className="px-4 py-5 border-b border-line">
              <div className="text-xs uppercase tracking-widest text-ink-dim">Trading Desk</div>
              <div className="font-mono font-semibold text-lg">FPL · TD</div>
            </div>
            <nav className="py-2">
              {NAV.map(item => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="block px-4 py-2 text-sm text-ink-muted hover:text-ink hover:bg-bg-card border-l-2 border-transparent hover:border-accent-blue"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="px-4 py-4 mt-2 border-t border-line text-[11px] text-ink-dim font-mono">
              v0.1 · deterministic
            </div>
          </aside>
          <div className="flex flex-col">
            <ConnectionBar
              managerId={ctx.managerId}
              leagueId={ctx.leagueId}
              managerName={ctx.managerName}
              leagueName={ctx.leagueName}
              lastIngest={ctx.lastIngest}
            />
            <main className="p-6 max-w-[1600px] flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
