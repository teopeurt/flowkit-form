import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { buildInitialState, type FlowState } from '@naakwu/flowkit-core';
import type { RecordTransitionInput } from '@naakwu/flowkit-temporal';

import { LeaveFlowRepository, scopeOperationId } from '@flowkit-demo/database';
import { publishedLeaveDefinition } from '../apps/api/src/flow/flowkit-demo.consumer';
import { leaveDefinition } from '@flowkit-demo/domain';
import { durableTestDatabase } from './durable-test-database';

const sql = await durableTestDatabase('leave flow operation scope', [
  'leave_requests', 'leave_transitions', 'flow_tasks', 'flow_task_events',
  'flow_task_projection_operations', 'flow_task_invitations', 'notification_outbox', 'audit_events',
]);
const durableTests = sql ? describe : describe.skip;
const scope = { organizationId: 'acme-demo' };

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

const initial = buildInitialState(leaveDefinition);
const evaluating: FlowState = { stage: 'policy_evaluation', status: 'active', pendingRole: null, tracks: {} };

/** The interpreter numbers automatic steps per flow, so every flow produces this same id. */
const ruleOperationId = 'rule:1:1';

function ruleTransition(id: string): RecordTransitionInput {
  return {
    workflowId: `flow-${id}`,
    runId: `run-${id}`,
    operationId: ruleOperationId,
    sequence: 1,
    origin: 'rule',
    definition: {
      id: leaveDefinition.id,
      version: leaveDefinition.version,
      hash: publishedLeaveDefinition.definitionHash,
    },
    subject: { id, metadata: {} },
    command: { action: 'submit', actorId: 'employee-1' },
    previousState: initial,
    nextState: evaluating,
    transition: {
      action: 'submit', fromStage: initial.stage, nextStage: evaluating.stage,
      status: 'active', pendingRole: null, trackUpdates: {},
    },
  };
}

async function seedRequest(repository: LeaveFlowRepository, id: string) {
  await repository.createRequest(scope, {
    id,
    flowId: `flow-${id}`,
    request: {
      employeeId: 'employee-1', managerId: 'manager-1', startDate: '2026-08-03',
      endDate: '2026-08-07', businessDays: 5, reason: 'Operation scope', balanceDays: 10,
      metadata: {},
    },
    operationId: `${id}:start`,
    definitionHash: publishedLeaveDefinition.definitionHash,
  });
}

durableTests('leave flow operation scope', () => {
  it('records the same interpreter operation id for two different flows', async () => {
    const repository = new LeaveFlowRepository({ sql: sql! });
    await seedRequest(repository, 'leave-scope-a');
    await seedRequest(repository, 'leave-scope-b');

    const first = await repository.recordTransition(scope, ruleTransition('leave-scope-a'));
    const second = await repository.recordTransition(scope, ruleTransition('leave-scope-b'));

    expect(first).toMatchObject({ state: evaluating, created: true });
    expect(second).toMatchObject({ state: evaluating, created: true });
    const keys = await sql!<Array<{ operation_key: string }>>`
      SELECT operation_key FROM leave_transitions ORDER BY operation_key
    `;
    expect(keys.map((row) => row.operation_key)).toEqual([
      scopeOperationId('flow-leave-scope-a', ruleOperationId),
      scopeOperationId('flow-leave-scope-b', ruleOperationId),
    ]);
  });

  it('still treats a replay of one flow\'s operation as already committed', async () => {
    const repository = new LeaveFlowRepository({ sql: sql! });
    await seedRequest(repository, 'leave-scope-a');

    const input = ruleTransition('leave-scope-a');
    await repository.recordTransition(scope, input);
    const replay = await repository.recordTransition(scope, input);

    expect(replay).toMatchObject({ state: evaluating, created: false });
    expect(await repository.findPriorResult(scope, input.workflowId, ruleOperationId)).toMatchObject({ created: false });
    const [count] = await sql!<Array<{ total: string }>>`SELECT count(*)::text AS total FROM leave_transitions`;
    expect(count!.total).toBe('1');
  });
});
