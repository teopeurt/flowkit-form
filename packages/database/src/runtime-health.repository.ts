import type { Sql } from 'postgres';

import { createDemoDatabaseClient } from './client';
import { jsonb } from './jsonb';

export type RuntimeHealth = {
  name: string;
  ready: boolean;
  checkedAt: string;
  heartbeatAt: string | null;
};

type HeartbeatRow = { state_value: { heartbeatAt?: string } | string; updated_at: Date | string };

const asIso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** PostgreSQL-backed worker/API heartbeat with a deliberately short readiness window. */
export class RuntimeHealthRepository {
  readonly sql: Sql;
  private readonly ownsClient: boolean;

  constructor(sql?: Sql) {
    this.ownsClient = !sql;
    this.sql = sql ?? createDemoDatabaseClient();
  }

  async heartbeat(name: string, now = new Date()): Promise<void> {
    const heartbeatAt = now.toISOString();
    await this.sql`
      INSERT INTO demo_runtime_state (state_key, state_value, updated_at)
      VALUES (${`health:${name}`}, ${jsonb(this.sql, { heartbeatAt })}, ${heartbeatAt})
      ON CONFLICT (state_key) DO UPDATE
      SET state_value = EXCLUDED.state_value, updated_at = EXCLUDED.updated_at
    `;
  }

  async health(name: string, now = new Date()): Promise<RuntimeHealth> {
    const [row] = await this.sql<HeartbeatRow[]>`
      SELECT state_value, updated_at
      FROM demo_runtime_state
      WHERE state_key = ${`health:${name}`}
      LIMIT 1
    `;
    const value = typeof row?.state_value === 'string' ? JSON.parse(row.state_value) : row?.state_value;
    const heartbeatAt = value?.heartbeatAt ?? (row ? asIso(row.updated_at) : null);
    const ready = heartbeatAt !== null && now.getTime() - new Date(heartbeatAt).getTime() <= 30_000;
    return { name, ready, checkedAt: now.toISOString(), heartbeatAt };
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.sql.end({ timeout: 5 });
  }
}
