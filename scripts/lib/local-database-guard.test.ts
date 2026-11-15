import { describe, expect, it } from 'bun:test';

import { assertDisposableLocalDatabase, type DatabaseIdentity } from './local-database-guard';

const localIdentity: DatabaseIdentity = {
  database: 'flowkitform',
  marker: 'flowkitform_identity',
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
    'postgresql://user:password@localhost:5441/flowkitform',
    'postgres://user:password@127.0.0.1:5441/flowkitform',
    'postgresql://user:password@[::1]:5441/flowkitform',
    'postgresql://user:password@postgres:5432/flowkitform',
  ])('accepts the disposable target at %s after probing its server identity', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).resolves.toBeUndefined();
    expect(target.probes()).toBe(1);
  });

  it.each([
    'postgresql://user:password@localhost:5441/flowkitform_backup',
    'postgresql://user:password@localhost:5441/renamed_demo',
  ])('rejects a renamed database before opening a connection', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('exact flowkitform database');
    expect(target.probes()).toBe(0);
  });

  it.each([
    'postgresql://user:password@db.internal:5432/flowkitform',
    'postgresql://user:password@company.rds.amazonaws.com:5432/flowkitform',
    'postgresql://user:password@cluster.supabase.co:5432/flowkitform',
  ])('rejects remote and cloud hosts before opening a connection', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('local or Compose PostgreSQL host');
    expect(target.probes()).toBe(0);
  });

  it.each([
    'postgresql://user:password@localhost:5441/flowkitform?sslmode=require',
    'postgresql://user:password@localhost:5441/flowkitform?ssl=true',
  ])('rejects a target that requires TLS before opening a connection', async (databaseUrl) => {
    const target = config(databaseUrl);

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('must not require TLS');
    expect(target.probes()).toBe(0);
  });

  it('rejects a server session that actually uses TLS', async () => {
    const target = config('postgresql://user:password@localhost:5441/flowkitform', {
      ...localIdentity,
      tls: true,
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('reported a TLS session');
  });

  it.each([null, 'wrong-starter'])('rejects a missing or mismatched server marker', async (marker) => {
    const target = config('postgresql://user:password@localhost:5441/flowkitform', {
      ...localIdentity,
      marker,
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('disposable database marker');
  });

  it('rejects a server whose active database differs from the URL', async () => {
    const target = config('postgresql://user:password@localhost:5441/flowkitform', {
      ...localIdentity,
      database: 'postgres',
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('server confirmed database postgres');
  });

  it('rejects the retired flowkit_demo database name in the URL', async () => {
    const target = config('postgresql://user:password@localhost:5441/flowkit_demo');

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('must name the exact flowkitform database');
    expect(target.probes()).toBe(0);
  });

  it('rejects a server still reporting the retired database identity', async () => {
    const target = config('postgresql://user:password@localhost:5441/flowkitform', {
      ...localIdentity,
      database: 'flowkit_demo',
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('server confirmed database flowkit_demo');
  });

  it('rejects a renamed database still carrying the retired cluster marker', async () => {
    const target = config('postgresql://user:password@localhost:5441/flowkitform', {
      ...localIdentity,
      marker: 'flowkit_starter_identity',
    });

    await expect(assertDisposableLocalDatabase(target.input)).rejects.toThrow('disposable database marker');
  });

  it.each([
    'not a URL',
    'https://localhost:5441/flowkitform',
    'postgresql://localhost:5441',
    'postgresql://localhost:5441/flowkitform/extra',
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
