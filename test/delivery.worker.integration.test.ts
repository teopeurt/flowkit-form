import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import type { NotificationDeliveryEnvelope } from '@naakwu/flowkit-notify';

import { RuntimeHealthRepository } from '@flowkit-demo/database';
import { PostgresOutboxStore, readDelivery } from '@flowkit-demo/database';
import { MailpitSmtpAdapter, type SmtpMail, type SmtpTransport } from '../apps/notify-worker/src/mailpit-smtp.adapter';
import { createDeliveryAdapters, runDeliveryCycle } from '../apps/notify-worker/src/delivery.worker';
import { PostgresInboxAdapter } from '@flowkit-demo/database';
import { durableTestDatabase } from './durable-test-database';

const approvedLeaveEnvelopes: NotificationDeliveryEnvelope[] = [
  {
    namespace: 'flowkit-demo', sourceKey: 'leave-1:approved', aggregate: { type: 'leave', id: 'leave-1' },
    templateKey: 'leave.accepted', channel: 'inbox', recipient: { channel: 'inbox', canonicalKey: 'employee-1', address: 'employee-1' },
    rendered: { subject: 'Leave approved', body: 'Approved', severity: 'success' }, dedupeKey: 'leave-1:approved:inbox',
    payloadFingerprint: 'payload-inbox', requestFingerprint: 'request-approved',
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 10_000 }, metadata: {},
  },
  {
    namespace: 'flowkit-demo', sourceKey: 'leave-1:approved', aggregate: { type: 'leave', id: 'leave-1' },
    templateKey: 'leave.accepted', channel: 'email', recipient: { channel: 'email', canonicalKey: 'employee-1', address: 'employee-1@example.test' },
    rendered: { subject: 'Leave approved', body: 'Approved', severity: 'success' }, dedupeKey: 'leave-1:approved:email',
    payloadFingerprint: 'payload-email', requestFingerprint: 'request-approved',
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 10_000 }, metadata: {},
  },
];

class RecordingSmtpTransport implements SmtpTransport {
  readonly sent: SmtpMail[] = [];

  async sendMail(message: SmtpMail) {
    this.sent.push(message);
    return { messageId: `mailpit-${this.sent.length}` };
  }
}

describe('Mailpit SMTP adapter', () => {
  it('uses the envelope dedupe key to avoid sending duplicate SMTP messages in one worker lifetime', async () => {
    const transport = new RecordingSmtpTransport();
    const adapter = new MailpitSmtpAdapter({ transport });
    const input = { envelope: approvedLeaveEnvelopes[1]!, attemptId: 'attempt-1' };

    const scope = { organizationId: 'acme-demo' };
    const first = await adapter.send(scope, input);
    const second = await adapter.send(scope, { ...input, attemptId: 'attempt-2' });

    expect(adapter.idempotent).toBe(false);
    expect(transport.sent).toHaveLength(1);
    expect(first.providerMessageId).toBe(second.providerMessageId);
    expect(transport.sent[0]?.headers['X-Flowkit-Dedupe-Key']).toBe(approvedLeaveEnvelopes[1]?.dedupeKey);
  });

  it('delivers the same tenant-local dedupe key once for each organization', async () => {
    const transport = new RecordingSmtpTransport();
    const adapter = new MailpitSmtpAdapter({ transport });
    const envelope = approvedLeaveEnvelopes[1]!;

    await adapter.send({ organizationId: 'acme-demo' }, { envelope, attemptId: 'acme-attempt' });
    await adapter.send({ organizationId: 'globex-demo' }, {
      envelope: { ...envelope, recipient: { ...envelope.recipient, address: 'employee@globex.example.test' } },
      attemptId: 'globex-attempt',
    });

    expect(transport.sent).toHaveLength(2);
    expect(new Set(transport.sent.map((message) => message.messageId)).size).toBe(2);
  });

  it('does not collide when organization and dedupe keys contain the separator', async () => {
    const transport = new RecordingSmtpTransport();
    const adapter = new MailpitSmtpAdapter({ transport });
    const envelope = approvedLeaveEnvelopes[1]!;

    await adapter.send({ organizationId: 'a' }, {
      envelope: { ...envelope, dedupeKey: 'b:c' },
      attemptId: 'first-attempt',
    });
    await adapter.send({ organizationId: 'a:b' }, {
      envelope: { ...envelope, dedupeKey: 'c' },
      attemptId: 'second-attempt',
    });

    expect(transport.sent).toHaveLength(2);
    expect(new Set(transport.sent.map((message) => message.messageId)).size).toBe(2);
  });
});

const sql = await durableTestDatabase('delivery worker', ['notification_outbox', 'notification_inbox', 'demo_runtime_state']);
const durableTests = sql ? describe : describe.skip;
const scope = { organizationId: 'acme-demo' };

afterEach(async () => {
  if (!sql) return;
  await sql`DELETE FROM notification_outbox`;
  await sql`DELETE FROM notification_inbox`;
  await sql`DELETE FROM demo_runtime_state`;
});
afterAll(async () => { if (sql) await sql.end({ timeout: 5 }); });

durableTests('delivery worker', () => {
  it('writes inbox delivery and sends one SMTP envelope for an approved leave', async () => {
    const outbox = new PostgresOutboxStore(sql!);
    const inbox = new PostgresInboxAdapter(sql!);
    const smtp = new RecordingSmtpTransport();
    const adapters = createDeliveryAdapters({ inbox: inbox.forOrganization(scope), smtp: new MailpitSmtpAdapter({ transport: smtp }).forOrganization(scope) });
    const health = new RuntimeHealthRepository(sql!);

    await outbox.insert(scope, approvedLeaveEnvelopes);
    const result = await runDeliveryCycle({ scope, owner: 'notify-test', outbox, adapters, health });

    expect(result.claimed).toBe(2);
    expect(await inbox.forUser(scope, 'employee-1')).toHaveLength(1);
    expect(smtp.sent).toHaveLength(1);
    expect((await health.health('delivery-worker')).ready).toBe(true);
  });

  it('does not resend email after a worker lease expires before its receipt is recorded', async () => {
    const outbox = new PostgresOutboxStore(sql!);
    await outbox.insert(scope, [approvedLeaveEnvelopes[1]!]);
    const [claimed] = await outbox.claimDue(scope, 'crashed-worker', new Date(), 1, 1);
    expect(claimed).toBeDefined();

    await outbox.recoverExpired(scope, new Date(claimed!.leaseExpiresAt.getTime() + 1));
    expect(await readDelivery(scope, sql!, claimed!.id)).toMatchObject({
      status: 'reconciliation_required',
      lastErrorCode: 'LEASE_EXPIRED',
    });

    const smtp = new RecordingSmtpTransport();
    const adapters = createDeliveryAdapters({
      inbox: new PostgresInboxAdapter(sql!).forOrganization(scope),
      smtp: new MailpitSmtpAdapter({ transport: smtp }).forOrganization(scope),
    });
    const result = await runDeliveryCycle({
      scope, owner: 'replacement-worker', outbox, adapters, health: new RuntimeHealthRepository(sql!),
    });
    expect(result.claimed).toBe(0);
    expect(smtp.sent).toHaveLength(0);
  });

  it('lists the newest durable inbox notification first', async () => {
    await sql!`
      INSERT INTO notification_inbox (organization_id, id, user_id, dedupe_key, subject, body, delivered_at)
      VALUES
        (${scope.organizationId}, 'inbox-old', 'employee-1', 'inbox-order-old', 'Older', 'Older notification', '2026-07-29T10:00:00.000Z'),
        (${scope.organizationId}, 'inbox-new', 'employee-1', 'inbox-order-new', 'Newer', 'Newer notification', '2026-07-29T11:00:00.000Z')
    `;
    const inbox = new PostgresInboxAdapter(sql!);
    expect((await inbox.forUser(scope, 'employee-1')).map((notification) => notification.id)).toEqual(['inbox-new', 'inbox-old']);
  });
});
