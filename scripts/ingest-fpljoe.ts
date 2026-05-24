#!/usr/bin/env tsx
/**
 * FPL Joe odds ingest — pulls Poisson lambdas + CS probs per fixture
 * from https://www.fpljoe.com/api/odds/overview.
 *
 * Why this matters:
 *   • Bookmaker-derived per-team goal expectations are the cleanest
 *     external sanity check on our team-strength model. If our model
 *     says Brighton 1.5 / Man Utd 1.2 but FPL Joe says 1.97 / 1.35, the
 *     market has information we don't (probably lineup leaks, injury).
 *   • The 12/24/48h comparison snapshots flag "sharp money has moved"
 *     — useful for late-week alerts.
 *   • Stored separately from our engine's projections so blending is
 *     opt-in. The press-conf page and the transfer planner can surface
 *     "market thinks X" alongside "our model thinks Y" without
 *     contaminating the deterministic engine.
 *
 * Usage:
 *   npm run ingest:fpljoe                # current/upcoming GW only
 *   npm run ingest:fpljoe -- --gw 37 38  # explicit GW list
 *
 * Rate-limit: be polite. Run every 30-60 minutes max.
 */
import { sql } from '../src/lib/db/client';

const API_BASE = 'https://www.fpljoe.com';
const BOOKMAKER = process.env.FPLJOE_BOOKMAKER ?? 'Sbobet';

interface OverviewFixture {
  fixtureId: number;
  gw: number;
  homeTeamName: string;
  awayTeamName: string;
  confidence: number;
  snapshotTsUtc: string;
  isStaleSnapshot: boolean;
  lambdaHome: number;
  lambdaAway: number;
  pHomeCs: number;
  pAwayCs: number;
  comparison12hLambdaHome: number | null;
  comparison12hLambdaAway: number | null;
  comparison24hLambdaHome: number | null;
  comparison24hLambdaAway: number | null;
  comparison48hLambdaHome: number | null;
  comparison48hLambdaAway: number | null;
}

interface OverviewResp {
  gw: number;
  mode: string;
  bookmaker: string;
  latestSnapshotTs: string;
  fixtures: OverviewFixture[];
}

async function fetchOverview(gw: number): Promise<OverviewResp> {
  const url = `${API_BASE}/api/odds/overview?gw=${gw}&bookmaker=${encodeURIComponent(BOOKMAKER)}&mode=epl`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'fpl-trading-desk/0.1 (research)',
      'accept': 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`fpljoe overview ${gw} returned ${res.status}`);
  return res.json() as Promise<OverviewResp>;
}

async function currentAndNextGw(): Promise<number[]> {
  const rows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
    WHERE is_current = TRUE OR is_next = TRUE OR finished = FALSE
    ORDER BY id ASC
    LIMIT 4
  `;
  return rows.map(r => r.id);
}

function num(x: number | null | undefined): string | null {
  if (x == null || !Number.isFinite(x)) return null;
  return x.toFixed(4);
}

async function main() {
  const args = process.argv.slice(2);
  const gwArg = args.indexOf('--gw');
  let gws: number[];
  if (gwArg >= 0) {
    gws = args.slice(gwArg + 1).map(Number).filter(n => Number.isFinite(n) && n > 0);
  } else {
    gws = await currentAndNextGw();
  }
  if (gws.length === 0) {
    console.log('No GWs to ingest.');
    return;
  }
  console.log(`→ ingesting FPL Joe odds for GW(s): ${gws.join(', ')} · bookmaker=${BOOKMAKER}`);

  // Pull every fixture row up-front so we can validate fixtureId mapping.
  const ourFixtures = await sql<Array<{ id: number }>>`SELECT id FROM fixtures`;
  const ourFixtureIds = new Set(ourFixtures.map(r => r.id));

  let stored = 0;
  let unmatched = 0;
  for (const gw of gws) {
    let resp: OverviewResp;
    try {
      resp = await fetchOverview(gw);
    } catch (err) {
      console.warn(`  GW${gw}: ${(err as Error).message}`);
      continue;
    }
    console.log(`  GW${gw}: ${resp.fixtures.length} fixtures · snapshot ${resp.latestSnapshotTs}`);
    for (const fx of resp.fixtures) {
      if (!ourFixtureIds.has(fx.fixtureId)) {
        console.warn(`    skip fixtureId ${fx.fixtureId} (${fx.homeTeamName} vs ${fx.awayTeamName}) — not in our fixtures table`);
        unmatched++;
        continue;
      }
      await sql`
        INSERT INTO fpljoe_odds (
          fixture_id, bookmaker, snapshot_ts, confidence, is_stale,
          lambda_home, lambda_away, p_home_cs, p_away_cs,
          lambda_home_12h, lambda_away_12h,
          lambda_home_24h, lambda_away_24h,
          lambda_home_48h, lambda_away_48h,
          fetched_at
        ) VALUES (
          ${fx.fixtureId}, ${resp.bookmaker}, ${fx.snapshotTsUtc}::timestamptz,
          ${Number(fx.confidence ?? 0).toFixed(3)}, ${!!fx.isStaleSnapshot},
          ${num(fx.lambdaHome)}, ${num(fx.lambdaAway)},
          ${num(fx.pHomeCs)},   ${num(fx.pAwayCs)},
          ${num(fx.comparison12hLambdaHome)}, ${num(fx.comparison12hLambdaAway)},
          ${num(fx.comparison24hLambdaHome)}, ${num(fx.comparison24hLambdaAway)},
          ${num(fx.comparison48hLambdaHome)}, ${num(fx.comparison48hLambdaAway)},
          now()
        )
        ON CONFLICT (fixture_id, bookmaker) DO UPDATE SET
          snapshot_ts      = EXCLUDED.snapshot_ts,
          confidence       = EXCLUDED.confidence,
          is_stale         = EXCLUDED.is_stale,
          lambda_home      = EXCLUDED.lambda_home,
          lambda_away      = EXCLUDED.lambda_away,
          p_home_cs        = EXCLUDED.p_home_cs,
          p_away_cs        = EXCLUDED.p_away_cs,
          lambda_home_12h  = EXCLUDED.lambda_home_12h,
          lambda_away_12h  = EXCLUDED.lambda_away_12h,
          lambda_home_24h  = EXCLUDED.lambda_home_24h,
          lambda_away_24h  = EXCLUDED.lambda_away_24h,
          lambda_home_48h  = EXCLUDED.lambda_home_48h,
          lambda_away_48h  = EXCLUDED.lambda_away_48h,
          fetched_at       = now()
      `;
      stored++;
    }
  }
  console.log(`→ done. ${stored} fixtures stored · ${unmatched} unmatched`);
  await sql.end({ timeout: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
