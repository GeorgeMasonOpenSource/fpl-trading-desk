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

const MANAGER_COOKIE = 'fpl_td_manager';
const LEAGUE_COOKIE  = 'fpl_td_league';
const COOKIE_OPTS    = {
  path: '/',
  // 1 year — this is a single-user product. Adjust when we add real auth.
  maxAge: 60 * 60 * 24 * 365,
  sameSite: 'lax' as const,
  secure:   process.env.NODE_ENV === 'production'
};

/** Active manager id: cookie wins, env is fallback. Returns null if neither. */
export function getManagerId(): number | null {
  const fromCookie = cookies().get(MANAGER_COOKIE)?.value;
  if (fromCookie) {
    const n = Number(fromCookie);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromEnv = Number(process.env.FPL_MANAGER_ID ?? 0);
  return fromEnv > 0 ? fromEnv : null;
}

/** Active league id: cookie wins, env is fallback. */
export function getLeagueId(): number | null {
  const fromCookie = cookies().get(LEAGUE_COOKIE)?.value;
  if (fromCookie) {
    const n = Number(fromCookie);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromEnv = Number(process.env.FPL_LEAGUE_ID ?? 0);
  return fromEnv > 0 ? fromEnv : null;
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
