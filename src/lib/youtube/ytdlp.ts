/**
 * yt-dlp caption fetcher.
 *
 * Why this exists: as of 2026, plain HTTP scraping of YouTube captions is
 * broken for unauthenticated clients. The watch page returns mangled JSON
 * for the captionTracks blob; the Innertube /player endpoint rejects
 * ANDROID/IOS client requests with HTTP 400 because they now demand a
 * PoToken (a signature derived in-browser via JavaScript); the TVHTML5
 * embedded client still answers, but its response no longer includes
 * caption tracks. yt-dlp's maintainers actively patch around all of these,
 * so we shell out rather than chase the moving target ourselves.
 *
 * Requirements:
 *   - yt-dlp must be on $PATH. macOS: `brew install yt-dlp`.
 *     Linux/GitHub Actions: `pip install yt-dlp`.
 *
 * Strategy:
 *   1. Probe for the binary at module init (cheap; cached for the process).
 *   2. For each video, spawn `yt-dlp --skip-download --write-auto-sub
 *      --sub-lang en --sub-format srv1 -o <tmpfile>.%(ext)s <url>`.
 *      srv1 is YouTube's XML timed-text format — same shape our existing
 *      parser handles.
 *   3. Read the resulting `<tmpfile>.en.srv1` and parse.
 *   4. Clean up the temp file.
 *
 * Cost: ~1.5 seconds per video on first run, faster after yt-dlp warms its
 * own internal caches. For a 20-video queue that's ~30 seconds — fine for
 * a 6-hourly cron.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptCue } from './transcript';

let ytDlpAvailability: 'unknown' | 'available' | 'missing' = 'unknown';
let ytDlpProbeError: string | null = null;

/**
 * Returns true if yt-dlp is available on $PATH. Probed once per process.
 * If false, callers should not invoke fetchViaYtDlp — they'll waste a few
 * hundred milliseconds spawning a process that immediately fails.
 */
export async function isYtDlpAvailable(): Promise<boolean> {
  if (ytDlpAvailability === 'available') return true;
  if (ytDlpAvailability === 'missing')   return false;
  try {
    await runProcess('yt-dlp', ['--version'], 5000);
    ytDlpAvailability = 'available';
    return true;
  } catch (err) {
    ytDlpAvailability = 'missing';
    ytDlpProbeError = (err as Error).message;
    return false;
  }
}

export function ytDlpProbeMessage(): string | null {
  return ytDlpProbeError;
}

export interface YtDlpResult {
  status: 'ok' | 'no_captions' | 'error';
  cues: TranscriptCue[];
  error?: string;
}

export async function fetchViaYtDlp(videoId: string): Promise<YtDlpResult> {
  const tmp = await mkdtemp(join(tmpdir(), 'ytdlp-'));
  try {
    // We write to a templated output path; yt-dlp adds .en.srv1 etc. itself.
    // --skip-download    don't fetch the video bytes
    // --write-auto-sub   include ASR (auto-generated) captions
    // --write-sub        include any manually uploaded captions
    // --sub-lang en      English only
    // --sub-format srv1  XML timed-text (same shape our parser already handles)
    // --no-warnings      keep stderr small
    // --quiet            suppress progress noise
    const outTemplate = join(tmp, 'cap.%(ext)s');
    const args = [
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', 'en',
      '--sub-format', 'srv1',
      '--no-warnings',
      '--quiet',
      '-o', outTemplate,
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
    ];
    try {
      await runProcess('yt-dlp', args, 30000);
    } catch (err) {
      return { status: 'error', cues: [], error: `yt-dlp exited: ${(err as Error).message}` };
    }

    // Find the produced subtitle file. yt-dlp names it cap.en.srv1 by default,
    // but it could be cap.en-orig.srv1 or similar if the channel manually
    // uploaded captions. Scan the temp dir for any *.srv1.
    const files = await readdir(tmp);
    const srv1 = files.find(f => f.endsWith('.srv1'));
    if (!srv1) {
      return { status: 'no_captions', cues: [], error: 'yt-dlp succeeded but no .srv1 was written' };
    }
    const xml = await readFile(join(tmp, srv1), 'utf8');
    const cues = parseSrv1(xml);
    if (cues.length === 0) {
      return { status: 'no_captions', cues: [], error: '.srv1 file was empty' };
    }
    return { status: 'ok', cues };
  } finally {
    // Tidy up regardless of outcome — don't leave temp dirs lying around.
    await rm(tmp, { recursive: true, force: true }).catch(() => void 0);
  }
}

/**
 * Spawn a process and reject if it exits non-zero, errors, or times out.
 * Returns stdout as a string.
 */
function runProcess(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`exit ${code}${stderr ? ` — ${stderr.trim().slice(0, 400)}` : ''}`));
    });
  });
}

/**
 * Parse YouTube's srv1 XML timed-text format.
 *   <transcript>
 *     <text start="12.345" dur="2.1">Some captioned text&amp;</text>
 *     ...
 *   </transcript>
 *
 * This is the same shape parseTimedTextXml in transcript.ts handles, but
 * srv1 sometimes uses single-quoted attributes. We accept either form.
 */
function parseSrv1(xml: string): TranscriptCue[] {
  const out: TranscriptCue[] = [];
  const re = /<text[^>]*\bstart=["']([\d.]+)["'][^>]*\bdur=["']([\d.]+)["'][^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const startSec = parseFloat(m[1]!);
    const durationSec = parseFloat(m[2]!);
    const text = decodeEntities(m[3]!);
    if (text.trim().length === 0) continue;
    out.push({ text, startSec, durationSec });
  }
  return out;
}

function decodeEntities(s: string): string {
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
