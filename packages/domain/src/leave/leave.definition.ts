import { defineFlow, type FlowDefinition } from '@naakwu/flowkit-core';

export const leaveDefinition: FlowDefinition = defineFlow({
  id: 'leave-approval-demo', version: 1, roles: ['employee', 'manager'], initialStage: 'employee_draft', initialStatus: 'draft',
  stages: {
    employee_draft: { pendingRole: 'employee', actions: {
      submit: { to: 'policy_evaluation', kind: 'human', policy: 'employeeSubmit' },
      withdraw: { to: 'withdrawn', kind: 'human', policy: 'employeeSubmit' },
    } },
    policy_evaluation: { entry: [{ kind: 'system', ref: 'loadLeavePolicyFacts' }, { kind: 'rule', ref: 'routeLeaveRequest' }], actions: {
      reject_insufficient: { to: 'rejected', kind: 'system', notify: { template: 'leave.rejected', channels: ['inbox', 'email'] } },
      auto_approve: { to: 'fulfillment', kind: 'system' },
      require_manager: { to: 'manager_review', kind: 'system', notify: { template: 'leave.manager_review', channels: ['inbox', 'email'] } },
    } },
    manager_review: { pendingRole: 'manager', sla: { after: 'PT10S', escalate: { notify: 'manager' } }, actions: {
      approve: { to: 'fulfillment', kind: 'human', policy: 'managerReview', guards: ['managerTaskClaimed'] },
      reject: { to: 'rejected', kind: 'human', policy: 'managerReview', guards: ['managerTaskClaimed'], notify: { template: 'leave.rejected', channels: ['inbox', 'email'] } },
      return: { to: 'employee_draft', kind: 'human', policy: 'managerReview', guards: ['managerTaskClaimed'] },
    } },
    fulfillment: { entry: [{ kind: 'system', ref: 'reserveLeaveBalance' }, { kind: 'system', ref: 'createCalendarEntry' }, { kind: 'rule', ref: 'completeFulfillment' }], actions: {
      complete: { to: 'approved', kind: 'system', notify: { template: 'leave.accepted', channels: ['inbox', 'email'] } },
    } },
    approved: { final: true }, rejected: { final: true }, withdrawn: { final: true },
  },
});
