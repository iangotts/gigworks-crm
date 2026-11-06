// Apply database migrations (and optionally the seed). Runs as the database owner. Needs no psql, so it works
// inside the deployed container. It uses the same schema_migrations table as scripts/db.sh, so the two agree.
//
//   node dist/cli/migrate.js            apply any migrations not yet applied
//   node dist/cli/migrate.js --seed     also load the tenants and import rules (safe to repeat)
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../config.js';

const { values } = parseArgs({ options: { seed: { type: 'boolean' } } });
const root = fileURLToPath(new URL('../../db/', import.meta.url));
const client = new pg.Client({ connectionString: loadConfig().databaseUrl });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  // One process at a time, so two instances starting together cannot both apply the same file.
  await client.query('SELECT pg_advisory_lock(727274)');
  const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  const files = readdirSync(`${root}migrations`).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const f of files) {
    const version = f.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    console.log(`applying ${version}`);
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(`${root}migrations/${f}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      applied++;
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${version} failed and was rolled back: ${(e as Error).message}`);
    }
  }
  console.log(applied ? 'migrations up to date' : 'migrations already up to date');
  if (values.seed) {
    await client.query(readFileSync(`${root}seeds/001_tenants_and_import_rules.sql`, 'utf8'));
    console.log('seeded');
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
  await client.end();
}
