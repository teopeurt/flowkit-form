import type { FlowkitActorResolver } from '@naakwu/flowkit-consumer';
import type {
  ExecuteSystemStepInput,
  FlowkitActivityRegistry,
  ResolveActionContextInput,
} from '@naakwu/flowkit-temporal';
import { validateRegistryRefs } from '@naakwu/flowkit-core';

import { resolveDemoActor, tenantFlowId } from '@flowkit-demo/domain';
import { LeaveFlowRepository, requireTenantScope, type TenantScope } from '@flowkit-demo/database';
import { leaveDefinition } from '@flowkit-demo/domain';
import { leaveChannels, leaveGuards, leavePolicies, leaveRules, leaveSystemSteps, leaveTemplates } from '@flowkit-demo/domain';

type LeaveActivityDependencies = {
  repository?: LeaveFlowRepository;
  actorResolver?: FlowkitActorResolver;
};

function scopeFromSubject(subject: { metadata?: Record<string, unknown> }): TenantScope {
  return requireTenantScope({ organizationId: typeof subject.metadata?.organizationId === 'string' ? subject.metadata.organizationId : '' });
}

const outputForSystemStep = async (repository: LeaveFlowRepository, input: ExecuteSystemStepInput) => {
  const request = await repository.getRequest(scopeFromSubject(input.subject), input.subject.id);
  if (!request) throw new Error('leave_not_found');

  switch (input.ref) {
    case 'loadLeavePolicyFacts':
      return { output: { balanceDays: request.balance_days, requestedDays: request.business_days, eligible: request.balance_days >= request.business_days } };
    case 'reserveLeaveBalance':
      return { output: { reservationId: `leave-reservation:${input.subject.id}`, status: 'reserved', businessDays: request.business_days } };
    case 'createCalendarEntry':
      return { output: { calendarEntryId: `leave-calendar:${input.subject.id}`, status: 'created', startDate: request.start_date, endDate: request.end_date } };
    default:
      throw new Error(`unknown_leave_system_step:${input.ref}`);
  }
};

function logicalWorkflowId(subject: { metadata?: Record<string, unknown> }, workflowId: string): string {
  const scope = scopeFromSubject(subject);
  return tenantFlowId(scope.organizationId, workflowId);
}

/** Activity adapters are the only worker-side bridge to durable demo projections. */
export function createLeaveActivities(dependencies: LeaveActivityDependencies = {}): FlowkitActivityRegistry {
  const repository = dependencies.repository ?? new LeaveFlowRepository();
  const actorResolver = dependencies.actorResolver ?? { resolve: resolveDemoActor };

  const contexts = {
    async resolve(input: ResolveActionContextInput) {
      const scope = scopeFromSubject(input.subject);
      const workflowId = logicalWorkflowId(input.subject, input.workflowId);
      const priorResult = await repository.findPriorResult(scope, workflowId, input.operationId);
      if (priorResult) return { facts: {}, priorResult: { state: priorResult.state } };

      if (input.origin !== 'human') return { facts: {} };
      const actor = await actorResolver.resolve(input.command.actorId ?? '');
      const task = input.state.stage === 'manager_review'
        ? await repository.tasks.find(scope, {
          namespace: 'flowkit-demo', flowId: workflowId, subjectType: 'leave', subjectId: input.subject.id,
          stage: 'manager_review', role: 'manager',
        })
        : null;
      const managerTaskAssigneeId = task?.status === 'claimed' ? task.assigneeId : null;

      if (input.state.stage === 'manager_review' && managerTaskAssigneeId !== actor.id) {
        throw new Error('task_not_owned');
      }

      return { actor, facts: { managerTaskAssigneeId } };
    },
  };
  const flows = {
    recordTransition: (input: Parameters<FlowkitActivityRegistry['recordTransition']>[0]) => repository.recordTransition(
      scopeFromSubject(input.subject),
      { ...input, workflowId: logicalWorkflowId(input.subject, input.workflowId) },
    ),
    recordStageReady: (input: Parameters<FlowkitActivityRegistry['recordStageReady']>[0]) => repository.recordStageReady(
      scopeFromSubject(input.subject),
      { ...input, workflowId: logicalWorkflowId(input.subject, input.workflowId) },
    ),
  };
  const leaveSteps = { execute: (input: ExecuteSystemStepInput) => outputForSystemStep(repository, input) };
  const notifications = { dispatch: (input: Parameters<FlowkitActivityRegistry['dispatchNotification']>[0]) => repository.dispatchNotification(scopeFromSubject(input.subject), input) };

  return {
    resolveActionContext: (input) => contexts.resolve(input),
    recordTransition: (input) => flows.recordTransition(input),
    recordStageReady: (input) => flows.recordStageReady(input),
    executeSystemStep: (input) => leaveSteps.execute(input),
    executeAiStep: async () => ({ output: undefined }),
    dispatchNotification: (input) => notifications.dispatch(input),
  };
}

export const activities = createLeaveActivities();

export function validateWorkerRegistries() {
  const issues = validateRegistryRefs(leaveDefinition, {
    policies: leavePolicies,
    guards: leaveGuards,
    steps: { ...leaveSystemSteps, ...leaveRules },
    templates: leaveTemplates,
    channels: leaveChannels,
  });
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('\n'));
}
