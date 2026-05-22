/**
 * Understat scraper — public, free per-shot xG data.
 *
 * Understat embeds data as a JSON blob inside <script> tags on each page.
 * The pattern: `JSON.parse('escaped-json-string')`. We extract the string,
 * unescape the unicode escape sequences, and parse.
 *
 * Endpoints we use:
 *
 *   /league/EPL/{year}    — list of every player + every team this season,
 *                           with season-aggregate xG. Year = starting year
 *                           of the season (2025/26 → 2025).
 *
 *   /match/{matchId}      — every shot in this match. Contains per-shot
 *                           xG, situation, body part, result, X-Y location,
 *                           plus the home/away player+team mapping.
 *
 *   /team/{teamName}/{year} — per-match list for a team's season, useful
 *                           for finding match IDs.
 *
 * Rate-limiting: Understat is generous but we still want to be polite.
 * 200ms between requests is enough to fly under their radar.
 *
 * Limitations:
 *   - Understat's xG model is THEIRS, not Opta's. Slightly different but
 *     well-calibrated and widely used.
 *   - Understat player IDs DON'T match FPL player IDs. We match on
 *     normalised name + team, same approach as the YouTube extractor.
 *   - One PL season per request batch. Multi-season backfill is a separate
 *     concern.
 */
import { lookup } from 'node:dns';

const BASE = 'https://understat.com';

export interface UnderstatLeaguePlayer {
  id: string;
  player_name: string;
  team_title: string;        // long team name, e.g. "Manchester City"
  games: string;
  time: string;              // minutes (Understat returns as string)
  goals: string;
  xG: string;
  assists: string;
  xA: string;
  shots: string;
  key_passes: string;
  npg: string;               // non-penalty goals
  npxG: string;              // non-penalty xG
  position: string;
}

export interface UnderstatLeagueTeam {
  id: string;
  title: string;             // long name, e.g. "Manchester City"
  history: Array<{
    h_a: 'h' | 'a';
    xG: string;
    xGA: string;
    npxG: string;
    npxGA: string;
    ppda: { att: number; def: number };
    deep: number;
    scored: number;
    missed: number;
    result: 'w' | 'l' | 'd';
    date: string;
  }>;
}

export interface UnderstatShot {
  id: string;
  minute: string;
  result: string;            // Goal | SavedShot | MissedShots | BlockedShot | ShotOnPost | OwnGoal
  X: string;                 // 0..1, where 0 is own goal
  Y: string;                 // 0..1
  xG: string;
  player: string;            // player display name
  player_id: string;
  player_assisted: string | null;
  situation: string;         // OpenPlay | SetPiece | FromCorner | Penalty | DirectFreekick
  shotType: string;          // Head | LeftFoot | RightFoot | OtherBodyPart
  h_a: 'h' | 'a';
  match_id: string;
  date: string;              // ISO
  h_team: string;
  a_team: string;
  h_goals: string;
  a_goals: string;
  season: string;
}

/**
 * Pull all PL players for the given season-start year.
 * Year format: 2025 = 2025/26 season.
 */
export async function fetchLeaguePlayers(year: number): Promise<UnderstatLeaguePlayer[]> {
  const html = await fetchPage(`${BASE}/league/EPL/${year}`);
  return extractJsonVariable<UnderstatLeaguePlayer[]>(html, 'playersData');
}

/** Per-team list with per-match xG for/against. Used to enumerate matches. */
export async function fetchLeagueTeams(year: number): Promise<Record<string, UnderstatLeagueTeam>> {
  const html = await fetchPage(`${BASE}/league/EPL/${year}`);
  return extractJsonVariable<Record<string, UnderstatLeagueTeam>>(html, 'teamsData');
}

/** Per-match shots. The page has shotsData with home + away arrays. */
export async function fetchMatchShots(matchId: string | number): Promise<UnderstatShot[]> {
  const html = await fetchPage(`${BASE}/match/${matchId}`);
  const data = extractJsonVariable<{ h: UnderstatShot[]; a: UnderstatShot[] }>(html, 'shotsData');
  return [...data.h, ...data.a];
}

/** Enumerate every PL match ID this season by walking team history pages. */
export async function fetchAllMatchIds(year: number): Promise<Set<string>> {
  const matchIds = new Set<string>();
  // Each team page lists matches with shot data; the team page URL is
  // /team/{slug}/{year}. We use the league teams listing to enumerate.
  const teams = await fetchLeagueTeams(year);
  const teamNames = Object.values(teams).map(t => t.title);
  for (const name of teamNames) {
    // Understat URL slug is "Team_Name" with underscores.
    const slug = name.replace(/\s+/g, '_');
    try {
      const html = await fetchPage(`${BASE}/team/${slug}/${year}`);
      const matches = extractJsonVariable<Array<{ id: string }>>(html, 'matchesData');
      for (const m of matches) matchIds.add(m.id);
    } catch {
      // Skip on any per-team failure — most teams will succeed.
    }
    await sleep(200);
  }
  return matchIds;
}

/* ---------------------------------------------------------------------------
 * Internal helpers
 * -------------------------------------------------------------------------*/

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9'
    },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

/**
 * Pull a named JSON variable out of an Understat page's HTML. Looks for
 *   var VAR_NAME = JSON.parse('escaped-json-string');
 * Unescapes the unicode-escaped string and parses to T.
 */
function extractJsonVariable<T>(html: string, variableName: string): T {
  // The string is wrapped in single quotes after JSON.parse(
  const re = new RegExp(
    `var\\s+${variableName}\\s*=\\s*JSON\\.parse\\('([\\s\\S]*?)'\\)`,
    'm'
  );
  const m = html.match(re);
  if (!m) throw new Error(`could not find JSON var "${variableName}" on page`);
  // Understat double-escapes: \xHH for chars. Convert to actual chars.
  const raw = m[1]!
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return JSON.parse(raw) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Lint helper — imported above but unused at runtime, suppressed.
void lookup;
