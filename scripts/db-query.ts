/**
 * Ad-hoc DB query runner.
 *
 *   npm run db:query -- 'SELECT id, web_name FROM players LIMIT 5'
 *   npm run db:query -- "$(cat foo.sql)"
 *
 * Reads .env.local via the standard tsx pipeline. The whole point of this
 * script is that you don't need psql installed locally to inspect the DB —
 * we just reuse the project's `postgres` client.
 *
 * Read-only by convention. There's no guard against UPDATE/DELETE — be
 * careful what you paste in. Use a Neon branch if you want a sandbox.
 */
import { sql } from '@/lib/db/client';

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: npm run db:query -- "SELECT ..."');
    process.exit(1);
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await sql.unsafe(query)) as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    console.error('Query failed:');
    console.error((err as Error).message);
    process.exit(2);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('(no rows)');
    await sql.end({ timeout: 1 });
    return;
  }

  printTable(rows);
  console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})`);
  await sql.end({ timeout: 1 });
}

function printTable(rows: Array<Record<string, unknown>>) {
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c =>
    Math.max(
      c.length,
      ...rows.map(r => fmt(r[c]).length)
    )
  );
  const sep  = widths.map(w => '─'.repeat(w + 2)).join('┼');
  const head = cols.map((c, i) => ' ' + pad(c, widths[i]) + ' ').join('│');
  console.log(head);
  console.log(sep);
  for (const r of rows) {
    console.log(cols.map((c, i) => ' ' + pad(fmt(r[c]), widths[i]) + ' ').join('│'));
  }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
