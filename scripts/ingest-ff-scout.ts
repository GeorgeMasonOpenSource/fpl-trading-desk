#!/usr/bin/env tsx
/**
 * Ingest team-news from Fantasy Football Scout's public team-news page.
 *
 *   https://www.fantasyfootballscout.co.uk/team-news
 *
 * Page structure (verified May 2026 — see scripts/.../probe-ffs.md for the
 * inspection report):
 *   <li class="team-news-item" data-team-code="ars">
 *     <header><h2>Arsenal</h2></header>
 *     <div class="next-match"><strong>Next Match:</strong> Crystal Palace (A)</div>
 *     <div class="scout-picks formation-4-3-3">
 *       <ul class="row-1"><li><span class="player-name">Kepa</span></li></ul>
 *       <ul class="row-2">…</ul> …
 *     </div>
 *     <ul class="story-parts">
 *       <li class="headers"><strong>Out:</strong>
 *         <ul class="players"><li>White</li></ul>
 *       </li>
 *       <li class="headers"><strong>Doubts:</strong>
 *         <ul class="players">
 *           <li>Merino <span class="doubt-percent">75%</span></li>
 *         </ul>
 *       </li>
 *       <li class="headers"><strong>Banned:</strong></li>
 *       <li><p><strong>Latest News: </strong>Mikel Merino (foot)…</p></li>
 *       <li class="headers grey"><em>Last Updated Sun 24th May</em></li>
 *     </ul>
 *   </li>
 *
 * Usage: data is stored with attribution and we never display it as our
 * own — the press-conferences page renders it with an explicit "Source:
 * Fantasy Football Scout" tag + outbound link to the page. Honour their
 * robots / ToS by running this at most once per hour.
 */
import * as cheerio from 'cheerio';
import { sql, json } from '../src/lib/db/client';

const FFS_URL = 'https://www.fantasyfootballscout.co.uk/team-news';
const SOURCE_KEY = 'ff_scout';
const SOURCE_LABEL = 'Fantasy Football Scout';

// FFS uses lowercase 3-letter team codes (data-team-code). Mostly these
// match FPL `teams.short_name` directly (lower-cased), but a few diverge
// (Spurs is "tot" in FPL but FFS could use "thfc", etc.). Build a robust
// lookup that tries: data-team-code → match teams.short_name; header text
// → match teams.name.
type FfsTeam = {
  code: string;
  name: string;
  nextMatch: string | null;
  formation: string | null;
  predictedXi: string[];
  out: Array<{ name: string }>;
  doubts: Array<{ name: string; percent: number | null }>;
  banned: Array<{ name: string }>;
  latestNews: string | null;
  lastUpdated: string | null;
};

async function fetchPage(): Promise<string> {
  const res = await fetch(FFS_URL, {
    headers: {
      // FFS sometimes returns a thinner page to non-browser UAs. Send a
      // realistic UA so the scout-picks block is included in the markup.
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'en-GB,en;q=0.9',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`FFS returned ${res.status}`);
  return res.text();
}

function parsePage(html: string): FfsTeam[] {
  const $ = cheerio.load(html);
  const out: FfsTeam[] = [];
  $('li.team-news-item').each((_, li) => {
    const $t = $(li);
    const code = ($t.attr('data-team-code') ?? '').trim().toLowerCase();
    const name = $t.find('header h2').first().text().trim();

    const nextMatch = textAfterStrong($t.find('.next-match').first(), 'Next Match:');
    const formationClass = ($t.find('.scout-picks').attr('class') ?? '');
    const fMatch = formationClass.match(/formation-([0-9-]+)/);
    const formation = fMatch ? fMatch[1] : null;

    const predictedXi: string[] = [];
    $t.find('.scout-picks ul[class^="row-"] li').each((_, p) => {
      const n = $(p).find('.player-name').first().text().trim();
      if (n) predictedXi.push(n);
    });

    // Walk story-parts looking for the labelled sections.
    let outArr:    Array<{ name: string }> = [];
    let doubtsArr: Array<{ name: string; percent: number | null }> = [];
    let banArr:    Array<{ name: string }> = [];
    let latestNews: string | null = null;
    let lastUpdated: string | null = null;

    $t.find('ul.story-parts > li').each((_, sec) => {
      const $s = $(sec);
      const label = $s.children('strong').first().text().replace(':', '').trim().toLowerCase();
      if (label === 'out') {
        outArr = extractPlayers($s);
      } else if (label === 'doubts') {
        doubtsArr = extractDoubtPlayers($s);
      } else if (label === 'banned') {
        banArr = extractPlayers($s);
      } else if ($s.find('> p > strong').first().text().toLowerCase().startsWith('latest news')) {
        const p = $s.find('> p').first();
        // Remove the "Latest News:" label, keep everything else.
        p.find('strong').first().remove();
        latestNews = p.text().trim() || null;
      } else if ($s.hasClass('grey')) {
        const em = $s.find('em').first().text().trim();
        if (em) lastUpdated = em.replace(/^Last Updated\s*/i, '').trim();
      }
    });

    out.push({
      code, name,
      nextMatch, formation,
      predictedXi,
      out: outArr,
      doubts: doubtsArr,
      banned: banArr,
      latestNews,
      lastUpdated,
    });
  });
  return out;
}

function textAfterStrong($el: cheerio.Cheerio<any>, label: string): string | null {
  const raw = $el.text();
  if (!raw) return null;
  return raw.replace(label, '').trim() || null;
}

function extractPlayers($section: cheerio.Cheerio<any>): Array<{ name: string }> {
  return $section.find('ul.players > li').map((_, li) => ({
    name: (cheerio.load('<div>' + (li as any).children
      .map((c: any) => c.type === 'text' ? c.data : (c.children?.[0]?.data ?? ''))
      .join('')
      + '</div>')('div').text() || '').trim()
  })).get().filter(p => p.name);
}

function extractDoubtPlayers($section: cheerio.Cheerio<any>): Array<{ name: string; percent: number | null }> {
  const $ = cheerio.load('<wrap>' + $section.html() + '</wrap>');
  return $('ul.players > li').map((_, li) => {
    const $li = $(li);
    const pctTxt = $li.find('.doubt-percent').first().text().trim();
    const pct = pctTxt ? parseInt(pctTxt.replace('%', ''), 10) : NaN;
    // Strip the percent span before grabbing the player name.
    $li.find('.doubt-percent').remove();
    const name = $li.text().trim();
    return { name, percent: Number.isFinite(pct) ? pct : null };
  }).get().filter(p => p.name);
}

/**
 * Resolve FFS code/name to our FPL team_id. FFS data-team-code is mostly
 * the lowercase of teams.short_name, but a handful of divergences (e.g.
 * Spurs may use 'thfc' instead of 'tot') require fuzzy name matching.
 */
async function buildTeamLookup() {
  type Row = { id: number; short_name: string; name: string };
  const teams = await sql<Row[]>`SELECT id, short_name, name FROM teams`;
  const byShort = new Map<string, number>();
  const byName  = new Map<string, number>();
  for (const t of teams) {
    byShort.set(t.short_name.toLowerCase(), t.id);
    byName.set(t.name.toLowerCase(), t.id);
  }
  return (code: string, name: string): number | null => {
    if (byShort.has(code)) return byShort.get(code)!;
    if (byName.has(name.toLowerCase())) return byName.get(name.toLowerCase())!;
    // Common aliases.
    const aliases: Record<string, string> = {
      // FFS code → our short_name
      'mun': 'mun', 'mci': 'mci', 'spu': 'tot', 'thfc': 'tot', 'spr': 'tot',
      'wol': 'wol', 'nfo': 'nfo', 'avl': 'avl', 'bha': 'bha', 'bre': 'bre',
      'bou': 'bou', 'bur': 'bur', 'che': 'che', 'cry': 'cry', 'eve': 'eve',
      'ful': 'ful', 'lee': 'lee', 'liv': 'liv', 'new': 'new', 'sun': 'sun',
      'whu': 'whu', 'ars': 'ars',
    };
    const al = aliases[code];
    if (al && byShort.has(al)) return byShort.get(al)!;
    // Fuzzy name match: "Tottenham Hotspur" → starts-with check against our names.
    const ln = name.toLowerCase();
    for (const t of teams) {
      const tn = t.name.toLowerCase();
      if (tn.startsWith(ln.split(' ')[0]) || ln.startsWith(tn.split(' ')[0])) return t.id;
    }
    return null;
  };
}

async function main() {
  console.log('→ fetching FFS team-news…');
  const html = await fetchPage();
  console.log(`→ ${(html.length / 1024).toFixed(0)} kB fetched`);

  const teams = parsePage(html);
  console.log(`→ parsed ${teams.length} teams`);
  if (teams.length < 15) {
    console.warn('⚠ parsed fewer than 15 teams — page structure may have changed');
  }

  const resolveTeamId = await buildTeamLookup();
  let inserted = 0;
  let skipped = 0;
  for (const t of teams) {
    const teamId = resolveTeamId(t.code, t.name);
    if (!teamId) {
      console.warn(`  unresolved: code=${t.code} name="${t.name}" — skipping`);
      skipped++;
      continue;
    }
    await sql`
      INSERT INTO team_news_external (
        team_id, source, source_label, source_url,
        next_match, formation, predicted_xi,
        out_list, doubts, banned,
        latest_news, last_updated_at, fetched_at
      ) VALUES (
        ${teamId}, ${SOURCE_KEY}, ${SOURCE_LABEL}, ${FFS_URL},
        ${t.nextMatch}, ${t.formation}, ${json(t.predictedXi)},
        ${json(t.out)}, ${json(t.doubts)}, ${json(t.banned)},
        ${t.latestNews}, ${t.lastUpdated}, now()
      )
      ON CONFLICT (team_id, source) DO UPDATE SET
        next_match     = EXCLUDED.next_match,
        formation      = EXCLUDED.formation,
        predicted_xi   = EXCLUDED.predicted_xi,
        out_list       = EXCLUDED.out_list,
        doubts         = EXCLUDED.doubts,
        banned         = EXCLUDED.banned,
        latest_news    = EXCLUDED.latest_news,
        last_updated_at = EXCLUDED.last_updated_at,
        fetched_at     = now()
    `;
    inserted++;
  }
  console.log(`→ done. ${inserted} stored · ${skipped} skipped.`);
  await sql.end({ timeout: 1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
