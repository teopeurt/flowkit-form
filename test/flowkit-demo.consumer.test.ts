import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { createFlowkitTemporalRuntime } from '@naakwu/flowkit-temporal';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';

import { LeaveFlowRepository } from '@flowkit-demo/database';
import { createFlowkitDemoConsumer, publishedLeaveDefinition } from '../apps/api/src/flow/flowkit-demo.consumer';
import { createLeaveActivities } from '../apps/worker/src/activities';
import { leaveWorkflowType } from '@flowkit-demo/domain';
import { clearDurableLeaveServiceData, durableLeaveServiceDatabase } from './durable-test-database';

const sql = await durableLeaveServiceDatabase('Flowkit demo consumer');
const durableTests = sql ? describe : describe.skip;
const scope = { organizationId: 'acme-demo' };
const employee = { id: 'employee-1', roles: ['employee'] };
const manager1 = { id: 'manager-1', roles: ['manager'] };
const manager2 = { id: 'manager-2', roles: ['manager'] };
const fiveDayLeave = {
  id: 'leave-1',
  metadata: {
    employeeId: employee.id,
    managerId: manager1.id,
    startDate: '2026-08-03',
    endDate: '2026-08-07',
    businessDays: 5,
    reason: 'Family travel',
    balanceDays: 10,
    metadata: {},
  },
};

async function eventually(assertion: () => Promise<void>, attempts = 80) {
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
      await Bun.sleep(25);
    }
  }
  throw failure;
}

afterEach(() => clearDurableLeaveServiceData(sql));
afterAll(async () => { if (sql) await sql.end({ timeout: 5 }); });

durableTests('Flowkit demo consumer', () => {
  it('persists the published definition hash, routes multi-day leave to a manager task, and rejects a decision by another manager', async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    const repository = new LeaveFlowRepository({ sql: sql! });
    const taskQueue = 'flowkit-demo';
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: new URL('../apps/worker/src/workflows.ts', import.meta.url).pathname,
      activities: createLeaveActivities({ repository }),
    });
    const runWorker = worker.run();
    const runtime = createFlowkitTemporalRuntime({
      client: environment.client,
      taskQueue,
      workflowType: leaveWorkflowType,
      healthProbe: async () => ({ ready: true, checkedAt: new Date().toISOString() }),
    });
    const consumer = createFlowkitDemoConsumer({ repository, runtime });

    try {
      const flow = await consumer.start(scope, { flowId: 'leave-1', subject: fiveDayLeave, actor: employee, operationId: 'start-1' });
      const [request] = await sql!<{ definition_hash: string }[]>`
        SELECT definition_hash FROM leave_requests WHERE id = ${fiveDayLeave.id}
      `;
      expect(request?.definition_hash).toBe(publishedLeaveDefinition.definitionHash);
      await consumer.act(scope, { flowId: flow.id, action: 'submit', actor: employee, operationId: 'submit-1' });
      await eventually(async () => expect((await consumer.getFlow(scope, flow.id)).state.stage).toBe('manager_review'));
      const [task] = (await consumer.tasks(scope).list({ actor: manager1 })).items;
      await consumer.tasks(scope).claim({ taskId: task!.id, expectedRevision: task!.revision, actor: manager1, operationId: 'claim-1' });
      await expect(consumer.act(scope, { flowId: flow.id, action: 'approve', actor: manager2, operationId: 'approve-2' })).rejects.toThrow('task_not_owned');
    } finally {
      await worker.shutdown();
      await runWorker;
      await environment.teardown();
    }
  }, 30_000);
});
