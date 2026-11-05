import { describe, expect, it } from 'bun:test';

import { liveHealth, readyHealth, type ReadinessProbe } from '../apps/api/src/health.responses';

describe('health responses', () => {
  it('reports liveness without opening dependencies', () => {
    expect(liveHealth()).toEqual({ status: 'ok', service: 'flowkit-demo' });
  });

  it('reports readiness when the database responds', async () => {
    const probe: ReadinessProbe = { ping: async () => undefined };
    await expect(readyHealth(probe)).resolves.toEqual({
      status: 'ready',
      definition: 'leave-approval-demo@1',
      database: 'ok',
    });
  });

  it('throws when the database is unavailable', async () => {
    const probe: ReadinessProbe = { ping: async () => { throw new Error('database down'); } };
    await expect(readyHealth(probe)).rejects.toThrow('database down');
  });
});
