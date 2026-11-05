import { describe, expect, it } from 'bun:test';
import type { FlowRuntime } from '@naakwu/flowkit-consumer';

import { FlowkitDemoConsumer } from '../apps/api/src/flow/flowkit-demo.consumer';

const state = { state: { stage: 'draft', status: 'pending', pendingRole: null, tracks: {} }, sequence: 0, stepResults: {}, completed: false, nextActions: [] };

describe('Flowkit consumer tenant binding', () => {
  it.each(['get', 'act'] as const)('rejects a wrong-scope %s before calling Temporal', async (operation) => {
    const calls: string[] = [];
    const runtime: FlowRuntime = {
      start: async () => state,
      get: async ({ flowId }) => { calls.push(`get:${flowId}`); return state; },
      act: async ({ flowId }) => { calls.push(`act:${flowId}`); return state; },
      signal: async ({ flowId }: { flowId: string }) => { calls.push(`signal:${flowId}`); return state; },
      health: async () => ({ ready: true, checkedAt: new Date().toISOString() }),
    };
    const repository = {
      sql: {}, outbox: {}, tasks: { forOrganization: () => ({}) },
      getRequestByFlowId: async (scope: { organizationId: string }) => scope.organizationId === 'acme-demo' ? { flow_id: 'flow-shared' } : null,
    };
    const consumer = new FlowkitDemoConsumer({ repository: repository as any, runtime });
    const invoke = operation === 'get'
      ? () => consumer.getFlow({ organizationId: 'globex-demo' }, 'flow-shared')
      : () => consumer.act({ organizationId: 'globex-demo' }, {
        flowId: 'flow-shared', action: 'submit', actor: { id: 'globex-employee', roles: ['employee'], organizationId: 'globex-demo' }, operationId: 'guess',
      });

    await expect(invoke()).rejects.toThrow('flow_not_found');
    expect(calls).toEqual([]);
  });

  it.each(['get', 'act'] as const)('allows a bound-scope %s to reach Temporal', async (operation) => {
    const calls: string[] = [];
    const runtime: FlowRuntime = {
      start: async () => state,
      get: async ({ flowId }) => { calls.push(`get:${flowId}`); return state; },
      act: async ({ flowId }) => { calls.push(`act:${flowId}`); return state; },
      signal: async ({ flowId }: { flowId: string }) => { calls.push(`signal:${flowId}`); return state; },
      health: async () => ({ ready: true, checkedAt: new Date().toISOString() }),
    };
    const repository = {
      sql: {}, outbox: {}, tasks: { forOrganization: () => ({}) },
      getRequestByFlowId: async (scope: { organizationId: string }) => scope.organizationId === 'acme-demo' ? { flow_id: 'flow-shared' } : null,
    };
    const consumer = new FlowkitDemoConsumer({
      repository: repository as any,
      runtime,
      actorResolver: { resolve: async (id) => ({ id, roles: ['employee'], organizationId: 'acme-demo' }) },
    });

    if (operation === 'get') await consumer.getFlow({ organizationId: 'acme-demo' }, 'flow-shared');
    else await consumer.act({ organizationId: 'acme-demo' }, {
      flowId: 'flow-shared', action: 'submit', actor: { id: 'acme-employee', roles: ['employee'], organizationId: 'acme-demo' }, operationId: 'submit',
    });

    expect(calls).toEqual([`${operation}:flowkit/acme-demo/flow-shared`]);
  });

  it('maps the same public flow identifier to distinct Temporal workflow identifiers', async () => {
    const flowIds: string[] = [];
    const runtime: FlowRuntime = {
      start: async () => state,
      get: async ({ flowId }) => { flowIds.push(flowId); return state; },
      act: async () => state,
      signal: async () => state,
      health: async () => ({ ready: true, checkedAt: new Date().toISOString() }),
    };
    const repository = {
      sql: {}, outbox: {}, tasks: { forOrganization: () => ({}) },
      getRequestByFlowId: async () => ({ flow_id: 'shared-flow' }),
    };
    const consumer = new FlowkitDemoConsumer({ repository: repository as any, runtime });

    await consumer.getFlow({ organizationId: 'acme-demo' }, 'shared-flow');
    await consumer.getFlow({ organizationId: 'globex-demo' }, 'shared-flow');

    expect(flowIds).toEqual(['flowkit/acme-demo/shared-flow', 'flowkit/globex-demo/shared-flow']);
  });

  it('forwards signals through the tenant-qualified runtime adapter', async () => {
    const calls: string[] = [];
    const runtime: FlowRuntime = {
      start: async () => state,
      get: async () => state,
      act: async () => state,
      signal: async ({ flowId, action, operationId }: { flowId: string; action: string; operationId: string }) => {
        calls.push(`signal:${flowId}:${action}:${operationId}`);
        return state;
      },
      health: async () => ({ ready: true, checkedAt: new Date().toISOString() }),
    };
    const repository = {
      sql: {}, outbox: {}, tasks: { forOrganization: () => ({}) },
      getRequestByFlowId: async () => ({ flow_id: 'flow-shared' }),
    };
    const consumer = new FlowkitDemoConsumer({ repository: repository as any, runtime });

    await (consumer as any).runtimeFor({ organizationId: 'acme-demo' }).signal({
      flowId: 'flow-shared', action: 'refresh', operationId: 'signal-1',
    });

    expect(calls).toEqual(['signal:flowkit/acme-demo/flow-shared:refresh:signal-1']);
  });

  it('hides claimed tasks when the resolved actor belongs to another organization', async () => {
    const claimedTask = {
      id: 'task-shared', flowId: 'flow-shared', subjectType: 'leave', subjectId: 'leave-shared',
      stage: 'manager_review', role: 'manager', status: 'claimed', assigneeId: 'same-id', revision: 1,
    };
    const repository = {
      sql: {}, outbox: {},
      tasks: { forOrganization: () => ({ inbox: async () => ({ items: [claimedTask], nextCursor: null }) }) },
      getRequestByFlowId: async () => null,
    };
    const consumer = new FlowkitDemoConsumer({
      repository: repository as any,
      actorResolver: { resolve: async () => ({ id: 'same-id', roles: ['manager'], organizationId: 'globex-demo' }) },
    });

    const page = await consumer.tasks({ organizationId: 'acme-demo' }).list({
      actor: { id: 'same-id', roles: ['manager'], organizationId: 'acme-demo' },
    });

    expect(page.items).toEqual([]);
  });
});
