import { describe, expect, it } from 'bun:test';

import {
  EXIT_DEPENDENCY_TIMEOUT,
  EXIT_REQUIRED_CHILD,
  type ChildProcessHandle,
  type ProcessSignal,
  superviseProcesses,
  spawnRedactedChild,
} from './process-supervisor';

class ControlledChild implements ChildProcessHandle {
  readonly exited: Promise<number>;
  readonly signals: ProcessSignal[] = [];
  private finish!: (code: number) => void;

  constructor(readonly name: string) {
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  exit(code: number) {
    this.finish(code);
  }

  kill(signal: ProcessSignal) {
    this.signals.push(signal);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('superviseProcesses', () => {
  it('times out an unhealthy dependency before starting children', async () => {
    const starts: string[] = [];
    let now = 0;

    const code = await superviseProcesses({
      dependencies: [{ name: 'postgres', check: async () => false }],
      children: [{ name: 'api', command: ['bun', 'api.ts'] }],
      dependencyTimeoutMs: 2,
      pollIntervalMs: 1,
      spawn: (spec) => {
        starts.push(spec.name);
        return new ControlledChild(spec.name);
      },
      sleep: async () => {},
      now: () => ++now,
    });

    expect(code).toBe(EXIT_DEPENDENCY_TIMEOUT);
    expect(starts).toEqual([]);
  });

  it('starts required children in declaration order', async () => {
    const starts: string[] = [];
    const lifecycle: string[] = [];
    const children = new Map<string, ControlledChild>();
    const stopping = deferred<'SIGINT' | 'SIGTERM'>();

    const running = superviseProcesses({
      children: ['api', 'worker', 'notify', 'web'].map((name) => ({ name, command: ['bun', `${name}.ts`] })),
      spawn: (spec) => {
        starts.push(spec.name);
        const child = new ControlledChild(spec.name);
        children.set(spec.name, child);
        if (spec.name === 'web') stopping.resolve('SIGTERM');
        return child;
      },
      onStarted: () => lifecycle.push('ready'),
      termination: stopping.promise,
    });

    await Promise.resolve();
    for (const child of children.values()) child.exit(0);

    expect(await running).toBe(143);
    expect(starts).toEqual(['api', 'worker', 'notify', 'web']);
    expect(lifecycle).toEqual(['ready']);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('forwards %s to every child and returns %i', async (signal, expectedCode) => {
    const children: ControlledChild[] = [];
    const running = superviseProcesses({
      children: [{ name: 'api', command: ['bun', 'api.ts'] }, { name: 'web', command: ['bun', 'web.ts'] }],
      spawn: (spec) => {
        const child = new ControlledChild(spec.name);
        children.push(child);
        return child;
      },
      termination: Promise.resolve(signal),
    });

    await Promise.resolve();
    for (const child of children) child.exit(0);

    expect(await running).toBe(expectedCode);
    expect(children.map((child) => child.signals)).toEqual([[signal], [signal]]);
  });

  it('stops siblings when any required child exits and preserves its failure code', async () => {
    const children = new Map<string, ControlledChild>();
    const running = superviseProcesses({
      children: [{ name: 'api', command: ['bun', 'api.ts'] }, { name: 'web', command: ['bun', 'web.ts'] }],
      spawn: (spec) => {
        const child = new ControlledChild(spec.name);
        children.set(spec.name, child);
        return child;
      },
    });

    await Promise.resolve();
    children.get('api')!.exit(23);
    await Promise.resolve();
    children.get('web')!.exit(0);

    expect(await running).toBe(23);
    expect(children.get('web')!.signals).toEqual(['SIGTERM']);
  });

  it('uses a deterministic failure code when a required child exits successfully', async () => {
    const child = new ControlledChild('api');
    const running = superviseProcesses({
      children: [{ name: 'api', command: ['bun', 'api.ts'] }],
      spawn: () => child,
    });

    child.exit(0);

    expect(await running).toBe(EXIT_REQUIRED_CHILD);
  });

  it('redacts URL passwords and sensitive environment values from errors', async () => {
    const messages: string[] = [];
    const code = await superviseProcesses({
      children: [{
        name: 'api',
        command: ['bun', 'api.ts'],
        env: {
          DATABASE_URL: 'postgresql://flowkit:db-password@localhost:5441/flowkit_demo',
          NODE_AUTH_TOKEN: 'registry-token',
          SESSION_COOKIE: 'cookie-value',
          PUBLIC_SETTING: 'visible-value',
        },
      }],
      spawn: () => {
        throw new Error('failed postgresql://flowkit:db-password@localhost:5441/flowkit_demo registry-token cookie-value');
      },
      log: (message) => messages.push(message),
    });

    expect(code).toBe(EXIT_REQUIRED_CHILD);
    expect(messages.join('\n')).not.toContain('db-password');
    expect(messages.join('\n')).not.toContain('registry-token');
    expect(messages.join('\n')).not.toContain('cookie-value');
    expect(messages.join('\n')).toContain('[REDACTED]');
  });

  it('redacts secret values emitted by a real spawned process', async () => {
    const output: string[] = [];
    const secret = 'spawned-process-secret';
    const child = spawnRedactedChild({
      name: 'leaky',
      command: ['bun', '-e', `console.log('${secret}'); console.error('postgresql://u:${secret}@localhost/db')`],
      env: { API_TOKEN: secret },
    }, (text) => output.push(text), (text) => output.push(text));

    expect(await child.exited).toBe(0);
    expect(output.join('')).not.toContain(secret);
    expect(output.join('')).toContain('[REDACTED]');
  });

  it('does not propagate package credentials to a real spawned process', async () => {
    const output: string[] = [];
    const secret = 'registry-credential';
    const child = spawnRedactedChild({
      name: 'environment-probe',
      command: ['bun', '-e', 'console.log(process.env.NODE_AUTH_TOKEN ?? "credential-absent")'],
      env: { NODE_AUTH_TOKEN: secret },
    }, (text) => output.push(text), (text) => output.push(text));

    expect(await child.exited).toBe(0);
    expect(output.join('')).toContain('credential-absent');
    expect(output.join('')).not.toContain(secret);
  });

  it('bounds a hung dependency check by the declared monotonic deadline', async () => {
    const started = performance.now();
    const code = await superviseProcesses({
      dependencies: [{ name: 'hung', check: () => new Promise(() => {}) }],
      children: [],
      dependencyTimeoutMs: 10,
    });

    expect(code).toBe(EXIT_DEPENDENCY_TIMEOUT);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
