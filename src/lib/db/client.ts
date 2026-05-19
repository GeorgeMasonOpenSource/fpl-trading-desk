import postgres from 'postgres';

// One module-scoped postgres client. On Vercel serverless each runtime gets its
// own instance; on local dev this is shared across hot reloads.
//
// We use `postgres` (not @neondatabase/serverless) for portability — works
// against any pooled or unpooled Postgres URL including Neon, local Docker,
// Supabase, etc. Cost-friendly: a single TCP socket per lambda.
declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set');
  }
  return postgres(url, {
    max: 1,                  // serverless friendly
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,          // Neon pooled mode doesn't support prepared statements
    // Postgres NUMERIC/DECIMAL types default to strings (because they can be
    // arbitrary precision). All our NUMERIC columns are small probabilities or
    // points — safe to coerce to JS Number so downstream arithmetic and
    // `.toFixed()` calls work without manual Number() wrapping everywhere.
    types: {
      bigint: postgres.BigInt, // keep BIGINT as BigInt
      numeric: {
        to:     0,             // pg type lookup (oid 1700) — `to` unused for parsing
        from:   [1700],        // NUMERIC oid
        serialize: (x: unknown) => x as any,
        parse:  (x: string) => Number(x)
      }
    }
  });
}

export const sql = global.__sql ?? makeClient();
if (process.env.NODE_ENV !== 'production') {
  global.__sql = sql;
}

/**
 * `sql.json` is strictly typed against postgres.js's JSONValue, which doesn't
 * play well with our domain types. We cast through `any` here so call-sites
 * can pass arrays-of-objects, ProjectionReason[], etc. without ceremony.
 */
export const json = (v: unknown) => sql.json(v as any);
