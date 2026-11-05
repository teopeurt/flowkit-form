export type ProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export const EXIT_REQUIRED_CHILD = 1;
export const EXIT_DEPENDENCY_TIMEOUT = 70;

export interface ChildProcessSpec {
  name: string;
  command: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  required?: boolean;
}

export interface ChildProcessHandle {
  exited: Promise<number>;
  kill(signal: ProcessSignal): void;
}

export interface DependencySpec {
  name: string;
  check: () => Promise<boolean>;
}

export interface SupervisorOptions {
  children: readonly ChildProcessSpec[];
  dependencies?: readonly DependencySpec[];
  dependencyTimeoutMs?: number;
  pollIntervalMs?: number;
  spawn?: (spec: ChildProcessSpec) => ChildProcessHandle;
  sleep?: (milliseconds: number) => Promise<void>;
  termination?: Promise<'SIGINT' | 'SIGTERM'>;
  log?: (message: string) => void;
  onStarted?: () => void;
  now?: () => number;
}

const SENSITIVE_ENV_KEY = /(TOKEN|SECRET|PASSWORD|COOKIE)/i;

const PACKAGE_CREDENTIAL_KEY = /^(NODE_AUTH_TOKEN|NPM_TOKEN|BUN_AUTH_TOKEN|NPM_CONFIG__AUTH|NPM_CONFIG__AUTHTOKEN)$/i;

export function withoutPackageCredentials(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !PACKAGE_CREDENTIAL_KEY.test(key)));
}

async function pumpRedacted(
  stream: ReadableStream<Uint8Array>,
  environments: readonly (Record<string, string | undefined> | undefined)[],
  write: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        write(redactSensitive(buffered.slice(0, newline + 1), environments));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
      if (done) break;
    }
    if (buffered) write(redactSensitive(buffered, environments));
  } finally {
    reader.releaseLock();
  }
}

export function spawnRedactedChild(
  spec: ChildProcessSpec,
  stdout: (text: string) => void = (text) => process.stdout.write(text),
  stderr: (text: string) => void = (text) => process.stderr.write(text),
): ChildProcessHandle {
  const environment = withoutPackageCredentials({ ...process.env, ...spec.env });
  const child = Bun.spawn([...spec.command], {
    cwd: spec.cwd,
    env: environment,
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = Promise.all([
    pumpRedacted(child.stdout, [environment], stdout),
    pumpRedacted(child.stderr, [environment], stderr),
  ]);
  return {
    exited: Promise.all([child.exited, output]).then(([code]) => code),
    kill: (signal) => child.kill(signal),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactSensitive(value: string, environments: readonly (Record<string, string | undefined> | undefined)[] = []): string {
  let redacted = value.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[REDACTED]@');
  for (const environment of environments) {
    for (const [key, secret] of Object.entries(environment ?? {})) {
      if (SENSITIVE_ENV_KEY.test(key) && secret) redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted;
}

async function dependenciesAreHealthy(options: SupervisorOptions): Promise<boolean> {
  const timeout = options.dependencyTimeoutMs ?? 30_000;
  const interval = Math.max(1, options.pollIntervalMs ?? 250);
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const now = options.now ?? (() => performance.now());
  const deadline = now() + timeout;

  for (const dependency of options.dependencies ?? []) {
    while (true) {
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      const timeoutMarker = Symbol('dependency-timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        dependency.check(),
        new Promise<typeof timeoutMarker>((resolve) => {
          timer = setTimeout(() => resolve(timeoutMarker), remaining);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (result === timeoutMarker) return false;
      if (result) break;
      const afterCheck = deadline - now();
      if (afterCheck <= 0) return false;
      await sleep(Math.min(interval, afterCheck));
    }
  }
  return true;
}

export async function superviseProcesses(options: SupervisorOptions): Promise<number> {
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  const environments = options.children.map((child) => child.env);

  try {
    if (!(await dependenciesAreHealthy(options))) {
      log('A required dependency did not become healthy before the timeout.');
      return EXIT_DEPENDENCY_TIMEOUT;
    }
  } catch (error) {
    log(redactSensitive(`Dependency health check failed: ${errorText(error)}`, environments));
    return EXIT_DEPENDENCY_TIMEOUT;
  }

  const running: Array<{ spec: ChildProcessSpec; handle: ChildProcessHandle }> = [];
  try {
    for (const spec of options.children) running.push({ spec, handle: (options.spawn ?? spawnRedactedChild)(spec) });
  } catch (error) {
    log(redactSensitive(`Unable to start a required process: ${errorText(error)}`, environments));
    for (const child of running) child.handle.kill('SIGTERM');
    await Promise.allSettled(running.map((child) => child.handle.exited));
    return EXIT_REQUIRED_CHILD;
  }

  if (running.length === 0) return 0;
  options.onStarted?.();

  const requiredExit = Promise.race(
    running
      .filter(({ spec }) => spec.required !== false)
      .map(async (child) => ({ child, code: await child.handle.exited })),
  );
  const termination = options.termination?.then((signal) => ({ signal }));
  const outcome = await Promise.race([requiredExit, ...(termination ? [termination] : [])]);

  if ('signal' in outcome) {
    for (const child of running) child.handle.kill(outcome.signal);
    await Promise.allSettled(running.map((child) => child.handle.exited));
    return outcome.signal === 'SIGINT' ? 130 : 143;
  }

  for (const child of running) {
    if (child !== outcome.child) child.handle.kill('SIGTERM');
  }
  await Promise.allSettled(running.map((child) => child.handle.exited));
  return outcome.code === 0 ? EXIT_REQUIRED_CHILD : outcome.code;
}
