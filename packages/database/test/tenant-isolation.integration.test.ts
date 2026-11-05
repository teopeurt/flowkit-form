import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { PostgresInboxAdapter, PostgresOutboxStore, PostgresTaskStore, LeaveFlowRepository, readDelivery } from '../src';
import { durableTestDatabase } from '../../../test/durable-test-database';

const acme = { organizationId: 'acme-demo' };
const globex = { organizationId: 'globex-demo' };
const sql = await durableTestDatabase('tenant isolation', [
  'users', 'leave_requests', 'leave_transitions', 'flow_tasks', 'flow_task_events',
  'flow_task_projection_operations', 'flow_task_invitations',
  'notification_outbox', 'notification_inbox', 'audit_events',
]);
const durableTests = sql ? describe : describe.skip;

beforeAll(async () => {
  if (!sql) return;
  await sql`
    INSERT INTO better_auth.organization (id, name, slug) VALUES
      ('acme-demo', 'Acme Demo', 'acme-demo'),
      ('globex-demo', 'Globex Demo', 'globex-demo')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`INSERT INTO roles (role_key, readonly) VALUES ('employee', false), ('manager', false) ON CONFLICT (role_key) DO NOTHING`;
  for (const [organizationId, suffix] of [['acme-demo', 'acme'], ['globex-demo', 'globex']] as const) {
    await sql`
      INSERT INTO users (organization_id, id, email, role_key) VALUES
        (${organizationId}, ${`${suffix}-employee`}, ${`${suffix}-employee@example.test`}, 'employee'),
        (${organizationId}, ${`${suffix}-manager`}, ${`${suffix}-manager@example.test`}, 'manager')
    `;
    await sql`
      INSERT INTO leave_requests (
        organization_id, id, employee_id, manager_id, start_date, end_date, business_days,
        reason, balance_days, stage, revision, operation_key, flow_id, definition_hash
      ) VALUES (
        ${organizationId}, ${`${suffix}-leave`}, ${`${suffix}-employee`}, ${`${suffix}-manager`},
        '2026-08-17', '2026-08-17', 1, 'Tenant isolation', 10, 'manager_review', 0,
        'shared-create', 'shared-flow', 'sha256:test'
      )
    `;
    await sql`
      INSERT INTO leave_transitions (organization_id, leave_id, sequence, operation_key, action, actor_id, from_stage, to_stage)
      VALUES (${organizationId}, ${`${suffix}-leave`}, 1, 'shared-transition', 'submit', ${`${suffix}-employee`}, 'draft', 'manager_review')
    `;
    await sql`
      INSERT INTO flow_tasks (organization_id, id, flow_id, subject_id, stage, role_key, status, revision, lifecycle_epoch, opened_operation_key)
      VALUES (${organizationId}, ${`${suffix}-task`}, 'shared-flow', ${`${suffix}-leave`}, 'manager_review', 'manager', 'open', 0, 1, 'shared-task-open')
    `;
    await sql`
      INSERT INTO flow_task_events (organization_id, task_id, sequence, operation_key, event_type, actor_id)
      VALUES (${organizationId}, ${`${suffix}-task`}, 0, 'shared-task-event', 'opened', 'system')
    `;
    await sql`
      INSERT INTO flow_task_invitations (
        organization_id, id, task_id, subject_type, subject_id, role_key, contact_kind,
        contact_hash, contact_hash_key_version, token_hash, status, expires_at, source_key
      ) VALUES (
        ${organizationId}, ${`${suffix}-invitation`}, ${`${suffix}-task`}, 'leave', ${`${suffix}-leave`}, 'manager', 'email',
        ${`${suffix}-contact`}, 'v1', 'shared-token', 'pending', '2027-08-17T00:00:00.000Z', 'shared-invitation-source'
      )
    `;
    const payload = {
      namespace: 'flowkit-demo', sourceKey: `${suffix}-notification`, aggregate: { type: 'leave', id: `${suffix}-leave` },
      templateKey: 'leave.accepted', channel: 'inbox',
      recipient: { channel: 'inbox', canonicalKey: `${suffix}-employee`, address: `${suffix}-employee` },
      rendered: { subject: `${suffix} notification`, body: 'Tenant-only', severity: 'success' },
      dedupeKey: 'shared-notification', payloadFingerprint: `${suffix}-payload`, requestFingerprint: `${suffix}-request`,
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 10000 }, metadata: {},
    };
    await sql`
      INSERT INTO notification_outbox (organization_id, id, dedupe_key, channel, status, attempt_count, available_at, payload)
      VALUES (${organizationId}, ${`${suffix}-delivery`}, 'shared-notification', 'inbox', 'pending', 0, now(), ${sql.json(payload)})
    `;
    await sql`
      INSERT INTO notification_inbox (organization_id, id, user_id, dedupe_key, subject, body)
      VALUES (${organizationId}, ${`${suffix}-inbox`}, ${`${suffix}-employee`}, 'shared-inbox', ${`${suffix} notification`}, 'Tenant-only')
    `;
  }
});

afterAll(async () => {
  if (!sql) return;
  await sql`DELETE FROM notification_inbox WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM notification_outbox WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM flow_task_invitations WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM flow_task_events WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM flow_tasks WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM leave_transitions WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM leave_requests WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM users WHERE organization_id IN ('acme-demo', 'globex-demo')`;
  await sql`DELETE FROM better_auth.organization WHERE id IN ('acme-demo', 'globex-demo')`;
  await sql.end({ timeout: 5 });
});

durableTests('bidirectional tenant isolation', () => {
  it.each([
    [acme, 'globex'],
    [globex, 'acme'],
  ] as const)('prevents %s from reading, listing, claiming, mutating, or receiving %s records', async (scope, foreign) => {
    const own = scope.organizationId === 'acme-demo' ? 'acme' : 'globex';
    const leave = new LeaveFlowRepository({ sql: sql! });
    const tasks = new PostgresTaskStore(sql!);
    const outbox = new PostgresOutboxStore(sql!);
    const inbox = new PostgresInboxAdapter(sql!);

    expect(await leave.getRequest(scope, `${own}-leave`)).not.toBeNull();
    expect(await leave.getRequest(scope, `${foreign}-leave`)).toBeNull();
    expect(await leave.getRequestByFlowId(scope, 'shared-flow')).toMatchObject({ id: `${own}-leave` });
    expect(await leave.listActivities(scope, `${own}-leave`)).toHaveLength(1);
    expect(await leave.listActivities(scope, `${foreign}-leave`)).toEqual([]);
    expect(await tasks.get(scope, `${foreign}-task`)).toBeNull();
    expect(await tasks.history(scope, `${foreign}-task`)).toEqual([]);
    const taskIds = (await tasks.inbox(scope, { view: 'all' })).items.map((task) => task.id);
    expect(taskIds).toContain(`${own}-task`);
    expect(taskIds).not.toContain(`${foreign}-task`);
    expect(await tasks.claim(scope, {
      taskId: `${foreign}-task`, expectedRevision: 0, actorId: `${scope.organizationId}-manager`,
      operationId: `${scope.organizationId}-guessed-claim`, now: new Date().toISOString(),
    })).toEqual({ task: null, reason: 'not_found' });
    const now = new Date().toISOString();
    expect(await tasks.release(scope, {
      taskId: `${foreign}-task`, expectedRevision: 0, actorId: `${own}-manager`, operationId: `${own}-release`, reason: 'isolation-test', now,
    })).toEqual({ task: null, reason: 'not_found' });
    expect(await tasks.reassign(scope, {
      taskId: `${foreign}-task`, expectedRevision: 0, actorId: `${own}-manager`, targetActorId: `${own}-manager`,
      operationId: `${own}-reassign`, reason: 'isolation-test', now,
    })).toEqual({ task: null, reason: 'not_found' });
    expect(await tasks.getInvitationByTokenHash(scope, 'shared-token')).toMatchObject({ id: `${own}-invitation` });
    expect(await tasks.redeemInvitation(scope, {
      invitationId: `${foreign}-invitation`, identityId: `${own}-manager`, expectedExpiry: '2027-08-17T00:00:00.000Z', now,
      operationId: `${own}-redeem`,
    })).toBeNull();
    await tasks.revokeInvitation(scope, { invitationId: `${foreign}-invitation`, now, operationId: `${own}-revoke` });
    const [foreignInvitation] = await sql!<Array<{ status: string }>>`
      SELECT status FROM flow_task_invitations
      WHERE organization_id = ${foreign === 'acme' ? acme.organizationId : globex.organizationId}
        AND id = ${`${foreign}-invitation`}
    `;
    expect(foreignInvitation?.status).toBe('pending');
    expect(await outbox.listForRecipient(scope, `${own}-employee`)).toHaveLength(1);
    expect(await outbox.listForRecipient(scope, `${foreign}-employee`)).toEqual([]);
    expect(await readDelivery(scope, sql!, `${foreign}-delivery`)).toBeNull();
    expect(await readDelivery(scope, sql!, 'missing-delivery')).toBeNull();
    expect(await inbox.forUser(scope, `${own}-employee`)).toHaveLength(1);
    expect(await inbox.forUser(scope, `${foreign}-employee`)).toEqual([]);
    const claimed = await outbox.claimDue(scope, `${own}-worker`, new Date(), 60_000, 10);
    expect(claimed.map((delivery) => delivery.id)).toEqual([`${own}-delivery`]);
    expect(claimed[0]?.envelope.dedupeKey).toBe('shared-notification');
    const foreignScope = foreign === 'acme' ? acme : globex;
    const beforeForeignDelivery = await readDelivery(foreignScope, sql!, `${foreign}-delivery`);
    await expect(outbox.recordDelivered(scope, {
      id: `${foreign}-delivery`, owner: `${foreign}-worker`, providerMessageId: `${own}-guess`,
    })).rejects.toThrow('lease is no longer valid');
    expect(await readDelivery(foreignScope, sql!, `${foreign}-delivery`)).toEqual(beforeForeignDelivery);
  });

  it('returns the same result for foreign and nonexistent guessed identifiers', async () => {
    const tasks = new PostgresTaskStore(sql!);
    expect(await tasks.get(acme, 'globex-task')).toBeNull();
    expect(await tasks.get(acme, 'does-not-exist')).toBeNull();
  });

  it('allows tenant-local workflow, operation, invitation, and notification keys in both organizations', async () => {
    const [keys] = await sql!<Array<{ flows: string; transitions: string; invitation_tokens: string; outbox_dedupes: string; inbox_dedupes: string }>>`
      SELECT
        (SELECT count(*)::text FROM leave_requests WHERE flow_id = 'shared-flow') AS flows,
        (SELECT count(*)::text FROM leave_transitions WHERE operation_key = 'shared-transition') AS transitions,
        (SELECT count(*)::text FROM flow_task_invitations WHERE token_hash = 'shared-token') AS invitation_tokens,
        (SELECT count(*)::text FROM notification_outbox WHERE dedupe_key = 'shared-notification') AS outbox_dedupes,
        (SELECT count(*)::text FROM notification_inbox WHERE dedupe_key = 'shared-inbox') AS inbox_dedupes
    `;
    expect(keys).toEqual({ flows: '2', transitions: '2', invitation_tokens: '2', outbox_dedupes: '2', inbox_dedupes: '2' });
  });

  it('does not transition a foreign leave guessed by identifier', async () => {
    const repository = new LeaveFlowRepository({ sql: sql! });
    const before = await repository.getRequest(globex, 'globex-leave');
    await expect(repository.recordTransition(acme, {
      workflowId: 'shared-flow', runId: 'guessed-run', operationId: 'guessed-operation', sequence: 1, origin: 'human',
      definition: { id: 'leave-approval', version: 1, hash: 'sha256:test' }, subject: { id: 'globex-leave', metadata: {} },
      command: { action: 'approve', actorId: 'acme-manager' },
      previousState: { stage: 'manager_review', status: 'active', pendingRole: 'manager', tracks: {} },
      nextState: { stage: 'approved', status: 'completed', pendingRole: null, tracks: {} },
      transition: { action: 'approve', fromStage: 'manager_review', nextStage: 'approved', status: 'completed', pendingRole: null, trackUpdates: {} },
    })).rejects.toThrow();
    expect(await repository.getRequest(globex, 'globex-leave')).toEqual(before);
  });
});
