import './globals.css';
import { ConnectionBar } from '@/components/ConnectionBar';
import { Nav } from '@/components/Nav';
import { getManagerId, getLeagueId } from '@/lib/session';
import { sql } from '@/lib/db/client';

export const metadata = {
  title: 'FPL Trading Desk',
  description: 'A deterministic, transparent Fantasy Premier League quant terminal.'
};

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
        <div className="grid grid-cols-[200px_1fr] min-h-screen">
          <aside className="bg-bg-raised border-r border-line sticky top-0 h-screen overflow-y-auto flex flex-col">
            <div className="px-4 py-5 border-b border-line">
              <div className="text-xs uppercase tracking-widest text-ink-dim">Trading Desk</div>
              <div className="font-mono font-semibold text-lg">FPL · TD</div>
            </div>
            <div className="flex-1">
              <Nav />
            </div>
            <div className="px-4 py-3 border-t border-line text-[11px] text-ink-dim font-mono">
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
