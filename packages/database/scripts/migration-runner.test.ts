import { describe, expect, it } from 'bun:test';

import { runPendingMigrations, type Migration } from './migration-runner';

const migrations: Migration[] = [
  { name: '0001.sql', checksum: 'aaa', sql: 'CREATE TABLE first_table (id int)' },
  { name: '0002.sql', checksum: 'bbb', sql: 'CREATE TABLE second_table (id int)' },
];

describe('runPendingMigrations', () => {
  it('records applied migrations and skips all SQL on a second run', async () => {
    const applied = new Map<string, string>();
    const executions: string[] = [];
    const store = {
      readApplied: async () => new Map(applied),
      apply: async (migration: Migration) => {
        executions.push(migration.name);
        applied.set(migration.name, migration.checksum);
      },
    };

    expect(await runPendingMigrations(migrations, store)).toBe(2);
    expect(await runPendingMigrations(migrations, store)).toBe(0);
    expect(executions).toEqual(['0001.sql', '0002.sql']);
  });

  it('rejects a changed checksum before executing any SQL', async () => {
    const executions: string[] = [];
    const store = {
      readApplied: async () => new Map([['0001.sql', 'changed'], ['0002.sql', 'bbb']]),
      apply: async (migration: Migration) => { executions.push(migration.name); },
    };

    await expect(runPendingMigrations(migrations, store)).rejects.toThrow('checksum mismatch for 0001.sql');
    expect(executions).toEqual([]);
  });
});
