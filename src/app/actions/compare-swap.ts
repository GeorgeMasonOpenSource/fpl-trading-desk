'use server';
/**
 * Server action for the "compare to" overlay on the transfer planner.
 *
 * Given a free-text swap string ("Gyökeres -> Bowen", "Saka to Salah", or
 * "FPL Review: Anderson → Mbeumo"), resolve both player names against our
 * players table and return the EV decomposition for that swap over the same
 * horizon used by the planner's top-10.
 *
 * Resolution rules (cheap and deterministic, no fuzzy match):
 *   1. Strip any leading "<source>:" label so "FPL Review: X -> Y" works.
 *   2. Split on the first → / -> / " to " separator.
 *   3. For each side, lowercase + strip diacritics, then look up against:
 *        a. exact web_name
 *        b. exact surname (last word of second_name)
 *        c. exact "first_name second_name"
 *        d. fallback substring on web_name
 *      If multiple candidates remain we return them as `ambiguities` so the
 *      UI can ask the user to pick.
 *
 * The action does NOT validate squad legality — the overlay is a comparison
 * tool, not a "make this transfer" action. The whatif panel below still
 * handles legality checks for the user's own squad.
 */
import { sql } from '@/lib/db/client';
import {
  getTransferEvBreakdown,
  diffComponents,
  pairPerFixture,
  getTransferInsights,
} from '@/lib/transfers/insights';
import { loadMinutesContext } from '@/lib/transfers/minutes-context';
// NOTE: types live in compare-swap.types.ts because Next.js requires
// 'use server' files to export ONLY async functions. Don't move these back.
import type {
  CompareSwapPlayer,
  CompareSwapMatch,
  CompareSwapResult
} from './compare-swap.types';

/** Lowercase + strip combining diacritics so "Gyökeres" matches "gyokeres". */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

interface PlayerLookupRow {
  id: number;
  web_name: string;
  first_name: string;
  second_name: string;
  position: 'GKP' | 'DEF' | 'MID' | 'FWD';
  now_cost: number;
  team_short: string;
}

async function resolveName(
  query: string,
  allPlayers: PlayerLookupRow[]
): Promise<CompareSwapPlayer[]> {
  const q = normalize(query);
  if (!q) return [];

  // (a) Exact web_name match.
  let hits = allPlayers.filter(p => normalize(p.web_name) === q);
  if (hits.length === 0) {
    // (b) Exact surname (last word of second_name).
    hits = allPlayers.filter(p => {
      const last = normalize(p.second_name).split(/\s+/).pop() ?? '';
      return last === q;
    });
  }
  if (hits.length === 0) {
    // (c) Exact "first second" full name.
    hits = allPlayers.filter(p => normalize(`${p.first_name} ${p.second_name}`) === q);
  }
  if (hits.length === 0) {
    // (d) Fallback substring on web_name. Only triggers when nothing tighter
    // matched, and we cap to 6 results so the UI dropdown stays sane.
    hits = allPlayers
      .filter(p => normalize(p.web_name).includes(q) || normalize(p.second_name).includes(q))
      .slice(0, 6);
  }
  return hits.map(p => ({
    playerId: p.id,
    webName: p.web_name,
    position: p.position,
    teamShort: p.team_short,
    nowCost: p.now_cost
  }));
}

const HORIZON_GWS = 3;

export async function priceCompareSwap(formData: FormData): Promise<CompareSwapResult> {
  const raw = String(formData.get('swap') ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter a swap like "Anderson → Mbeumo".' };

  // Detect leading "Source: ..." label.
  let source: string | undefined;
  let body = raw;
  const labelMatch = raw.match(/^([^:]{2,30}):\s*(.+)$/);
  if (labelMatch) {
    source = labelMatch[1]!.trim();
    body = labelMatch[2]!.trim();
  }

  // Split on the first separator. Order matters: try unicode arrow first.
  const SEP = /\s*(?:→|->|=>|>>|\bto\b|\bfor\b)\s*/i;
  const parts = body.split(SEP);
  if (parts.length < 2) {
    return {
      ok: false,
      error: 'Use "<out> → <in>" or "<out> to <in>" — e.g. "Gyökeres → Bowen".'
    };
  }
  const outQuery = parts[0]!.trim();
  const inQuery  = parts.slice(1).join(' ').trim();
  if (!outQuery || !inQuery) {
    return { ok: false, error: 'Both player names are required.', source };
  }

  // One read of all active players. We do the matching in JS so the user gets
  // an "ambiguous: pick one" experience for surname collisions without us
  // shipping a fuzzy-match SQL query.
  const players = await sql<PlayerLookupRow[]>`
    SELECT p.id, p.web_name, p.first_name, p.second_name, p.position, p.now_cost,
           t.short_name AS team_short
      FROM players p
      JOIN teams t ON t.id = p.team_id
     WHERE p.status <> 'u'
  `;

  const outMatches = await resolveName(outQuery, players);
  const inMatches  = await resolveName(inQuery,  players);

  const ambiguities: CompareSwapMatch[] = [];
  if (outMatches.length === 0) {
    return { ok: false, source, error: `No player matched "${outQuery}".` };
  }
  if (inMatches.length === 0) {
    return { ok: false, source, error: `No player matched "${inQuery}".` };
  }
  if (outMatches.length > 1) ambiguities.push({ query: outQuery, candidates: outMatches });
  if (inMatches.length  > 1) ambiguities.push({ query: inQuery,  candidates: inMatches });
  if (ambiguities.length > 0) {
    return { ok: false, source, error: 'Multiple players matched — pick one.', ambiguities };
  }

  const outResolved = outMatches[0]!;
  const inResolved  = inMatches[0]!;
  if (outResolved.playerId === inResolved.playerId) {
    return { ok: false, source, error: 'Out and in are the same player.' };
  }

  // Resolve start gameweek: use the planning (next un-deadlined) gameweek to
  // match the planner's top-10 horizon. Fallback to current/next.
  const gwRows = await sql<Array<{ id: number }>>`
    SELECT id FROM gameweeks
     WHERE deadline_time > now()
     ORDER BY deadline_time ASC
     LIMIT 1
  `;
  let startGw = gwRows[0]?.id;
  if (!startGw) {
    const cur = await sql<Array<{ id: number }>>`
      SELECT id FROM gameweeks WHERE is_current = TRUE LIMIT 1
    `;
    startGw = cur[0]?.id;
  }
  if (!startGw) {
    return { ok: false, source, error: 'No upcoming gameweek to score against.', outResolved, inResolved };
  }

  const breakdowns = await getTransferEvBreakdown(
    [outResolved.playerId, inResolved.playerId],
    startGw, HORIZON_GWS
  );
  const outBreak = breakdowns.get(outResolved.playerId);
  const inBreak  = breakdowns.get(inResolved.playerId);
  if (!outBreak || !inBreak) {
    return { ok: false, source, error: 'No projections for one of these players in the next 3 GWs.', outResolved, inResolved };
  }
  const delta = diffComponents(inBreak.components, outBreak.components);
  const perGw = pairPerFixture(inBreak.perFixture, outBreak.perFixture);
  // §detailed-breakdown — fetch the same insight + minutes context the
  // top-N rows use so the overlay can render the per-component xPts table
  // and recent-form panel inline.
  const [insights, minutesCtx] = await Promise.all([
    getTransferInsights([outResolved.playerId, inResolved.playerId], startGw),
    loadMinutesContext([outResolved.playerId, inResolved.playerId], startGw),
  ]);
  return {
    ok: true,
    source,
    outResolved,
    inResolved,
    delta,
    perGw,
    netEv: delta.total,
    outComponents: outBreak.components,
    inComponents:  inBreak.components,
    outInsight:    insights.get(outResolved.playerId),
    inInsight:     insights.get(inResolved.playerId),
    outExpectedMinutes: minutesCtx.get(outResolved.playerId)?.expectedMinutes ?? null,
    inExpectedMinutes:  minutesCtx.get(inResolved.playerId)?.expectedMinutes ?? null,
    horizonGws: HORIZON_GWS,
  };
}
