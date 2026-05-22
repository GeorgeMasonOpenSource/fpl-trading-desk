'use client';

/**
 * Route-segment error boundary. Catches any error thrown by a server
 * component inside the app/ tree (except the root layout itself — that's
 * what global-error.tsx is for).
 *
 * Why this exists: if a query in the dashboard or any page throws, Next.js
 * by default renders a black 500 page with no information. Replacing it
 * with a styled fallback that surfaces the error message turns a
 * mysterious "page not loading" into something diagnosable in < 30 seconds.
 */
import { useEffect } from 'react';

export default function RouteError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Log on the client too so the browser console shows the same info
  // Vercel's runtime logs will. Helps when you're checking on a phone
  // with no DevTools attached.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[Trading Desk] route error', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-8">
      <div className="max-w-xl w-full bg-bg-card border border-accent-red/40 rounded-card p-6 space-y-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-accent-red">Something broke</div>
          <h1 className="text-xl font-semibold mt-1">This page hit a runtime error.</h1>
        </div>
        <pre className="text-[11px] font-mono bg-bg-inset border border-line rounded-md p-3 overflow-auto max-h-64 whitespace-pre-wrap break-words">
          {error.message || 'Unknown error'}
          {error.digest && (
            <>
              {'\n\n— digest —\n'}
              {error.digest}
            </>
          )}
          {error.stack && (
            <>
              {'\n\n— stack —\n'}
              {error.stack.split('\n').slice(0, 12).join('\n')}
            </>
          )}
        </pre>
        <div className="flex gap-2 text-sm">
          <button
            onClick={() => reset()}
            className="bg-accent-green/90 hover:bg-accent-green text-bg px-3 py-1 rounded-md font-medium"
          >
            Retry
          </button>
          <a
            href="/"
            className="bg-bg-inset hover:bg-bg-raised text-ink px-3 py-1 rounded-md"
          >
            Home
          </a>
        </div>
        <p className="text-[11px] text-ink-dim">
          The error has been logged. Vercel runtime logs are at{' '}
          <code className="font-mono">/observability</code>; check there for the
          full stack trace.
        </p>
      </div>
    </div>
  );
}
