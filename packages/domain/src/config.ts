import { z } from 'zod';

const durableTestsFlag = z.enum(['true', 'false']).optional().transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  FLOWKITFORM_PORT: z.coerce.number().int().positive().default(3011),
  FLOWKITFORM_ALLOW_SEED: z.coerce.boolean().default(false),
  FLOWKITFORM_PERSISTENCE: z.coerce.boolean().default(false),
  FLOWKITFORM_DURABLE_TESTS: durableTestsFlag,
  FLOWKITFORM_DURABLE_TEST_DATABASE: z.string().regex(/^flowkitform_test(?:_[a-z0-9_]+)?$/).default('flowkitform_test'),
  DATABASE_URL: z.string().default('postgresql://flowkitform:flowkitform@localhost:5441/flowkitform'),
  TEMPORAL_ADDRESS: z.string().default('localhost:7233'), TEMPORAL_NAMESPACE: z.string().default('flowkit-demo'), TEMPORAL_TASK_QUEUE: z.string().default('flowkit-demo'),
  BETTER_AUTH_SECRET: z.string().min(32).default('flowkit-demo-local-secret-change-me-32-characters'), BETTER_AUTH_URL: z.string().url().default('http://localhost:3011'),
  SMTP_HOST: z.string().default('localhost'), SMTP_PORT: z.coerce.number().int().positive().default(1025), SMTP_FROM: z.string().email().default('notifications@flowkit-demo.test'), MAILPIT_URL: z.string().url().default('http://localhost:8025'),
  FLOWKITFORM_NOTIFY_ACTIVE_POLL_MS: z.coerce.number().int().positive().default(100),
  FLOWKITFORM_NOTIFY_IDLE_POLL_MS: z.coerce.number().int().positive().default(1_000),
}).strict();
export type DemoConfig = z.infer<typeof schema>;

/** Parses the opt-in independently so disabled integration tests never open a database client. */
export function durableTestsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return durableTestsFlag.parse(env.FLOWKITFORM_DURABLE_TESTS);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const config = schema.parse(Object.fromEntries(Object.keys(schema.shape).map(key => [key, env[key]])));
  if (config.NODE_ENV === 'production' && config.FLOWKITFORM_ALLOW_SEED) throw new Error('Demo seed mode is disabled in production');
  if (!/^flowkitform(?:_test_)?/.test(new URL(config.DATABASE_URL).pathname.slice(1))) throw new Error('DATABASE_URL must target a flowkitform database');
  return config;
}
