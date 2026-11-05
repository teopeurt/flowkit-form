import { loadConfig } from '@flowkit-demo/domain';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withMigrationClient } from '../src/client';
import { runPendingMigrations, type Migration } from './migration-runner';

const config = loadConfig();
const database = new URL(config.DATABASE_URL).pathname.slice(1);
if (!/^flowkit_demo(?:_test_)?/.test(database)) throw new Error(`Refusing migration for database ${database}`);
if (process.env.FLOWKIT_DEMO_MIGRATION_APPROVED !== 'true') throw new Error('Migration is guarded. Set FLOWKIT_DEMO_MIGRATION_APPROVED=true only after explicit approval. No migration was applied.');
const migrationDirectory = resolve(import.meta.dir, '../migrations');
const migrationFiles = (await readdir(migrationDirectory))
  .filter((file) => file.endsWith('.sql'))
  .sort((left, right) => left.localeCompare(right));
if (migrationFiles.length === 0) throw new Error('No demo migrations were found.');
const migrations: Migration[] = await Promise.all(migrationFiles.map(async (name) => {
  const sql = await readFile(resolve(migrationDirectory, name), 'utf8');
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}));
let appliedCount = 0;
await withMigrationClient(async (client) => {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS flowkit_demo_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client`SELECT pg_advisory_lock(hashtext('flowkit_demo_migrations'))`;
  try {
    appliedCount = await runPendingMigrations(migrations, {
      readApplied: async () => {
        const rows = await client<{ name: string; checksum: string }[]>`
          SELECT name, checksum FROM flowkit_demo_migrations ORDER BY name
        `;
        return new Map(rows.map((row) => [row.name, row.checksum]));
      },
      apply: async (migration) => {
        await client.begin(async (transaction) => {
          await transaction.unsafe(migration.sql);
          await transaction`
            INSERT INTO flowkit_demo_migrations (name, checksum)
            VALUES (${migration.name}, ${migration.checksum})
          `;
        });
      },
    });
  } finally {
    await client`SELECT pg_advisory_unlock(hashtext('flowkit_demo_migrations'))`;
  }
});
process.stdout.write(`${appliedCount} migration(s) applied to FlowKit database ${database}; ${migrations.length - appliedCount} already current.\n`);
