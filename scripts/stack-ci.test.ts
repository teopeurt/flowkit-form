import { describe, expect, it } from 'bun:test';

import {
  cleanupCiStack,
  createCiStackPlan,
  waitForCiReadiness,
} from './stack-ci';
import type { ChildProcessHandle, ProcessSignal } from './lib/process-supervisor';

class HungChild implements ChildProcessHandle {
  readonly exited = new Promise<number>(() => {});
  readonly signals: ProcessSignal[] = [];
  constructor(private readonly events: string[]) {}
  kill(signal: ProcessSignal) {
    this.signals.push(signal);
    this.events.push(signal);
  }
}

describe('createCiStackPlan', () => {
  it('builds the guarded disposable stack, migration, seed, browser, and cleanup path', () => {
    const plan = createCiStackPlan({
      CI: 'true',
      NODE_ENV: 'test',
      FLOWKIT_DEMO_CI_APPROVED: 'true',
      DATABASE_URL: 'postgresql://flowkit_demo:flowkit_demo@127.0.0.1:5441/flowkit_demo',
    });

    expect(plan.setup.map((step) => step.command.join(' '))).toEqual([
      'docker compose -p flowkit_demo_ci -f docker-compose.yml up -d --wait',
      'bun run db:migrate',
      'bun run db:seed',
    ]);
    expect(plan.children.map((child) => child.name)).toEqual(['api', 'worker', 'notify', 'web']);
    expect(plan.verify.command.join(' ')).toBe('bun run test:browser');
    expect(plan.cleanup.command.join(' ')).toBe('docker compose -p flowkit_demo_ci -f docker-compose.yml down -v');
    expect(plan.environment.FLOWKIT_DEMO_MIGRATION_APPROVED).toBe('true');
    expect(plan.environment.FLOWKIT_DEMO_URL).toBe('http://localhost:5173');
    expect(plan.environment.BETTER_AUTH_URL).toBe('http://localhost:5173');
    expect(plan.environment.NODE_AUTH_TOKEN).toBeUndefined();
  });

  it('defaults NODE_ENV to test for candidate CI callers', () => {
    const plan = createCiStackPlan({ CI: 'true' });
    expect(plan.environment.NODE_ENV).toBe('test');
  });

  it.each([
    [{ CI: 'false', NODE_ENV: 'test', FLOWKIT_DEMO_CI_APPROVED: 'true' }, 'CI=true'],
    [{ CI: 'true', NODE_ENV: 'development', FLOWKIT_DEMO_CI_APPROVED: 'true' }, 'NODE_ENV=test'],
    [{ CI: 'true', NODE_ENV: 'test', FLOWKIT_DEMO_CI_APPROVED: 'true', DATABASE_URL: 'postgresql://x:x@db.example.com/flowkit_demo' }, 'disposable loopback'],
  ] as const)('rejects an unsafe CI invocation', (environment, message) => {
    expect(() => createCiStackPlan(environment)).toThrow(message);
  });
});

describe('bounded CI lifecycle', () => {
  it('aborts a hung readiness fetch at the remaining monotonic deadline', async () => {
    let now = 10;
    let aborted = false;

    await expect(waitForCiReadiness({
      url: 'http://127.0.0.1:3011/health/ready',
      children: [],
      timeoutMs: 25,
      now: () => now,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
      schedule: (callback, milliseconds) => {
        now += milliseconds;
        callback();
        return () => {};
      },
      sleep: async () => {},
    })).rejects.toThrow('did not become ready');

    expect(aborted).toBe(true);
    expect(now).toBe(35);
  });

  it('escalates a hung child and still tears down Compose in order', async () => {
    const events: string[] = [];
    const child = new HungChild(events);

    await cleanupCiStack([child], async () => { events.push('compose-down'); }, {
      graceMs: 20,
      schedule: (callback) => {
        callback();
        return () => {};
      },
    });

    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(events).toEqual(['SIGTERM', 'SIGKILL', 'compose-down']);
  });
});
