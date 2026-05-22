'use client';

/**
 * Last-resort error boundary. Catches errors thrown by the root layout
 * itself (and anything else error.tsx doesn't catch). Must render its
 * own <html> + <body> because the root layout has crashed.
 *
 * Because this is the absolute fallback, no Tailwind classes are
 * applied — we cannot rely on the app's design tokens having loaded.
 * Plain inline styles only.
 */
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[Trading Desk] global error', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{
        margin: 0, fontFamily: 'ui-monospace, monospace',
        background: '#0a0a0a', color: '#e7e7e7',
        minHeight: '100vh', padding: '40px 20px'
      }}>
        <div style={{ maxWidth: 720, margin: '60px auto' }}>
          <div style={{ color: '#ff6b6b', fontSize: 12, textTransform: 'uppercase', letterSpacing: 2 }}>
            Fatal error
          </div>
          <h1 style={{ fontSize: 22, marginTop: 8 }}>
            The Trading Desk crashed before it could load.
          </h1>
          <pre style={{
            background: '#1a1a1a', border: '1px solid #2a2a2a',
            borderRadius: 6, padding: 12, marginTop: 16,
            fontSize: 11, overflow: 'auto', maxHeight: 320,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word'
          }}>
            {error.message || 'Unknown error'}
            {error.digest && `\n\n— digest —\n${error.digest}`}
          </pre>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 16, padding: '6px 12px',
              background: '#3ddc97', color: '#0a0a0a',
              border: 0, borderRadius: 6, cursor: 'pointer',
              fontFamily: 'inherit'
            }}
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  );
}
