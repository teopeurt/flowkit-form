import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import { LeaveFlowRepository } from '@flowkit-demo/database';
import { LeaveService } from '../apps/api/src/leave/leave.service';
import { durableTestDatabase } from './durable-test-database';

const sql = await durableTestDatabase('durable LeaveService', [
  'leave_requests', 'leave_transitions', 'flow_tasks', 'flow_task_events',
  'flow_task_projection_operations', 'flow_task_invitations', 'notification_outbox', 'audit_events',
]);
const durableTests = sql ? describe : describe.skip;

afterEach(async () => {
  if (!sql) return;
  await sql`DELETE FROM notification_outbox`;
  await sql`DELETE FROM flow_task_invitations`;
  await sql`DELETE FROM flow_task_projection_operations`;
  await sql`DELETE FROM flow_task_events`;
  await sql`DELETE FROM flow_tasks`;
  await sql`DELETE FROM leave_transitions`;
  await sql`DELETE FROM audit_events`;
  await sql`DELETE FROM leave_requests`;
});
afterAll(async () => { if (sql) await sql.end({ timeout: 5 }); });

durableTests('durable LeaveService composition', () => {
  it('projects API leave commands into PostgreSQL tasks and outbox envelopes', async () => {
    const durable = new LeaveService(new LeaveFlowRepository({ sql: sql! }));
    const leave = await durable.create({ managerId: 'manager-1', startDate: '2026-08-03', endDate: '2026-08-03', businessDays: 1, reason: 'Durable API', balanceDays: 10 }, 'employee-1');
    await durable.command(leave.id, { action: 'submit' }, { id: 'employee-1', roles: ['employee'] });
    expect((await durable.get(leave.id))?.state.stage).toBe('policy_evaluation');
    expect((await durable.outbox.claimDue(durable.scope, 'notify-1', new Date(), 60_000, 10)).length).toBeGreaterThan(0);
  });
});
