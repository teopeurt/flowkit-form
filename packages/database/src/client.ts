import postgres, { type Sql } from 'postgres';

import { loadConfig } from '@flowkit-demo/domain';

export function databaseTarget() { const config = loadConfig(); return new URL(config.DATABASE_URL).pathname.slice(1); }

/** Creates a database client for a durable demo adapter. */
export function createDemoDatabaseClient(databaseUrl = loadConfig().DATABASE_URL): Sql {
  return postgres(databaseUrl, { max: 5, idle_timeout: 20 });
}

export async function withMigrationClient<T>(callback: (client: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const client = postgres(config.DATABASE_URL, { max: 1 });
  try {
    return await callback(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}
