import { NextRequest, NextResponse } from 'next/server';

/**
 * Authenticate scheduled-job requests. GitHub Actions posts with a Bearer
 * token; the user pressing the manual Refresh button uses the session cookie
 * (TODO: real auth — v1 ships with shared-secret only).
 */
export function requireIngestSecret(req: NextRequest): NextResponse | null {
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'INGEST_SECRET not configured' }, { status: 500 });
  }
  const header = req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

/** Tiny JSON helper to keep route bodies uncluttered. */
export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}
export function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}
