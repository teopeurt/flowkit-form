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
        flowId: 'flow-shared', action: 'submit', actor: { id: 'globex-employee', roles: ['employee'] }, operationId: 'guess',
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
      flowId: 'flow-shared', action: 'submit', actor: { id: 'acme-employee', roles: ['employee'] }, operationId: 'submit',
    });

    expect(calls).toEqual([`${operation}:flowkit/acme-demo/flow-shared`]);
  });

  it('maps the same public flow identifier to distinct Temporal workflow identifiers', async () => {
    const flowIds: string[] = [];
    const runtime: FlowRuntime = {
      start: async () => state,
      get: async ({ flowId }) => { flowIds.push(flowId); return state; },
      act: async () => state,
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
});
