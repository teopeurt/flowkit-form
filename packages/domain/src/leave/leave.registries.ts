import type { PredicateContext } from '@naakwu/flowkit-core';
import type { FlowkitPureRegistries, RuleContext } from '@naakwu/flowkit-temporal';

export const leaveGuards = {
  managerTaskClaimed: ({ actor, facts }: PredicateContext) =>
    facts.managerTaskAssigneeId === actor?.id,
};

export const leavePolicies = {
  employeeSubmit: ({ actor, subject }: PredicateContext) =>
    actor?.roles.includes('employee') === true && actor.id === subject.employeeId,
  managerReview: ({ actor, subject }: PredicateContext) =>
    actor?.roles.includes('manager') === true && actor.id === subject.managerId,
};

export const leaveRules = {
  routeLeaveRequest: {
    actions: ['auto_approve', 'require_manager'],
    run: ({ subject }: RuleContext) => Number(subject.businessDays) <= 1 ? 'auto_approve' : 'require_manager',
  },
  completeFulfillment: {
    actions: ['complete'],
    run: () => 'complete',
  },
} satisfies NonNullable<FlowkitPureRegistries['rules']>;

export const leaveSystemSteps = {
  loadLeavePolicyFacts: true,
  reserveLeaveBalance: true,
  createCalendarEntry: true,
};

export const leaveTemplates = Object.fromEntries(
  ['leave.accepted', 'leave.rejected', 'leave.manager_review', 'leave.overdue'].map((key) => [key, true]),
);

export const leaveChannels = { inbox: true, email: true };
