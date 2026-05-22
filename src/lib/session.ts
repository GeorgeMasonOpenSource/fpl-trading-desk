/**
 * Session = a pair of cookies for the active FPL manager id + league id.
 *
 * Why cookies, not localStorage:
 *   - server components need to read them on render
 *   - they survive a hard refresh
 *   - they let us SSR the right squad without an extra round-trip
 *
 * Both are NOT marked HttpOnly so the (admittedly small) client UI can
 * confirm what's set, but writes always go through a server action so we
 * can validate the ID hits FPL before saving.
 *
 * Env vars are a fallback only — useful for CI / cron jobs that don't have
 * a browser session.
 */
import { cookies } from 'next/headers';

const MANAGER_COOKIE    = 'fpl_td_manager';
const LEAGUE_COOKIE     = 'fpl_td_league';
const CHIPS_USED_COOKIE = 'fpl_td_chips_used'; // CSV of chip codes used: WC,FH,BB,TC
const COOKIE_OPTS    = {
  path: '/',
  // 1 year — this is a single-user product. Adjust when we add real auth.
  maxAge: 60 * 60 * 24 * 365,
  sameSite: 'lax' as const,
  secure:   process.env.NODE_ENV === 'production'
};

/**
 * Hard-coded fallback manager / league IDs for this deployment. The
 * "Connect & ingest" server action keeps timing out on Vercel's 10s
 * limit so the cookie never gets set; making the manager ID a code-level
 * default means every page renders with George's squad regardless.
 *
 * If you ever want to use this app for a different manager, override
 * via the FPL_MANAGER_ID env var (still wins over this default) or
 * delete the constant.
 */
const DEFAULT_MANAGER_ID: number | null = 319921;
const DEFAULT_LEAGUE_ID:  number | null = 1646336;

/**
 * Active manager id resolution order:
 *   1. Browser cookie  (set explicitly by the connect flow)
 *   2. FPL_MANAGER_ID env var  (CI / cron jobs)
 *   3. DEFAULT_MANAGER_ID constant above  (single-user deployment)
 */
export function getManagerId(): number | null {
  const fromCookie = cookies().get(MANAGER_COOKIE)?.value;
  if (fromCookie) {
    const n = Number(fromCookie);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromEnv = Number(process.env.FPL_MANAGER_ID ?? 0);
  if (fromEnv > 0) return fromEnv;
  return DEFAULT_MANAGER_ID;
}

/** Same precedence as getManagerId(). */
export function getLeagueId(): number | null {
  const fromCookie = cookies().get(LEAGUE_COOKIE)?.value;
  if (fromCookie) {
    const n = Number(fromCookie);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromEnv = Number(process.env.FPL_LEAGUE_ID ?? 0);
  if (fromEnv > 0) return fromEnv;
  return DEFAULT_LEAGUE_ID;
}

/** Write/clear cookies. Server-only — call from server actions or route handlers. */
export function setManagerId(id: number | null) {
  const jar = cookies();
  if (id == null) {
    jar.delete(MANAGER_COOKIE);
    return;
  }
  jar.set(MANAGER_COOKIE, String(id), COOKIE_OPTS);
}

export function setLeagueId(id: number | null) {
  const jar = cookies();
  if (id == null) {
    jar.delete(LEAGUE_COOKIE);
    return;
  }
  jar.set(LEAGUE_COOKIE, String(id), COOKIE_OPTS);
}

/** Quick boolean for "is this user connected?" — used by setup gating. */
export function isConnected() {
  return getManagerId() != null;
}

/**
 * Chip availability — which chips the user has ALREADY USED this season.
 * The chip planner / chip simulator should hide these so the recommended
 * chip never points at one you can't play.
 *
 * Valid codes:
 *   WC = Wildcard            (the first or second wildcard — we don't yet
 *        distinguish between WC1 and WC2; treat as "no WC left")
 *   FH = Free Hit
 *   BB = Bench Boost
 *   TC = Triple Captain
 *
 * Stored as a comma-separated string in a cookie so it persists across
 * sessions without needing a DB column. If the cookie is empty, no chips
 * have been used.
 */
export type ChipCode = 'WC' | 'FH' | 'BB' | 'TC';
const ALL_CHIPS: ChipCode[] = ['WC', 'FH', 'BB', 'TC'];

export function getUsedChips(): Set<ChipCode> {
  const raw = cookies().get(CHIPS_USED_COOKIE)?.value ?? '';
  const parts = raw.split(',').map(s => s.trim().toUpperCase());
  const used = new Set<ChipCode>();
  for (const p of parts) {
    if ((ALL_CHIPS as string[]).includes(p)) used.add(p as ChipCode);
  }
  return used;
}

export function getAvailableChips(): Set<ChipCode> {
  const used = getUsedChips();
  return new Set(ALL_CHIPS.filter(c => !used.has(c)));
}

/** Server-only — call from server actions or route handlers. */
export function setUsedChips(used: Iterable<ChipCode>) {
  const jar = cookies();
  const arr = Array.from(new Set(used)).filter(c => (ALL_CHIPS as string[]).includes(c));
  if (arr.length === 0) {
    jar.delete(CHIPS_USED_COOKIE);
    return;
  }
  jar.set(CHIPS_USED_COOKIE, arr.join(','), COOKIE_OPTS);
}
