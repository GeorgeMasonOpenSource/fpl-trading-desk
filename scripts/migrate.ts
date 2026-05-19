#!/usr/bin/env tsx
/**
 * Idempotent migration runner. Reads every .sql under db/migrations,
 * splits on `-- statement-end` if present (default: full file as one batch),
 * and records the version in schema_migrations.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

async function main() {
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set DIRECT_DATABASE_URL (preferred) or DATABASE_URL');
  const sql = postgres(url, { max: 1, prepare: false });

  const dir = join(process.cwd(), 'db', 'migrations');
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    const [{ exists }] = await sql<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = ${version}) AS exists
    `;
    if (exists) {
      console.log(`✓ ${version} already applied`);
      continue;
    }
    console.log(`→ applying ${version}`);
    const text = await readFile(join(dir, f), 'utf8');
    await sql.unsafe(text);
    await sql`INSERT INTO schema_migrations (version) VALUES (${version}) ON CONFLICT DO NOTHING`;
    console.log(`✓ ${version} applied`);
  }
  await sql.end();
}

main().catch(err => { console.error(err); process.exit(1); });
