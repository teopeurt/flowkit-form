import type { FlowCommand, FlowState } from '@naakwu/flowkit-core';
import type { FlowTask } from '@naakwu/flowkit-tasks';

import { LeaveFlowRepository, type TenantScope } from '@flowkit-demo/database';
import { FlowkitDemoConsumer, newLeaveFlowId } from '../flow/flowkit-demo.consumer';
import { leaveRequestSchema, type LeaveRequest } from '@flowkit-demo/domain';

export type LeaveRecord = LeaveRequest & {
  id: string;
  flowId: string;
  state: FlowState;
  sequence: number;
  history: FlowState[];
};

/**
 * Compatibility adapter for the demo scripts. It deliberately delegates every
 * command to the Flowkit consumer; transition evaluation lives in the worker.
 */
export class LeaveService {
  readonly repository: LeaveFlowRepository;
  readonly consumer: FlowkitDemoConsumer;
  readonly tasks;
  readonly outbox;
  readonly scope: TenantScope;

  constructor(repository = new LeaveFlowRepository(), scope: TenantScope = { organizationId: 'acme-demo' }) {
    this.repository = repository;
    this.consumer = new FlowkitDemoConsumer({ repository });
    this.scope = scope;
    this.tasks = repository.tasks.forOrganization(scope);
    this.outbox = repository.outbox;
  }

  async listTasks() {
    return this.tasks.inbox({ view: 'role_queue', roles: ['manager'], statuses: ['open', 'claimed'] });
  }

  async listNotifications(recipientId: string) {
    return this.outbox.listForRecipient(this.scope, recipientId);
  }

  async create(input: unknown, employeeId: string): Promise<LeaveRecord> {
    const request = leaveRequestSchema.parse({ ...(input as object), employeeId });
    const id = newLeaveFlowId();
    const flowId = `flow-${id}`;
    const state = await this.consumer.start(this.scope, {
      flowId,
      subject: { id, metadata: request },
      actor: { id: employeeId, roles: ['employee'] },
      operationId: `${id}:start`,
    });
    return { ...request, id, flowId, state: state.state, sequence: state.sequence, history: [] };
  }

  async get(id: string): Promise<LeaveRecord | null> {
    const request = await this.repository.getRequest(this.scope, id);
    if (!request) return null;
    const state = await this.consumer.getFlow(this.scope, request.flow_id);
    return {
      id: request.id,
      flowId: request.flow_id,
      employeeId: request.employee_id,
      managerId: request.manager_id,
      startDate: new Date(request.start_date).toISOString().slice(0, 10),
      endDate: new Date(request.end_date).toISOString().slice(0, 10),
      businessDays: request.business_days,
      reason: request.reason,
      balanceDays: request.balance_days,
      metadata: {},
      state: state.state,
      sequence: state.sequence,
      history: [],
    };
  }

  async command(id: string, command: FlowCommand, actor: { id: string; roles: string[] }): Promise<LeaveRecord> {
    const request = await this.repository.getRequest(this.scope, id);
    if (!request) throw new Error('leave_not_found');
    await this.consumer.act(this.scope, {
      flowId: request.flow_id,
      action: command.action,
      comment: command.comment,
      actor,
      operationId: `${request.flow_id}:${command.action}:${Date.now()}`,
    });
    const result = await this.get(id);
    if (!result) throw new Error('leave_not_found');
    return result;
  }

  async claim(task: FlowTask, actorId: string) {
    return this.tasks.claim({
      taskId: task.id,
      expectedRevision: task.revision,
      actorId,
      operationId: `claim:${task.id}:${actorId}`,
      now: new Date().toISOString(),
    });
  }
}
