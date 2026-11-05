import { randomUUID } from 'node:crypto';

import {
  createFlowkitConsumer,
  type FlowRuntime,
  type FlowkitActorResolver,
  type FlowkitConsumer,
  type FlowkitConsumerStart,
} from '@naakwu/flowkit-consumer';
import { publishDefinition } from '@naakwu/flowkit-temporal';

import { resolveDemoActor, tenantWorkflowId } from '@flowkit-demo/domain';
import { LeaveFlowRepository } from '@flowkit-demo/database';
import { leaveDefinition } from '@flowkit-demo/domain';
import { leaveRequestSchema, type LeaveRequest } from '@flowkit-demo/domain';
import { PostgresInboxAdapter } from '@flowkit-demo/database';
import type { TenantScope } from '@flowkit-demo/database';
import { leaveRuntime } from './temporal.client';

export const publishedLeaveDefinition = publishDefinition({ definition: leaveDefinition });

type FlowkitDemoConsumerDependencies = {
  runtime?: FlowRuntime;
  repository?: LeaveFlowRepository;
  actorResolver?: FlowkitActorResolver;
  now?: () => string;
};

export type LeaveFlowSubject = FlowkitConsumerStart['subject'] & { metadata: LeaveRequest };

/**
 * The demo's only Flowkit composition root. HTTP adapters use this facade and
 * never calculate a transition or alter workflow state themselves.
 */
export class FlowkitDemoConsumer {
  readonly repository: LeaveFlowRepository;
  readonly outbox;
  readonly inbox: PostgresInboxAdapter;
  private readonly actorResolver: FlowkitActorResolver;
  private readonly runtime: FlowRuntime;
  private readonly now: () => string;

  constructor(dependencies: FlowkitDemoConsumerDependencies = {}) {
    this.repository = dependencies.repository ?? new LeaveFlowRepository();
    this.outbox = this.repository.outbox;
    this.inbox = new PostgresInboxAdapter(this.repository.sql);
    this.actorResolver = dependencies.actorResolver ?? { resolve: resolveDemoActor };
    this.runtime = dependencies.runtime ?? leaveRuntime;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  private consumer(scope: TenantScope): FlowkitConsumer {
    const runtime = this.runtimeFor(scope);
    return createFlowkitConsumer({
      definition: publishedLeaveDefinition,
      runtime,
      tasks: this.repository.tasks.forOrganization(scope),
      actorResolver: this.actorResolver,
      eligibility: {
        canWorkRole: async ({ actorId, role, task }) => {
          const actor = await this.actorResolver.resolve(actorId);
          if (!actor.roles.includes(role)) return false;
          if (task.subjectType !== 'leave' || role !== 'manager') return true;
          const request = await this.repository.getRequest(scope, task.subjectId);
          return request?.manager_id === actor.id;
        },
      },
      clock: { now: this.now },
      views: {
        read: (state) => state,
        readByFlowId: async (flowId) => runtime.get({ flowId }),
      },
    });
  }

  tasks(scope: TenantScope): FlowkitConsumer['tasks'] {
    return this.consumer(scope).tasks;
  }

  async start(scope: TenantScope, input: FlowkitConsumerStart) {
    const actor = await this.actorResolver.resolve(input.actor.id);
    const request = leaveRequestSchema.parse({ ...(input.subject.metadata ?? {}), employeeId: actor.id });
    if (!actor.roles.includes('employee') || request.employeeId !== actor.id) throw new Error('employee_not_authorized');
    await this.repository.createRequest(scope, {
      id: input.subject.id,
      flowId: input.flowId,
      request,
      operationId: input.operationId,
      definitionHash: publishedLeaveDefinition.definitionHash,
    });
    const view = await this.consumer(scope).start({
      ...input,
      actor: { ...actor, organizationId: scope.organizationId },
      subject: { id: input.subject.id, metadata: { ...request, organizationId: scope.organizationId } },
    });
    return { id: input.flowId, ...view };
  }

  async act(scope: TenantScope, input: Parameters<FlowkitConsumer['act']>[0]) {
    await this.requireFlow(scope, input.flowId);
    return this.consumer(scope).act({ ...input, actor: { ...input.actor, organizationId: scope.organizationId } });
  }

  async getFlow(scope: TenantScope, flowId: string) {
    await this.requireFlow(scope, flowId);
    return this.consumer(scope).getFlow(flowId);
  }

  private async requireFlow(scope: TenantScope, flowId: string) {
    if (!await this.repository.getRequestByFlowId(scope, flowId)) throw new Error('flow_not_found');
  }

  private runtimeFor(scope: TenantScope): FlowRuntime {
    const qualify = (flowId: string) => tenantWorkflowId(scope.organizationId, flowId);
    return {
      start: (input) => this.runtime.start({ ...input, flowId: qualify(input.flowId) }),
      act: (input) => this.runtime.act({ ...input, flowId: qualify(input.flowId) }),
      get: (input) => this.runtime.get({ ...input, flowId: qualify(input.flowId) }),
      health: () => this.runtime.health(),
    };
  }
}

export function createFlowkitDemoConsumer(dependencies: FlowkitDemoConsumerDependencies = {}) {
  return new FlowkitDemoConsumer(dependencies);
}

export function newLeaveFlowId() {
  return `leave-${randomUUID()}`;
}
