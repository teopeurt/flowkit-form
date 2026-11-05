export interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationStore {
  readApplied(): Promise<Map<string, string>>;
  apply(migration: Migration): Promise<void>;
}

export async function runPendingMigrations(
  migrations: readonly Migration[],
  store: MigrationStore,
): Promise<number> {
  const applied = await store.readApplied();

  for (const migration of migrations) {
    const checksum = applied.get(migration.name);
    if (checksum !== undefined && checksum !== migration.checksum) {
      throw new Error(`Migration checksum mismatch for ${migration.name}; no migration SQL was executed.`);
    }
  }

  const pending = migrations.filter((migration) => !applied.has(migration.name));
  for (const migration of pending) await store.apply(migration);
  return pending.length;
}
