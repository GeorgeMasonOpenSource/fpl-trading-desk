/**
 * YouTube transcript fetcher.
 *
 * Strategy (in order — first one that returns captions wins):
 *
 *   1. Fetch the watch page with an age-gate bypass URL + a current Chrome
 *      UA. Try multiple regex patterns to locate the captionTracks JSON
 *      because YouTube serves several variants of the page shell depending
 *      on IP/UA/A-B-test bucket. We accept escaped and unescaped forms.
 *
 *   2. If the watch page doesn't surface captionTracks, fall back to the
 *      youtubei/v1/player endpoint. This is the same JSON the watch page
 *      hydrates from but it's served with a stable schema and doesn't
 *      depend on the page-shell HTML variant.
 *
 *   3. Once we have a track URL, fetch the timed-text XML (or JSON3 with
 *      &fmt=json3 if XML fails) and parse.
 *
 * Why not the `youtube-transcript` npm package: avoids a new dependency,
 * and those packages break frequently when YouTube changes its HTML. A
 * ~150-line fetcher we own is easier to repair.
 *
 * IMPORTANT: YouTube may rate-limit / block requests from AWS / Vercel IP
 * ranges. The recommended run target is a local laptop or a GitHub Actions
 * runner (Azure-hosted), not Vercel functions.
 */
export interface TranscriptCue {
  text: string;
  startSec: number;
  durationSec: number;
}

export type TranscriptStatus = 'ok' | 'no_captions' | 'error' | 'skipped_old_gw';

export interface TranscriptResult {
  status: TranscriptStatus;
  cues: TranscriptCue[];
  error?: string;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { simpleText?: string };
}

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/**
 * Public entry point — try every method in order and return the first cues
 * we manage to parse. Returns a `no_captions` with a specific `error`
 * field explaining which step failed (helps debugging when the run is
 * silent on stdout).
 */
export async function fetchTranscript(videoId: string): Promise<TranscriptResult> {
  // Try every strategy in order. First one that returns cues wins. We log
  // each failure into a composite error message so the caller (and the
  // probe script) can see exactly what each strategy said.
  const attempts: Array<{ name: string; run: () => Promise<TranscriptResult> }> = [
    { name: 'watch-page',           run: () => fetchViaWatchPage(videoId) },
    { name: 'innertube-android',    run: () => fetchViaPlayerApi(videoId, ANDROID_CLIENT) },
    { name: 'innertube-ios',        run: () => fetchViaPlayerApi(videoId, IOS_CLIENT) },
    { name: 'innertube-tvhtml5',    run: () => fetchViaPlayerApi(videoId, TVHTML5_CLIENT) }
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const r = await a.run();
      if (r.status === 'ok') return r;
      errors.push(`${a.name}: ${r.status}${r.error ? ` — ${r.error}` : ''}`);
    } catch (err) {
      errors.push(`${a.name}: throw — ${(err as Error).message}`);
    }
  }
  return {
    status: 'no_captions',
    cues: [],
    error: errors.join(' | ')
  };
}

// Innertube client variants. Each ships a different schema + sometimes
// returns captionTracks when the others don't.
//   ANDROID — most permissive historically, but sometimes blocked in 2025
//   IOS     — alternative mobile shape; ships cleaner caption metadata
//   TVHTML5_SIMPLY_EMBEDDED_PLAYER — the "embedded TV player" shape;
//             often the LAST line of defence because YouTube can't easily
//             distinguish a legitimate smart-TV client from a scraper.
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '19.09.37',
  androidSdkVersion: 30,
  hl: 'en', gl: 'US'
};
const IOS_CLIENT = {
  clientName: 'IOS',
  clientVersion: '19.09.3',
  deviceModel: 'iPhone14,3',
  hl: 'en', gl: 'US'
};
const TVHTML5_CLIENT = {
  clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
  clientVersion: '2.0',
  hl: 'en', gl: 'US'
};

/* ---------------------------------------------------------------------------
 * Strategy 1: scrape the watch page
 * -------------------------------------------------------------------------*/
async function fetchViaWatchPage(videoId: string): Promise<TranscriptResult> {
  // bpctr=9999999999 → past the age-gate timestamp check.
  // has_verified=1   → tells the page we've already passed the age gate.
  // hl=en            → request the English page shell.
  const watchUrl =
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` +
    `&hl=en&bpctr=9999999999&has_verified=1`;

  const res = await fetch(watchUrl, {
    headers: {
      'user-agent': CHROME_UA,
      'accept-language': ACCEPT_LANGUAGE,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    cache: 'no-store'
  });
  if (!res.ok) {
    return {
      status: 'error',
      cues: [],
      error: `watch page HTTP ${res.status}`
    };
  }
  const html = await res.text();
  const tracks = extractCaptionTracks(html);
  if (!tracks) {
    return {
      status: 'no_captions',
      cues: [],
      error: 'no captionTracks block in watch page HTML'
    };
  }
  if (tracks.length === 0) {
    return {
      status: 'no_captions',
      cues: [],
      error: 'captionTracks array is empty'
    };
  }
  return fetchTrack(pickEnglishTrack(tracks));
}

/* ---------------------------------------------------------------------------
 * Strategy 2: youtubei/v1/player JSON endpoint
 *
 * This is the same API the YouTube web client uses to hydrate. It's
 * unofficial (no API key required, but YouTube can change it) and tends
 * to keep returning captionTracks even when the watch-page HTML A/B-test
 * variant strips them.
 * -------------------------------------------------------------------------*/
async function fetchViaPlayerApi(
  videoId: string,
  client: Record<string, unknown>
): Promise<TranscriptResult> {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Each client variant ships a tailored UA so YouTube treats the
      // request as coming from that platform. Without this, YouTube
      // sometimes downgrades the response to a stricter shell.
      'user-agent': clientUserAgent(client.clientName as string),
      'accept-language': ACCEPT_LANGUAGE,
      'origin': 'https://www.youtube.com',
      'referer': 'https://www.youtube.com/',
      // Some Innertube schemas require this to surface caption metadata.
      'x-youtube-client-name': clientNumericId(client.clientName as string),
      'x-youtube-client-version': String(client.clientVersion ?? '')
    },
    body: JSON.stringify({
      videoId,
      context: { client }
    }),
    cache: 'no-store'
  });
  if (!res.ok) {
    return {
      status: 'error',
      cues: [],
      error: `player API HTTP ${res.status}`
    };
  }
  const json = await res.json() as any;
  const tracks: CaptionTrack[] | undefined =
    json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    return {
      status: 'no_captions',
      cues: [],
      error: 'player API returned no captionTracks'
    };
  }
  return fetchTrack(pickEnglishTrack(tracks));
}

/** Map an Innertube client name to a representative User-Agent. */
function clientUserAgent(name: string): string {
  switch (name) {
    case 'ANDROID':
      return 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip';
    case 'IOS':
      return 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 17_0 like Mac OS X)';
    case 'TVHTML5_SIMPLY_EMBEDDED_PLAYER':
      return 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 ' +
             '(KHTML, like Gecko) Version/13.0 Safari/605.1.15';
    default:
      return CHROME_UA;
  }
}

/** Numeric client IDs YouTube uses internally; some endpoints check both. */
function clientNumericId(name: string): string {
  switch (name) {
    case 'ANDROID':                       return '3';
    case 'IOS':                           return '5';
    case 'TVHTML5_SIMPLY_EMBEDDED_PLAYER': return '85';
    default:                              return '1';   // WEB
  }
}

/* ---------------------------------------------------------------------------
 * Caption extraction helpers
 * -------------------------------------------------------------------------*/

/**
 * Try several regex patterns to extract the captionTracks JSON array from
 * a watch-page HTML blob. YouTube's page shell varies (server-side
 * rendered vs hydration-data vs alt-data-block), so we try in order:
 *
 *   1. `"captionTracks":[...]` — most common
 *   2. `\"captionTracks\":[...]` — escaped, when nested inside an outer JSON string
 *   3. `'captionTracks': [...]` — single-quote variant (rare)
 */
function extractCaptionTracks(html: string): CaptionTrack[] | null {
  const patterns: RegExp[] = [
    /"captionTracks":(\[[\s\S]*?\])/,
    /\\"captionTracks\\":(\[[\s\S]*?\])/,
    /'captionTracks':\s*(\[[\s\S]*?\])/
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      // Both `&` (raw &) and `\\u0026` (double-escaped &) appear in
      // different variants. Normalise both so JSON.parse doesn't choke.
      const cleaned = m[1]!
        .replace(/\\\\u0026/g, '&')
        .replace(/\\u0026/g, '&')
        .replace(/\\"/g, '"');
      return JSON.parse(cleaned) as CaptionTrack[];
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Prefer manually-uploaded English captions (highest quality), fall back
 * to ASR English (auto-generated), then any English variant, then any
 * track at all. The caller should NOT trust kind === 'asr' tracks blindly
 * — they're noisy and our extractor lowers confidence accordingly.
 */
function pickEnglishTrack(tracks: CaptionTrack[]): CaptionTrack {
  return (
    tracks.find(t => t.languageCode === 'en' && !t.kind) ??
    tracks.find(t => t.languageCode === 'en' && t.kind === 'asr') ??
    tracks.find(t => t.languageCode === 'en') ??
    tracks[0]!
  );
}

/**
 * Fetch a caption track URL. Try the default XML format first; if it
 * comes back empty (which happens occasionally for fresh ASR), retry
 * with &fmt=json3 and parse that.
 */
async function fetchTrack(track: CaptionTrack): Promise<TranscriptResult> {
  try {
    const xml = await (await fetch(track.baseUrl, {
      headers: { 'user-agent': CHROME_UA, 'accept-language': ACCEPT_LANGUAGE },
      cache: 'no-store'
    })).text();
    const xmlCues = parseTimedTextXml(xml);
    if (xmlCues.length > 0) return { status: 'ok', cues: xmlCues };

    // JSON3 fallback — separated by the &fmt= query param.
    const jsonUrl = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    const json = await (await fetch(jsonUrl, {
      headers: { 'user-agent': CHROME_UA, 'accept-language': ACCEPT_LANGUAGE },
      cache: 'no-store'
    })).json() as any;
    const jsonCues = parseJson3(json);
    if (jsonCues.length > 0) return { status: 'ok', cues: jsonCues };

    return {
      status: 'no_captions',
      cues: [],
      error: 'caption track URL returned no cues in XML or JSON3 format'
    };
  } catch (err) {
    return { status: 'error', cues: [], error: (err as Error).message };
  }
}

/**
 * Parse the XML format YouTube returns by default:
 *   <text start="12.345" dur="2.1">Some captioned text&amp;amp;</text>
 */
function parseTimedTextXml(xml: string): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  const re = /<text[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const startSec = parseFloat(m[1]!);
    const durationSec = parseFloat(m[2]!);
    const text = decodeHtmlEntities(m[3]!);
    if (text.trim().length === 0) continue;
    out.push({ text, startSec, durationSec });
  }
  return out;
}

/**
 * Parse YouTube's JSON3 timed-text format:
 *   { events: [ { tStartMs, dDurationMs, segs: [ { utf8: "..." } ] }, ... ] }
 */
function parseJson3(json: any): TranscriptCue[] {
  const events = Array.isArray(json?.events) ? json.events : [];
  const out: TranscriptCue[] = [];
  for (const ev of events) {
    if (typeof ev?.tStartMs !== 'number') continue;
    const segs: Array<{ utf8?: string }> = Array.isArray(ev.segs) ? ev.segs : [];
    const text = segs.map(s => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({
      text,
      startSec: ev.tStartMs / 1000,
      durationSec: (typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 0) / 1000
    });
  }
  return out;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#10;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
