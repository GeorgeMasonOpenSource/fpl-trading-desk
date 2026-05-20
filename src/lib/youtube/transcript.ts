/**
 * YouTube transcript fetcher.
 *
 * Strategy:
 *   1. Hit the watch page to extract the auto-caption track URL embedded in
 *      ytInitialPlayerResponse JSON.
 *   2. Fetch that URL — returns either XML (<text start="..." dur="...">) or
 *      JSON3 format depending on the &fmt= param.
 *   3. Parse into a flat list of {text, startSec, durationSec}.
 *
 * Why not the `youtube-transcript` npm package: avoids a new dependency, and
 * those packages break frequently when YouTube changes its HTML. A 60-line
 * fetcher we own is easier to repair.
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

export type TranscriptStatus = 'ok' | 'no_captions' | 'error';

export interface TranscriptResult {
  status: TranscriptStatus;
  cues: TranscriptCue[];
  error?: string;
}

export async function fetchTranscript(videoId: string): Promise<TranscriptResult> {
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
    const html = await (await fetch(watchUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9'
      },
      cache: 'no-store'
    })).text();

    // Locate the captionTracks array inside ytInitialPlayerResponse.
    const captionMatch = html.match(/"captionTracks":(\[[\s\S]*?\])/);
    if (!captionMatch) return { status: 'no_captions', cues: [] };
    const tracks: Array<{ baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string } }> =
      JSON.parse(captionMatch[1]!.replace(/\\u0026/g, '&'));
    if (tracks.length === 0) return { status: 'no_captions', cues: [] };

    // Prefer manually-uploaded English, fall back to ASR English, then any English.
    const pick =
      tracks.find(t => t.languageCode === 'en' && !t.kind) ??
      tracks.find(t => t.languageCode === 'en' && t.kind === 'asr') ??
      tracks.find(t => t.languageCode === 'en') ??
      tracks[0]!;

    const transcriptXml = await (await fetch(pick.baseUrl, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      cache: 'no-store'
    })).text();

    const cues = parseTimedTextXml(transcriptXml);
    return { status: cues.length > 0 ? 'ok' : 'no_captions', cues };
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
    const text = decode(m[3]!);
    if (text.trim().length === 0) continue;
    out.push({ text, startSec, durationSec });
  }
  return out;
}

function decode(s: string): string {
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
