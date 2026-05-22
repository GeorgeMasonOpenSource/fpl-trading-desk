/**
 * Understat scraper — public, free per-shot xG data.
 *
 * Understat moved off inline `JSON.parse(...)` script vars in late 2025.
 * Data is now loaded by the front-end via JSON-returning AJAX endpoints
 * under /main/. We hit those directly — much cleaner than HTML scraping.
 *
 * Endpoints we use:
 *
 *   /main/getLeagueData/EPL/{year}
 *     → { teams: {<id>: {id, title, history[]}},
 *         players: [{id, player_name, team_title, time, goals, xG, ...}],
 *         dates: [{id, isResult, h, a, goals, xG, datetime, ...}] }
 *     Returns everything we need for the season summary AND every match
 *     ID — no more per-team enumeration walk.
 *
 *   /main/getMatchData/{matchId}
 *     → { rosters: {h, a}, shots: {h: Shot[], a: Shot[]}, tmpl: {...} }
 *     Per-shot detail for one match. Shot fields:
 *     id, minute, result, X, Y, xG, player, h_a, player_id, situation,
 *     season, shotType, match_id, h_team, a_team, h_goals, a_goals,
 *     date, player_assisted, lastAction.
 *
 * Headers: Understat requires the XHR header to return JSON, otherwise
 * the response is the HTML shell. Node's fetch handles gzip transparently.
 *
 * Limitations:
 *   - Understat's xG model is THEIRS, not Opta's. Different but well-
 *     calibrated and the de-facto public-data standard.
 *   - Understat player IDs DON'T match FPL player IDs. We match on
 *     normalised name + team, same approach as the YouTube extractor.
 */
import { lookup } from 'node:dns';

const BASE = 'https://understat.com';

export interface UnderstatLeaguePlayer {
  id: string;
  player_name: string;
  team_title: string;
  games: string;
  time: string;
  goals: string;
  xG: string;
  assists: string;
  xA: string;
  shots: string;
  key_passes: string;
  npg: string;
  npxG: string;
  position: string;
}

export interface UnderstatLeagueTeam {
  id: string;
  title: string;
  history: Array<{
    h_a: 'h' | 'a';
    xG: number;
    xGA: number;
    npxG: number;
    npxGA: number;
    ppda: { att: number; def: number };
    deep: number;
    scored: number;
    missed: number;
    result: 'w' | 'l' | 'd';
    date: string;
  }>;
}

export interface UnderstatDate {
  id: string;
  isResult: boolean;
  h: { id: string; title: string; short_title: string };
  a: { id: string; title: string; short_title: string };
  goals: { h: string; a: string };
  xG: { h: string; a: string };
  datetime: string;
  forecast?: { w: string; d: string; l: string };
}

export interface UnderstatShot {
  id: string;
  minute: string;
  result: string;            // Goal | SavedShot | MissedShots | BlockedShot | ShotOnPost | OwnGoal
  X: string;                 // 0..1 (0 = own goal end)
  Y: string;
  xG: string;
  player: string;
  player_id: string;
  player_assisted: string | null;
  situation: string;         // OpenPlay | SetPiece | FromCorner | Penalty | DirectFreekick
  shotType: string;          // Head | LeftFoot | RightFoot | OtherBodyPart
  h_a: 'h' | 'a';
  match_id: string;
  date: string;
  h_team: string;
  a_team: string;
  h_goals: string;
  a_goals: string;
  season: string;
}

interface LeagueDataResponse {
  teams: Record<string, UnderstatLeagueTeam>;
  players: UnderstatLeaguePlayer[];
  dates: UnderstatDate[];
}

interface MatchDataResponse {
  rosters: { h: Record<string, unknown>; a: Record<string, unknown> };
  shots: { h: UnderstatShot[]; a: UnderstatShot[] };
  tmpl?: unknown;
}

/** Pull all PL players for the given season-start year (2025 = 2025/26). */
export async function fetchLeaguePlayers(year: number): Promise<UnderstatLeaguePlayer[]> {
  const data = await fetchLeagueData(year);
  return data.players;
}

/** Per-team list with per-match xG for/against. */
export async function fetchLeagueTeams(year: number): Promise<Record<string, UnderstatLeagueTeam>> {
  const data = await fetchLeagueData(year);
  return data.teams;
}

/** Per-match shots. */
export async function fetchMatchShots(matchId: string | number): Promise<UnderstatShot[]> {
  const data = await fetchJson<MatchDataResponse>(`${BASE}/main/getMatchData/${matchId}`);
  return [...(data.shots?.h ?? []), ...(data.shots?.a ?? [])];
}

/**
 * Enumerate every PL match ID this season. No more per-team walk — the
 * league endpoint returns the full fixture list directly under `dates`.
 * We include both played AND unplayed matches; caller can filter on
 * isResult.
 */
export async function fetchAllMatchIds(year: number): Promise<Set<string>> {
  const data = await fetchLeagueData(year);
  const matchIds = new Set<string>();
  for (const m of data.dates) {
    if (m.isResult) matchIds.add(m.id);
  }
  return matchIds;
}

/** Raw league snapshot. Cache-friendly entry point. */
let _leagueCache: { year: number; data: LeagueDataResponse } | null = null;
async function fetchLeagueData(year: number): Promise<LeagueDataResponse> {
  if (_leagueCache && _leagueCache.year === year) return _leagueCache.data;
  const data = await fetchJson<LeagueDataResponse>(`${BASE}/main/getLeagueData/EPL/${year}`);
  _leagueCache = { year, data };
  return data;
}

/* ---------------------------------------------------------------------------
 * Internal helpers
 * -------------------------------------------------------------------------*/

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
      'x-requested-with': 'XMLHttpRequest',
      'accept': 'application/json, text/javascript, */*; q=0.01'
    },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

// Lint helper — imported above but unused at runtime, suppressed.
void lookup;
