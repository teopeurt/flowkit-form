import { describe, expect, it } from 'bun:test';

import { assertDisposableLocalDatabase, type DatabaseIdentity } from './local-database-guard';

const localIdentity: DatabaseIdentity = {
  database: 'flowkit_demo',
  marker: 'flowkit_starter_identity',
  tls: false,
};

function config(databaseUrl: string, identity: DatabaseIdentity = localIdentity) {
  let probes = 0;
  return {
    input: {
      databaseUrl,
      probe: async () => {
        probes += 1;
        return identity;
      },
    },
    probes: () => probes,
  };
}

describe('assertDisposableLocalDatabase', () => {
  it.each([
    'postgresql://user:password@localhost:5441/flowkit_demo',
    'postgres://user:password@127.0.0.1:5441/flowkit_demo',
    'postgresql://user:password@[::1]:5441/flowkit_demo',
    'postgresql://user:password@postgres:5432/flowkit_demo',
  ])('accepts the disposable target at %s after probing its server identity', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).resolves.toBeUndefined();
    expect(target.probes()).toBe(1);
  });

  it.each([
    'postgresql://user:password@localhost:5441/flowkit_demo_backup',
    'postgresql://user:password@localhost:5441/renamed_demo',
  ])('rejects a renamed database before opening a connection', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('exact flowkit_demo database');
    expect(target.probes()).toBe(0);
  });

  it.each([
    'postgresql://user:password@db.internal:5432/flowkit_demo',
    'postgresql://user:password@company.rds.amazonaws.com:5432/flowkit_demo',
    'postgresql://user:password@cluster.supabase.co:5432/flowkit_demo',
  ])('rejects remote and cloud hosts before opening a connection', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('local or Compose PostgreSQL host');
    expect(target.probes()).toBe(0);
  });

  it.each([
    'postgresql://user:password@localhost:5441/flowkit_demo?sslmode=require',
    'postgresql://user:password@localhost:5441/flowkit_demo?ssl=true',
  ])('rejects a target that requires TLS before opening a connection', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('must not require TLS');
    expect(target.probes()).toBe(0);
  });

  it('rejects a server session that actually uses TLS', async () => {
    const target = config('postgresql://user:password@localhost:5441/flowkit_demo', {
      ...localIdentity,
      tls: true,
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('reported a TLS session');
  });

  it.each([null, 'wrong-starter'])('rejects a missing or mismatched server marker', async (marker) => {
    const target = config('postgresql://user:password@localhost:5441/flowkit_demo', {
      ...localIdentity,
      marker,
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('disposable database marker');
  });

  it('rejects a server whose active database differs from the URL', async () => {
    const target = config('postgresql://user:password@localhost:5441/flowkit_demo', {
      ...localIdentity,
      database: 'postgres',
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('server confirmed database postgres');
  });

  it.each([
    'not a URL',
    'https://localhost:5441/flowkit_demo',
    'postgresql://localhost:5441',
    'postgresql://localhost:5441/flowkit_demo/extra',
  ])('rejects the malformed database target %s without revealing it', async (databaseUrl) => {
    const target = config(databaseUrl);

    try {
      await assertDisposableLocalDatabase(target.input);
      throw new Error('expected the guard to reject');
    } catch (error) {
      expect(String(error)).not.toContain('user:password');
    }
    expect(target.probes()).toBe(0);
  });
});
