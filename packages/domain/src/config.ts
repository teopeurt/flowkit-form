import { z } from 'zod';

const durableTestsFlag = z.enum(['true', 'false']).optional().transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FLOWKIT_DEMO_PORT: z.coerce.number().int().positive().default(3011),
  FLOWKIT_DEMO_ALLOW_SEED: z.coerce.boolean().default(false),
  FLOWKIT_DEMO_PERSISTENCE: z.coerce.boolean().default(false),
  FLOWKIT_DEMO_DURABLE_TESTS: durableTestsFlag,
  FLOWKIT_DEMO_DURABLE_TEST_DATABASE: z.string().regex(/^flowkit_demo_test(?:_[a-z0-9_]+)?$/).default('flowkit_demo_test'),
  DATABASE_URL: z.string().default('postgresql://flowkit_demo:flowkit_demo@localhost:5441/flowkit_demo'),
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'), TEMPORAL_NAMESPACE: z.string().default('flowkit-demo'), TEMPORAL_TASK_QUEUE: z.string().default('flowkit-demo'),
  BETTER_AUTH_SECRET: z.string().min(32).default('flowkit-demo-local-secret-change-me-32-characters'), BETTER_AUTH_URL: z.string().url().default('http://localhost:3011'),
  SMTP_HOST: z.string().default('localhost'), SMTP_PORT: z.coerce.number().int().positive().default(1025), SMTP_FROM: z.string().email().default('notifications@flowkit-demo.test'), MAILPIT_URL: z.string().url().default('http://localhost:8025'),
  FLOWKIT_DEMO_NOTIFY_ACTIVE_POLL_MS: z.coerce.number().int().positive().default(100),
  FLOWKIT_DEMO_NOTIFY_IDLE_POLL_MS: z.coerce.number().int().positive().default(1_000),
}).strict();
export type DemoConfig = z.infer<typeof schema>;

/** Parses the opt-in independently so disabled integration tests never open a database client. */
export function durableTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return durableTestsFlag.parse(env.FLOWKIT_DEMO_DURABLE_TESTS);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const config = schema.parse(Object.fromEntries(Object.keys(schema.shape).map(key => [key, env[key]])));
  if (config.NODE_ENV === 'production' && config.FLOWKIT_DEMO_ALLOW_SEED) throw new Error('Demo seed mode is disabled in production');
  if (!/^flowkit_demo(?:_test_)?/.test(new URL(config.DATABASE_URL).pathname.slice(1))) throw new Error('DATABASE_URL must target a flowkit_demo database');
  return config;
}
