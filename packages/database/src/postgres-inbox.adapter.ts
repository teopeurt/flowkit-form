import type { NotificationChannelAdapter, NotificationDeliveryEnvelope } from '@naakwu/flowkit-notify';
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';

import { createDemoDatabaseClient } from './client';
import { requireTenantScope, type TenantScope } from './tenant-scope';

type InboxRow = {
  id: string;
  user_id: string;
  dedupe_key: string;
  subject: string;
  body: string;
  read_at: Date | string | null;
  delivered_at: Date | string;
};

/** Durable in-app notification delivery keyed by the Flowkit envelope dedupe key. */
export class PostgresInboxAdapter {
  readonly channel = 'inbox';
  readonly idempotent = true;
  private readonly ownsClient: boolean;
  readonly sql: Sql;

  constructor(sql?: Sql) {
    this.ownsClient = !sql;
    this.sql = sql ?? createDemoDatabaseClient();
  }

  forOrganization(scope: TenantScope): NotificationChannelAdapter {
    requireTenantScope(scope);
    return {
      channel: this.channel,
      idempotent: this.idempotent,
      send: (input) => this.send(scope, input),
    };
  }

  async send(scope: TenantScope, input: { envelope: NotificationDeliveryEnvelope; attemptId: string }) {
    requireTenantScope(scope);
    const { envelope } = input;
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO notification_inbox (organization_id, id, user_id, dedupe_key, subject, body)
      VALUES (
        ${scope.organizationId}, ${`inbox-${randomUUID()}`}, ${envelope.recipient.canonicalKey}, ${envelope.dedupeKey},
        ${envelope.rendered.subject}, ${envelope.rendered.body}
      )
      ON CONFLICT (organization_id, dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
      RETURNING id
    `;
    if (!row) throw new Error('notification inbox delivery did not return a row');
    return { providerMessageId: row.id };
  }

  async forUser(scope: TenantScope, userId: string): Promise<Array<{ id: string; dedupeKey: string; subject: string; body: string; readAt: Date | null; deliveredAt: Date }>> {
    requireTenantScope(scope);
    const rows = await this.sql<InboxRow[]>`
      SELECT id, user_id, dedupe_key, subject, body, read_at, delivered_at
      FROM notification_inbox
      WHERE organization_id = ${scope.organizationId} AND user_id = ${userId}
      ORDER BY delivered_at DESC, id DESC
    `;
    return rows.map((row) => ({
      id: row.id,
      dedupeKey: row.dedupe_key,
      subject: row.subject,
      body: row.body,
      readAt: row.read_at ? new Date(row.read_at) : null,
      deliveredAt: new Date(row.delivered_at),
    }));
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.sql.end({ timeout: 5 });
  }
}
