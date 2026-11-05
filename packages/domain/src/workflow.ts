/**
 * Workflow-bundle entry point. Keep this module limited to deterministic registries so importing
 * the Temporal workflow cannot pull configuration, persistence, or provider adapters into the
 * sandbox.
 */
export {
  enrolmentGuards,
  enrolmentPolicies,
  enrolmentRules,
} from './enrolment/enrolment.registries';
export {
  leaveGuards,
  leavePolicies,
  leaveRules,
} from './leave/leave.registries';
