import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import type { NotificationDeliveryEnvelope } from '@naakwu/flowkit-notify';

import { PostgresOutboxStore, readDelivery } from '@flowkit-demo/database';
import { durableTestDatabase } from './durable-test-database';

const envelope: NotificationDeliveryEnvelope = {
  namespace: 'flowkit-demo', sourceKey: 'leave-1:approved', aggregate: { type: 'leave', id: 'leave-1' },
  templateKey: 'leave.accepted', channel: 'email', recipient: { channel: 'email', canonicalKey: 'employee-1', address: 'employee-1@example.test' },
  rendered: { subject: 'Leave approved', body: 'Approved', severity: 'success' }, dedupeKey: 'delivery-1',
  payloadFingerprint: 'payload-1', requestFingerprint: 'request-1',
  retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 10_000 }, metadata: {},
};

const sql = await durableTestDatabase('PostgresOutboxStore', ['notification_outbox']);
const durableTests = sql ? describe : describe.skip;
const scope = { organizationId: 'acme-demo' };
afterEach(async () => { if (sql) await sql`DELETE FROM notification_outbox`; });
afterAll(async () => { if (sql) await sql.end({ timeout: 5 }); });

durableTests('PostgresOutboxStore', () => {
  it('leases and completes an outbox envelope exactly once', async () => {
    const client = sql!;
    const outbox = new PostgresOutboxStore(client);
    await outbox.insert(scope, [envelope]);
    const [claimed] = await outbox.claimDue(scope, 'notify-1', new Date(), 60_000, 10);
    expect(claimed).toBeDefined();
    await outbox.recordDelivered(scope, { id: claimed!.id, owner: 'notify-1', providerMessageId: 'mail-1' });
    expect(await readDelivery(scope, client, claimed!.id)).toMatchObject({ status: 'delivered', providerMessageId: 'mail-1' });
  });
});
