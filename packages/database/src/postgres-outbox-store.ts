import { randomUUID } from 'node:crypto';

import type { ClaimedDelivery, JsonValue, NotificationDeliveryEnvelope, NotificationOutboxStore } from '@naakwu/flowkit-notify';
import type { Sql, TransactionSql } from 'postgres';

import { createDemoDatabaseClient } from './client';
import { jsonb } from './jsonb';
import { requireTenantScope, type TenantScope } from './tenant-scope';

type Executor = Sql | TransactionSql;
type OutboxRow = {
  id: string;
  status: ClaimedDelivery['status'] | 'pending' | 'delivered' | 'failed' | 'skipped' | 'reconciliation_required';
  attempt_count: number;
  available_at: Date | string;
  payload: NotificationDeliveryEnvelope | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  provider_message_id: string | null;
  delivered_at: Date | string | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

const asDate = (value: Date | string) => value instanceof Date ? value : new Date(value);
const envelopeOf = (payload: OutboxRow['payload']): NotificationDeliveryEnvelope => typeof payload === 'string' ? JSON.parse(payload) : payload;

/** PostgreSQL adapter for NotificationOutboxStore, including lease ownership. */
export class PostgresOutboxStore {
  readonly sql: Sql;
  private readonly ownsClient: boolean;

  constructor(sql?: Sql) {
    this.ownsClient = !sql;
    this.sql = sql ?? createDemoDatabaseClient();
  }

  forOrganization(scope: TenantScope): NotificationOutboxStore {
    requireTenantScope(scope);
    return {
      insert: (envelopes) => this.insert(scope, envelopes),
      claimDue: (owner, now, leaseMs, limit) => this.claimDue(scope, owner, now, leaseMs, limit),
      recordDelivered: (input) => this.recordDelivered(scope, input),
      recordRetry: (input) => this.recordRetry(scope, input),
      recordFailed: (input) => this.recordFailed(scope, input),
      recordSkipped: (input) => this.recordSkipped(scope, input),
      recordReconciliation: (input) => this.recordReconciliation(scope, input),
      recoverExpired: (now) => this.recoverExpired(scope, now),
    };
  }

  async insert(scope: TenantScope, envelopes: NotificationDeliveryEnvelope[]) {
    requireTenantScope(scope);
    return this.insertInTransaction(scope, envelopes, this.sql);
  }

  async insertInTransaction(scope: TenantScope, envelopes: NotificationDeliveryEnvelope[], executor: Executor) {
    requireTenantScope(scope);
    const inserted: NotificationDeliveryEnvelope[] = [];
    const existing: NotificationDeliveryEnvelope[] = [];
    for (const envelope of envelopes) {
      const [row] = await executor<{ id: string }[]>`
        INSERT INTO notification_outbox (organization_id, id, dedupe_key, channel, status, attempt_count, available_at, payload)
        VALUES (${scope.organizationId}, ${`delivery-${randomUUID()}`}, ${envelope.dedupeKey}, ${envelope.channel}, 'pending', 0, now(), ${jsonb(this.sql, envelope)})
        ON CONFLICT (organization_id, dedupe_key) DO NOTHING
        RETURNING id
      `;
      (row ? inserted : existing).push(envelope);
    }
    return { inserted, existing };
  }

  async claimDue(scope: TenantScope, owner: string, now: Date, leaseMs: number, limit: number): Promise<ClaimedDelivery[]> {
    requireTenantScope(scope);
    return this.sql.begin(async (tx) => {
      const rows = await tx<OutboxRow[]>`
        SELECT * FROM notification_outbox
        WHERE organization_id = ${scope.organizationId} AND status = 'pending' AND available_at <= ${now.toISOString()}
        ORDER BY available_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const claimed: ClaimedDelivery[] = [];
      for (const row of rows) {
        const [updated] = await tx<OutboxRow[]>`
          UPDATE notification_outbox
          SET status = 'leased', lease_owner = ${owner}, lease_expires_at = ${leaseExpiresAt.toISOString()},
              attempt_count = attempt_count + 1
          WHERE organization_id = ${scope.organizationId} AND id = ${row.id} AND status = 'pending'
          RETURNING *
        `;
        if (updated) claimed.push({
          id: updated.id, envelope: envelopeOf(updated.payload), status: 'leased',
          attemptCount: updated.attempt_count, leaseOwner: owner, leaseExpiresAt,
        });
      }
      return claimed;
    });
  }

  async recordDelivered(scope: TenantScope, input: { id: string; owner: string; providerMessageId?: string; receipt?: JsonValue }): Promise<void> {
    await this.updateOwned(scope, input.id, input.owner, {
      status: 'delivered', providerMessageId: input.providerMessageId ?? null,
      deliveredAt: new Date().toISOString(), leaseOwner: null, leaseExpiresAt: null,
    });
  }

  async recordRetry(scope: TenantScope, input: { id: string; owner: string; availableAt: Date; errorCode: string; message: string }): Promise<void> {
    await this.updateOwned(scope, input.id, input.owner, {
      status: 'pending', availableAt: input.availableAt.toISOString(), errorCode: input.errorCode,
      errorMessage: input.message, leaseOwner: null, leaseExpiresAt: null,
    });
  }

  async recordFailed(scope: TenantScope, input: { id: string; owner: string; errorCode: string; message: string }): Promise<void> {
    await this.updateOwned(scope, input.id, input.owner, {
      status: 'failed', errorCode: input.errorCode, errorMessage: input.message, leaseOwner: null, leaseExpiresAt: null,
    });
  }

  async recordSkipped(scope: TenantScope, input: { id: string; owner: string; reason: string }): Promise<void> {
    await this.updateOwned(scope, input.id, input.owner, {
      status: 'skipped', errorCode: 'SKIPPED', errorMessage: input.reason, leaseOwner: null, leaseExpiresAt: null,
    });
  }

  async recordReconciliation(scope: TenantScope, input: { id: string; owner: string; reason: string }): Promise<void> {
    await this.updateOwned(scope, input.id, input.owner, {
      status: 'reconciliation_required', errorCode: 'AMBIGUOUS', errorMessage: input.reason, leaseOwner: null, leaseExpiresAt: null,
    });
  }

  async recoverExpired(scope: TenantScope, now: Date): Promise<number> {
    requireTenantScope(scope);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE notification_outbox
      SET status = CASE WHEN channel = 'email' THEN 'reconciliation_required' ELSE 'pending' END,
          last_error_code = CASE WHEN channel = 'email' THEN 'LEASE_EXPIRED' ELSE last_error_code END,
          last_error_message = CASE
            WHEN channel = 'email' THEN 'SMTP lease expired; delivery may have succeeded and requires reconciliation.'
            ELSE last_error_message
          END,
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE organization_id = ${scope.organizationId} AND status = 'leased' AND lease_expires_at <= ${now.toISOString()}
      RETURNING id
    `;
    return rows.length;
  }

  async listForRecipient(scope: TenantScope, recipientId: string): Promise<Array<{ id: string; status: OutboxRow['status']; subject: string }>> {
    requireTenantScope(scope);
    const rows = await this.sql<OutboxRow[]>`
      SELECT * FROM notification_outbox
      WHERE organization_id = ${scope.organizationId}
        AND payload->'recipient'->>'canonicalKey' = ${recipientId}
      ORDER BY available_at ASC
    `;
    return rows.map((row) => ({ id: row.id, status: row.status, subject: envelopeOf(row.payload).rendered.subject }));
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.sql.end({ timeout: 5 });
  }

  private async updateOwned(scope: TenantScope, id: string, owner: string, values: {
    status: OutboxRow['status']; availableAt?: string; providerMessageId?: string | null; deliveredAt?: string;
    errorCode?: string; errorMessage?: string; leaseOwner: string | null; leaseExpiresAt: string | null;
  }): Promise<void> {
    requireTenantScope(scope);
    const rows = await this.sql<{ id: string }[]>`
      UPDATE notification_outbox
      SET status = ${values.status},
          available_at = COALESCE(${values.availableAt ?? null}::timestamptz, available_at),
          provider_message_id = COALESCE(${values.providerMessageId ?? null}, provider_message_id),
          delivered_at = COALESCE(${values.deliveredAt ?? null}::timestamptz, delivered_at),
          last_error_code = ${values.errorCode ?? null},
          last_error_message = ${values.errorMessage ?? null},
          lease_owner = ${values.leaseOwner},
          lease_expires_at = ${values.leaseExpiresAt}::timestamptz
      WHERE organization_id = ${scope.organizationId} AND id = ${id} AND status = 'leased' AND lease_owner = ${owner}
      RETURNING id
    `;
    if (rows.length !== 1) throw new Error('notification delivery lease is no longer valid');
  }
}

export type DurableDelivery = {
  id: string;
  status: OutboxRow['status'];
  attemptCount: number;
  providerMessageId: string | null;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

/** Test/read-model helper; delivery remains owned by the outbox adapter. */
export async function readDelivery(scope: TenantScope, sql: Sql, id: string): Promise<DurableDelivery | null> {
  requireTenantScope(scope);
  const [row] = await sql<OutboxRow[]>`SELECT * FROM notification_outbox WHERE organization_id = ${scope.organizationId} AND id = ${id} LIMIT 1`;
  return row ? {
    id: row.id, status: row.status, attemptCount: row.attempt_count, providerMessageId: row.provider_message_id,
    deliveredAt: row.delivered_at ? asDate(row.delivered_at) : null,
    lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message,
  } : null;
}
