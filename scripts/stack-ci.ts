import { resolve } from 'node:path';

import { assertDisposableLocalDatabase } from './lib/local-database-guard';
import {
  spawnRedactedChild,
  type ChildProcessHandle,
  type ChildProcessSpec,
  withoutPackageCredentials,
} from './lib/process-supervisor';

const ROOT = resolve(import.meta.dir, '..');
const CI_DATABASE_URL = 'postgresql://flowkit_demo:flowkit_demo@127.0.0.1:5441/flowkit_demo';

interface CommandStep { command: readonly string[] }
type CancelTimer = () => void;
type Schedule = (callback: () => void, milliseconds: number) => CancelTimer;
export interface CiStackPlan {
  environment: Record<string, string | undefined>;
  setup: readonly CommandStep[];
  children: readonly ChildProcessSpec[];
  verify: CommandStep;
  cleanup: CommandStep;
}

function assertStaticCiTarget(databaseUrl: string): void {
  let target: URL;
  try { target = new URL(databaseUrl); } catch { throw new Error('CI requires a disposable loopback PostgreSQL target.'); }
  const database = decodeURIComponent(target.pathname.slice(1));
  const tls = target.searchParams.get('sslmode');
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.hostname)
    || database !== 'flowkit_demo'
    || (tls !== null && tls !== 'disable')) {
    throw new Error('CI requires a disposable loopback PostgreSQL target.');
  }
}

export function createCiStackPlan(source: Record<string, string | undefined>): CiStackPlan {
  if (source.CI !== 'true') throw new Error('stack:ci requires CI=true.');
  if (source.NODE_ENV !== undefined && source.NODE_ENV !== 'test') throw new Error('stack:ci requires NODE_ENV=test.');
  const databaseUrl = source.DATABASE_URL ?? CI_DATABASE_URL;
  assertStaticCiTarget(databaseUrl);

  const environment = {
    ...withoutPackageCredentials(source),
    CI: 'true',
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    FLOWKIT_DEMO_ALLOW_SEED: 'true',
    FLOWKIT_DEMO_MIGRATION_APPROVED: 'true',
    FLOWKIT_DEMO_PERSISTENCE: 'true',
    FLOWKIT_DEMO_PORT: '3011',
    FLOWKIT_DEMO_URL: 'http://localhost:5173',
    FLOWKIT_DEMO_MAILPIT_URL: 'http://127.0.0.1:8025',
    TEMPORAL_ADDRESS: '127.0.0.1:7233',
    TEMPORAL_NAMESPACE: 'flowkit-demo',
    TEMPORAL_TASK_QUEUE: 'flowkit-demo',
    BETTER_AUTH_SECRET: 'flowkit-demo-ci-secret-change-me-32-characters',
    BETTER_AUTH_URL: 'http://localhost:5173',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    MAILPIT_URL: 'http://127.0.0.1:8025',
  };
  const command = (value: readonly string[]): CommandStep => ({ command: value });
  return {
    environment,
    setup: [
      command(['docker', 'compose', '-p', 'flowkit_demo_ci', '-f', 'docker-compose.yml', 'up', '-d', '--wait']),
      command(['bun', 'run', 'db:migrate']),
      command(['bun', 'run', 'db:seed']),
    ],
    children: [
      { name: 'api', command: ['bun', 'run', 'dev:api'], cwd: ROOT, env: environment },
      { name: 'worker', command: ['bun', 'run', 'dev:worker'], cwd: ROOT, env: environment },
      { name: 'notify', command: ['bun', 'run', 'dev:notify'], cwd: ROOT, env: environment },
      { name: 'web', command: ['bun', 'run', 'dev:web'], cwd: ROOT, env: environment },
    ],
    verify: command(['bun', 'run', 'test:browser']),
    cleanup: command(['docker', 'compose', '-p', 'flowkit_demo_ci', '-f', 'docker-compose.yml', 'down', '-v']),
  };
}

async function run(step: CommandStep, environment: Record<string, string | undefined>): Promise<void> {
  const child = spawnRedactedChild({ name: step.command.join(' '), command: step.command, cwd: ROOT, env: environment });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${step.command[0]} command failed with exit code ${code}.`);
}

interface ReadinessOptions {
  url: string;
  children: readonly ChildProcessHandle[];
  timeoutMs?: number;
  now?: () => number;
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>;
  schedule?: Schedule;
  sleep?: (milliseconds: number) => Promise<void>;
}

const scheduleTimer: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};

export async function waitForCiReadiness(options: ReadinessOptions): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const fetchProbe = options.fetch ?? ((url, init) => fetch(url, init));
  const schedule = options.schedule ?? scheduleTimer;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const deadline = now() + (options.timeoutMs ?? 60_000);

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    let cancelTimer: CancelTimer = () => {};
    const probe = fetchProbe(options.url, { signal: controller.signal }).then(
      (response) => ({ type: 'response' as const, ok: response.ok }),
      () => ({ type: 'retry' as const }),
    );
    const timeout = new Promise<{ type: 'timeout' }>((resolve) => {
      cancelTimer = schedule(() => {
        controller.abort();
        resolve({ type: 'timeout' });
      }, remaining);
    });
    const childExits = options.children.map((child) => child.exited.then(() => ({ type: 'child-exit' as const })));
    const outcome = await Promise.race([probe, timeout, ...childExits]);
    cancelTimer();

    if (outcome.type === 'response' && outcome.ok) return;
    if (outcome.type === 'child-exit') throw new Error('A required CI application exited before readiness.');
    if (outcome.type === 'timeout') break;
    await sleep(Math.min(250, Math.max(0, deadline - now())));
  }
  throw new Error(`CI application did not become ready: ${options.url}`);
}

interface CleanupOptions {
  graceMs?: number;
  schedule?: Schedule;
}

async function stopCiChildren(children: readonly ChildProcessHandle[], options: CleanupOptions): Promise<void> {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* an already-exited child needs no signal */ }
  }
  if (children.length === 0) return;

  const schedule = options.schedule ?? scheduleTimer;
  let cancelTimer: CancelTimer = () => {};
  const timeout = new Promise<'timeout'>((resolve) => {
    cancelTimer = schedule(() => resolve('timeout'), options.graceMs ?? 5_000);
  });
  const outcome = await Promise.race([
    Promise.allSettled(children.map((child) => child.exited)).then(() => 'exited' as const),
    timeout,
  ]);
  cancelTimer();
  if (outcome === 'timeout') {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* teardown must continue regardless */ }
    }
  }
}

export async function cleanupCiStack(
  children: readonly ChildProcessHandle[],
  teardown: () => Promise<void>,
  options: CleanupOptions = {},
): Promise<void> {
  try {
    await stopCiChildren(children, options);
  } finally {
    await teardown();
  }
}

async function main(): Promise<void> {
  const plan = createCiStackPlan(process.env);
  if (!Bun.which('docker')) throw new Error('Docker is required for stack:ci.');
  const children: ChildProcessHandle[] = [];
  try {
    await run(plan.setup[0]!, plan.environment);
    await assertDisposableLocalDatabase({ databaseUrl: plan.environment.DATABASE_URL! });
    await run(plan.setup[1]!, plan.environment);
    await run(plan.setup[2]!, plan.environment);
    for (const spec of plan.children) children.push(spawnRedactedChild(spec));
    await Promise.all([
      waitForCiReadiness({ url: 'http://127.0.0.1:3011/health/ready', children }),
      waitForCiReadiness({ url: 'http://localhost:5173/', children }),
    ]);
    await run(plan.verify, plan.environment);
  } finally {
    await cleanupCiStack(children, () => run(plan.cleanup, plan.environment));
  }
}

if (import.meta.main) {
  try { await main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
