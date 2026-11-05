import { buildInitialState, type FlowDefinition, type FlowState } from '@naakwu/flowkit-core';
import { planNotification, NotificationAdapterRegistry, testAdapter, type NotificationDeliveryEnvelope } from '@naakwu/flowkit-notify';
import { planTaskProjection } from '@naakwu/flowkit-tasks';
import type { DispatchNotificationInput, RecordStageReadyInput, RecordTransitionInput, RecordTransitionOutput } from '@naakwu/flowkit-temporal';
import type { Sql, TransactionSql } from 'postgres';

import { leaveDefinition } from '@flowkit-demo/domain';
import type { LeaveRequest } from '@flowkit-demo/domain';
import { notificationTemplates } from '@flowkit-demo/domain';
import { createDemoDatabaseClient } from './client';
import { jsonb } from './jsonb';
import { PostgresOutboxStore } from './postgres-outbox-store';
import { PostgresTaskStore } from './postgres-task-store';
import { requireTenantScope, type TenantScope } from './tenant-scope';

export type LeaveRequestRow = {
  organization_id: string;
  id: string;
  flow_id: string;
  employee_id: string;
  manager_id: string;
  start_date: Date | string;
  end_date: Date | string;
  business_days: number;
  reason: string;
  balance_days: number;
  stage: string;
  revision: number;
  definition_hash: string | null;
};
export type LeaveActivity = {
  actorId: string;
  action: string;
  fromStage: string;
  toStage: string;
  occurredAt: Date;
};
type PriorTransitionRow = { metadata: { nextState?: FlowState } | string };

export class LeaveFlowProjectionConflictError extends Error {
  constructor(workflowId: string, expectedStage: string) {
    super(`Leave flow ${workflowId} no longer matches expected stage ${expectedStage}.`);
    this.name = 'LeaveFlowProjectionConflictError';
  }
}

/**
 * A Flowkit operation id is unique within its flow, not globally: the interpreter derives ids such
 * as `rule:1:1` from a flow's own step sequence, so two flows reaching the same step produce the
 * same id. Every durable operation key in this schema is globally unique, so qualify the id with
 * its flow before it reaches the ledger — the same scoping the notification source key uses.
 */
export function scopeOperationId(flowId: string, operationId: string): string {
  return `${flowId}:${operationId}`;
}

/**
 * Durable leave read-model projection. The transition, audit, task mutations,
 * and notification envelopes share one PostgreSQL transaction.
 */
export class LeaveFlowRepository {
  readonly sql: Sql;
  readonly tasks: PostgresTaskStore;
  readonly outbox: PostgresOutboxStore;
  private readonly ownsClient: boolean;
  private readonly definition: FlowDefinition;
  private readonly adapters = new NotificationAdapterRegistry();

  constructor(options: { sql?: Sql; tasks?: PostgresTaskStore; outbox?: PostgresOutboxStore; definition?: FlowDefinition } = {}) {
    this.ownsClient = !options.sql;
    this.sql = options.sql ?? createDemoDatabaseClient();
    this.tasks = options.tasks ?? new PostgresTaskStore(this.sql);
    this.outbox = options.outbox ?? new PostgresOutboxStore(this.sql);
    this.definition = options.definition ?? leaveDefinition;
    this.adapters.register({ ...testAdapter('inbox'), enabled: true });
    this.adapters.register({ ...testAdapter('email'), enabled: true });
    this.adapters.freeze();
  }

  async findPriorResult(scope: TenantScope, workflowId: string, operationId: string): Promise<RecordTransitionOutput | undefined> {
    requireTenantScope(scope);
    const [row] = await this.sql<PriorTransitionRow[]>`
      SELECT a.metadata
      FROM leave_transitions t
      JOIN audit_events a ON a.organization_id = t.organization_id
        AND a.action = 'flowkit.transition' AND a.metadata->>'operationId' = t.operation_key
      WHERE t.organization_id = ${scope.organizationId}
        AND t.operation_key = ${scopeOperationId(workflowId, operationId)}
      LIMIT 1
    `;
    const metadata = typeof row?.metadata === 'string' ? JSON.parse(row.metadata) : row?.metadata;
    return metadata?.nextState ? { state: metadata.nextState, created: false } : undefined;
  }

  async createRequest(scope: TenantScope, input: { id: string; flowId: string; request: LeaveRequest; operationId: string; definitionHash: `sha256:${string}` }): Promise<void> {
    requireTenantScope(scope);
    const state = buildInitialState(this.definition);
    const operationKey = scopeOperationId(input.flowId, input.operationId);
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO leave_requests (
          organization_id, id, employee_id, manager_id, start_date, end_date, business_days, reason,
          balance_days, stage, revision, operation_key, flow_id, definition_hash
        ) VALUES (
          ${scope.organizationId}, ${input.id}, ${input.request.employeeId}, ${input.request.managerId}, ${input.request.startDate},
          ${input.request.endDate}, ${input.request.businessDays}, ${input.request.reason},
          ${input.request.balanceDays}, ${state.stage}, 0, ${operationKey}, ${input.flowId}, ${input.definitionHash}
        )
        ON CONFLICT (organization_id, operation_key) DO NOTHING
      `;
      const plan = planTaskProjection({
        namespace: 'flowkit-demo', flowId: input.flowId, subject: { type: 'leave', id: input.id },
        definition: this.definition, operationId: operationKey, transitionSequence: 0,
        action: 'open', actorId: input.request.employeeId, previousState: state, nextState: state, metadata: {},
      }, null);
      await this.tasks.applyProjectionInTransaction(scope, tx, { plan, operationId: operationKey });
    });
  }

  async getRequest(scope: TenantScope, id: string): Promise<LeaveRequestRow | null> {
    requireTenantScope(scope);
    const [row] = await this.sql<LeaveRequestRow[]>`
      SELECT organization_id, id, flow_id, employee_id, manager_id, start_date, end_date, business_days, reason, balance_days, stage, revision, definition_hash
      FROM leave_requests
      WHERE organization_id = ${scope.organizationId} AND id = ${id}
      LIMIT 1
    `;
    return row ?? null;
  }

  async getRequestByFlowId(scope: TenantScope, flowId: string): Promise<LeaveRequestRow | null> {
    requireTenantScope(scope);
    const [row] = await this.sql<LeaveRequestRow[]>`
      SELECT organization_id, id, flow_id, employee_id, manager_id, start_date, end_date, business_days, reason, balance_days, stage, revision, definition_hash
      FROM leave_requests
      WHERE organization_id = ${scope.organizationId} AND flow_id = ${flowId}
      LIMIT 1
    `;
    return row ?? null;
  }

  async listActivities(scope: TenantScope, leaveId: string): Promise<LeaveActivity[]> {
    requireTenantScope(scope);
    const rows = await this.sql<Array<{
      actor_id: string;
      action: string;
      from_stage: string;
      to_stage: string;
      created_at: Date | string;
    }>>`
      SELECT actor_id, action, from_stage, to_stage, created_at
      FROM leave_transitions
      WHERE organization_id = ${scope.organizationId} AND leave_id = ${leaveId}
      ORDER BY sequence ASC, id ASC
    `;
    return rows.map((row) => ({
      actorId: row.actor_id,
      action: row.action,
      fromStage: row.from_stage,
      toStage: row.to_stage,
      occurredAt: new Date(row.created_at),
    }));
  }

  async recordStageReady(scope: TenantScope, input: RecordStageReadyInput): Promise<void> {
    requireTenantScope(scope);
    await this.sql`
      INSERT INTO demo_runtime_state (state_key, state_value, updated_at)
      VALUES (
        ${`leave-stage-ready:${scope.organizationId}:${input.workflowId}`},
        ${jsonb(this.sql, { stage: input.state.stage, entryEpoch: input.entryEpoch, slaDeadline: input.slaDeadline ?? null })},
        now()
      )
      ON CONFLICT (state_key) DO UPDATE
      SET state_value = EXCLUDED.state_value, updated_at = EXCLUDED.updated_at
    `;
  }

  async dispatchNotification(scope: TenantScope, input: DispatchNotificationInput): Promise<void> {
    requireTenantScope(scope);
    const request = await this.getRequest(scope, input.subject.id);
    if (!request) throw new Error('leave_not_found');
    const notification = input.notification.template === 'manager'
      ? { template: 'leave.overdue', channels: ['inbox', 'email'], to: ['manager'] }
      : input.notification;
    await this.outbox.insert(scope, await this.notificationEnvelopes({
      workflowId: input.subject.id,
      runId: 'notification',
      operationId: input.operationKey,
      sequence: 0,
      origin: 'rule',
      definition: input.definition,
      subject: input.subject,
      command: { action: 'notify', actorId: 'system' },
      previousState: { stage: request.stage, status: 'pending', pendingRole: null, tracks: {} },
      nextState: { stage: request.stage, status: 'pending', pendingRole: null, tracks: {} },
      transition: { action: 'notify', fromStage: request.stage, nextStage: request.stage, status: 'pending', pendingRole: null, trackUpdates: {} },
      notify: {
        template: notification.template,
        channels: notification.channels.length > 0 ? notification.channels : ['inbox', 'email'],
        to: notification.to,
      },
    }, request));
  }

  async recordTransition(scope: TenantScope, input: RecordTransitionInput): Promise<RecordTransitionOutput> {
    requireTenantScope(scope);
    const operationKey = scopeOperationId(input.workflowId, input.operationId);
    return this.sql.begin(async (tx) => {
      const existing = await this.findPriorResultInTransaction(scope, tx, operationKey);
      if (existing) return existing;

      const advanced = await this.advanceRequest(scope, tx, input);
      if ('prior' in advanced) return advanced.prior;
      const request = advanced.request;
      await tx`
        INSERT INTO leave_transitions (organization_id, leave_id, sequence, operation_key, action, actor_id, from_stage, to_stage, run_key)
        VALUES (
          ${scope.organizationId}, ${input.subject.id}, ${input.sequence}, ${operationKey}, ${input.command.action},
          ${input.command.actorId ?? 'system'}, ${input.previousState.stage}, ${input.nextState.stage}, ${input.runId}
        )
      `;
      await tx`
        INSERT INTO audit_events (organization_id, actor_id, action, entity_id, metadata)
        VALUES (
          ${scope.organizationId}, ${input.command.actorId ?? 'system'}, 'flowkit.transition', ${input.subject.id},
          ${jsonb(this.sql, {
            workflowId: input.workflowId, runId: input.runId, operationId: operationKey,
            previousState: input.previousState, nextState: input.nextState,
            command: input.command, transition: input.transition,
          })}
        )
      `;
      const previousRole = input.previousState.pendingRole;
      const current = previousRole ? await this.tasks.findInTransaction(scope, tx, {
        namespace: 'flowkit-demo', flowId: input.workflowId, subjectType: 'leave', subjectId: input.subject.id,
        stage: input.previousState.stage, role: previousRole,
      }) : null;
      const taskPlan = planTaskProjection({
        namespace: 'flowkit-demo', flowId: input.workflowId, subject: { type: 'leave', id: input.subject.id },
        definition: this.definition, operationId: operationKey, transitionSequence: input.sequence,
        action: input.command.action, actorId: input.command.actorId ?? null,
        previousState: input.previousState, nextState: input.nextState, metadata: {},
      }, current);
      await this.tasks.applyProjectionInTransaction(scope, tx, { plan: taskPlan, operationId: operationKey });
      await this.outbox.insertInTransaction(scope, await this.notificationEnvelopes(input, request), tx);
      return { state: input.nextState, created: true };
    });
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.sql.end({ timeout: 5 });
  }

  private async findPriorResultInTransaction(scope: TenantScope, tx: TransactionSql, operationKey: string): Promise<RecordTransitionOutput | undefined> {
    const [row] = await tx<PriorTransitionRow[]>`
      SELECT a.metadata
      FROM leave_transitions t
      JOIN audit_events a ON a.organization_id = t.organization_id
        AND a.action = 'flowkit.transition' AND a.metadata->>'operationId' = t.operation_key
      WHERE t.organization_id = ${scope.organizationId} AND t.operation_key = ${operationKey}
      LIMIT 1
    `;
    const metadata = typeof row?.metadata === 'string' ? JSON.parse(row.metadata) : row?.metadata;
    return metadata?.nextState ? { state: metadata.nextState, created: false } : undefined;
  }

  private async advanceRequest(scope: TenantScope, tx: TransactionSql, input: RecordTransitionInput): Promise<{ request: LeaveRequestRow } | { prior: RecordTransitionOutput }> {
    const [request] = await tx<LeaveRequestRow[]>`
      UPDATE leave_requests
      SET stage = ${input.nextState.stage}, revision = revision + 1,
          flow_id = COALESCE(flow_id, ${input.workflowId}), definition_hash = ${input.definition.hash}
      WHERE organization_id = ${scope.organizationId}
        AND id = ${input.subject.id}
        AND stage = ${input.previousState.stage}
        AND revision = ${input.sequence - 1}
      RETURNING organization_id, id, employee_id, manager_id, stage, revision
    `;
    if (request) return { request };
    const duplicate = await this.findPriorResultInTransaction(scope, tx, scopeOperationId(input.workflowId, input.operationId));
    if (duplicate) return { prior: duplicate };
    throw new LeaveFlowProjectionConflictError(input.workflowId, input.previousState.stage);
  }

  private async notificationEnvelopes(input: RecordTransitionInput, request: LeaveRequestRow): Promise<NotificationDeliveryEnvelope[]> {
    if (!input.notify) return [];
    const recipientId = input.notify.to?.includes('manager') ? request.manager_id : request.employee_id;
    const plan = await planNotification({
      namespace: 'flowkit-demo', sourceKey: `flowkit:${input.workflowId}:${input.operationId}`,
      aggregate: { type: 'leave', id: input.subject.id }, templateKey: input.notify.template,
      data: { requestId: input.subject.id, stage: input.nextState.stage, employeeName: request.employee_id },
      channels: input.notify.channels,
      explicitRecipients: [{ key: recipientId, routes: input.notify.channels.map((channel) => ({
        channel, canonicalKey: recipientId,
        address: channel === 'email' ? `${recipientId}@example.test` : recipientId,
      })) }],
    }, { templates: notificationTemplates, adapters: this.adapters.values() });
    return plan.envelopes;
  }
}
