import { createFlowkitWorkflow } from '@naakwu/flowkit-temporal/workflow';
import {
  enrolmentGuards,
  enrolmentPolicies,
  enrolmentRules,
  leaveGuards,
  leavePolicies,
  leaveRules,
} from '@flowkit-demo/domain/workflow';

/**
 * The worker bundles this module into the deterministic workflow sandbox, which has no `process`.
 * It must therefore bind registries only — never read configuration. Activities inherit the
 * worker's task queue, so no queue name is needed here either.
 */
export const leaveWorkflow = createFlowkitWorkflow({
  registries: { policies: leavePolicies, guards: leaveGuards, rules: leaveRules },
});

export const enrolmentWorkflow = createFlowkitWorkflow({
  registries: { policies: enrolmentPolicies, guards: enrolmentGuards, rules: enrolmentRules },
});
