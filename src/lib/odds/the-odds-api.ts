/**
 * The Odds API client — https://the-odds-api.com
 *
 * Free tier: 500 requests/month. Plenty for once-per-day updates on EPL
 * fixtures (38 GW × 10 matches × 1 update = 380 calls). We pull player
 * goal-scorer markets, team clean-sheet, and team match-result odds —
 * the three richest sources of latent player-level information.
 *
 * Set the API key in env: ODDS_API_KEY
 *   https://the-odds-api.com/account/  (free tier sign-up)
 *
 * Why this provider:
 *   - Free tier covers our usage
 *   - Aggregates multiple bookmakers so we can de-vig at the consensus level
 *   - Player props endpoints exist (most free APIs only have moneyline)
 *
 * If we burn through the quota, fall back gracefully — the ensemble blender
 * downstream handles missing market data by reverting to model-only output.
 */
const BASE = 'https://api.the-odds-api.com/v4';

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: Array<{
    key: string;
    markets: Array<{
      key: string;
      outcomes: Array<{
        name: string;       // player name or team name
        price: number;      // decimal odds
        point?: number;
      }>;
    }>;
  }>;
}

export interface PlayerGoalOdds {
  fixtureExternal: { home: string; away: string; commenceTime: string };
  playerName: string;
  decimalOdds: number;     // mean across observed bookmakers
  bookmakers: string[];    // which books contributed
  rawCount: number;        // sample size
}

export interface TeamCleanSheetOdds {
  fixtureExternal: { home: string; away: string; commenceTime: string };
  teamName: string;
  decimalOdds: number;
}

/** List of EPL events for the upcoming window. */
export async function listEvents(apiKey: string): Promise<OddsApiEvent[]> {
  const url = `${BASE}/sports/soccer_epl/events?apiKey=${apiKey}&dateFormat=iso`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`odds api events: HTTP ${res.status}`);
  return await res.json() as OddsApiEvent[];
}

/**
 * Player anytime-goalscorer odds for one event. Aggregates across all
 * bookmakers we observe and returns the mean decimal odds per player.
 */
export async function eventPlayerGoalOdds(
  apiKey: string, eventId: string
): Promise<PlayerGoalOdds[]> {
  const url =
    `${BASE}/sports/soccer_epl/events/${eventId}/odds?apiKey=${apiKey}` +
    `&regions=uk&markets=player_goal_scorer_anytime&oddsFormat=decimal`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`odds api player goals (${eventId}): HTTP ${res.status}`);
  const data = await res.json() as OddsApiEvent;

  // Bucket every (player, bookmaker) outcome, then average across books.
  const acc = new Map<string, { sum: number; n: number; books: Set<string> }>();
  for (const b of data.bookmakers ?? []) {
    for (const m of b.markets ?? []) {
      if (m.key !== 'player_goal_scorer_anytime') continue;
      for (const o of m.outcomes ?? []) {
        if (!o.name || !o.price) continue;
        const k = o.name;
        if (!acc.has(k)) acc.set(k, { sum: 0, n: 0, books: new Set() });
        const e = acc.get(k)!;
        e.sum += o.price;
        e.n += 1;
        e.books.add(b.key);
      }
    }
  }

  const out: PlayerGoalOdds[] = [];
  for (const [name, e] of acc.entries()) {
    out.push({
      fixtureExternal: {
        home: data.home_team,
        away: data.away_team,
        commenceTime: data.commence_time
      },
      playerName: name,
      decimalOdds: e.sum / e.n,
      bookmakers: Array.from(e.books),
      rawCount: e.n
    });
  }
  return out;
}

/**
 * Convert decimal odds to a probability with naive 1/odds. The market-level
 * over-round (sum of 1/odds across all outcomes) is reported separately so
 * callers can de-vig if they want a stricter calibration.
 */
export function decimalToProb(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return 0;
  return 1 / decimal;
}

/**
 * Approximate expected goals from a player's anytime-goalscorer probability.
 * The transform inverts P(X ≥ 1) for a Poisson — so given P, λ = -ln(1-P).
 * Multi-goal probability is much smaller and the FPL points-per-goal mostly
 * pivot on the FIRST goal, so this is a reasonable approximation.
 *
 * For e.g. 50% anytime-scorer odds → λ ≈ 0.69 expected goals.
 */
export function impliedXg(probAnytime: number): number {
  if (probAnytime <= 0) return 0;
  if (probAnytime >= 0.99) return 4.6; // cap so log doesn't blow up
  return -Math.log(1 - probAnytime);
}
