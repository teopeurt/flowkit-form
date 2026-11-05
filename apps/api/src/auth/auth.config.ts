import { betterAuth } from 'better-auth';
import { drizzleAdapter, type DB } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/postgres-js';

import {
  betterAuthSchema,
  createDemoDatabaseClient,
} from '@flowkit-demo/database';
import { loadConfig } from '@flowkit-demo/domain';

export function createAuth(overrides: { database?: DB } = {}) {
  const config = loadConfig();
  const database = overrides.database ?? drizzle(
    createDemoDatabaseClient(config.DATABASE_URL),
    { schema: betterAuthSchema },
  );

  return betterAuth({
    appName: 'FlowKit Demo',
    baseURL: config.BETTER_AUTH_URL,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: betterAuthSchema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        schema: {
          member: {
            additionalFields: {
              applicationRole: {
                type: 'string',
                required: true,
                input: false,
                defaultValue: 'employee',
              },
              enabled: {
                type: 'boolean',
                required: true,
                input: false,
                defaultValue: true,
              },
            },
          },
        },
      }),
    ],
    advanced: {
      cookiePrefix: 'flowkit-demo',
      useSecureCookies: config.NODE_ENV === 'production',
    },
  });
}

export const auth = createAuth();
export type DemoAuth = typeof auth;
