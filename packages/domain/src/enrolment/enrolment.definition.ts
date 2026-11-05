import { defineFlow, type FlowDefinition } from '@naakwu/flowkit-core';

/**
 * Worker enrolment and standing, modelled as one durable flow per worker profile.
 *
 * Three things separate this from `ride.definition.ts` and `leave.definition.ts`.
 *
 * First, `active` is a non-final stage the flow is *supposed* to rest in. Leave and ride both race
 * to a terminal; a worker profile lives for years and is pulled back into review by an asynchronous
 * fraud signal or a scheduled re-verification. The graph therefore has a steady state with no SLA,
 * which is deliberate and is the one place the "every non-final stage must have a clock" rule is
 * intentionally broken — see `docs/worker-enrolment-spec.md` §6.4.
 *
 * Second, every adverse decision is a two-actor chain and the appeal is a three-actor chain: a
 * reviewer proposes, a supervisor confirms, and — only on appeal — a third actor who confirmed
 * nothing adjudicates. The `independent*` guards carry that separation, because the kernel has no
 * notion of who acted previously (§8, KF-2).
 *
 * Third, consent is a precondition rather than a step. `consentCurrent` gates capture, and
 * withdrawal routes to erasure from wherever the worker happens to be, which is why the same
 * intent appears under three action names (§8, KF-3).
 */
export const enrolmentDefinition: FlowDefinition = defineFlow({
  id: 'worker-enrolment-demo', version: 1, roles: ['worker', 'agent', 'reviewer', 'supervisor'],
  initialStage: 'consent_capture', initialStatus: 'draft',
  actions: {
    withdraw_consent: { to: 'erasure_pending', kind: 'human', policy: 'workerOwnsProfile', status: 'closed', tracks: { consent: 'withdrawn' } },
  },
  tracks: {
    identity: { initial: 'unverified', values: ['unverified', 'provisional', 'verified', 'disputed', 'revoked'] },
    consent: { initial: 'pending', values: ['pending', 'granted', 'withdrawn'] },
    commission: { initial: 'none', values: ['none', 'held', 'cleared', 'reversed'] },
  },
  stages: {
    // Nothing is captured before a lawful basis exists. NDPA 2023 makes this the first stage,
    // not a checkbox inside a later one.
    consent_capture: { pendingRole: 'worker', steady: true, disabledGlobalActions: ['withdraw_consent'], actions: {
      grant_consent: { to: 'identity_capture', kind: 'human', policy: 'workerOwnsProfile', status: 'pending', tracks: { consent: 'granted' }, notify: { template: 'konfam.consent_receipt', channels: ['sms', 'inbox'] } },
      decline_consent: { to: 'consent_declined', kind: 'human', policy: 'workerOwnsProfile', status: 'closed' },
    } },

    // Two entry channels converge here. The agent path holds a commission the moment it is used;
    // the self-serve path never touches the commission track.
    identity_capture: { pendingRole: 'worker', sla: { after: '72h', escalate: { action: 'abandon_capture' } }, actions: {
      submit_assisted_capture: { to: 'identity_verification', kind: 'human', policy: 'assistingAgent', guards: ['consentCurrent'], tracks: { commission: 'held' } },
      submit_self_capture: { to: 'identity_verification', kind: 'human', policy: 'workerOwnsProfile', guards: ['consentCurrent'] },
      abandon_capture: { to: 'erasure_pending', kind: 'system', tracks: { consent: 'withdrawn' } },
    } },

    // Re-entered by `submit_correction` and by `open_reverification`, so entry work must be
    // idempotent per entry epoch rather than per workflow.
    identity_verification: { entry: [
      { kind: 'system', ref: 'verifyNin' },
      { kind: 'system', ref: 'matchLiveness' },
      { kind: 'system', ref: 'screenDuplicateBiometric' },
      { kind: 'system', ref: 'sealVerificationEvidence' },
      { kind: 'rule', ref: 'routeVerification' },
    ], actions: {
      verification_passed: { to: 'supervision_gate', kind: 'system', status: 'in_review', tracks: { identity: 'verified' } },
      verification_exception: { to: 'exception_review', kind: 'system', status: 'in_review', tracks: { identity: 'provisional' }, notify: { template: 'konfam.verification_pending', channels: ['sms', 'inbox'] } },
      verification_failed: { to: 'rejection_review', kind: 'system', status: 'in_review', tracks: { identity: 'disputed' } },
    } },

    // Admin & Back-Office Spec §2. A worker sits here waiting on a person, which is the only
    // place in the flow where Konfam owes a stated turnaround to someone with no other recourse.
    exception_review: { pendingRole: 'reviewer', sla: { after: '24h', escalate: { action: 'flag_stale_exception' } }, actions: {
      clear_exception: { to: 'supervision_gate', kind: 'human', policy: 'verificationReviewer', guards: ['reviewTaskClaimed'], tracks: { identity: 'verified' } },
      request_resubmission: { to: 'resubmission_wait', kind: 'human', policy: 'verificationReviewer', guards: ['reviewTaskClaimed'], notify: { template: 'konfam.resubmission_requested', channels: ['sms', 'whatsapp', 'inbox'] } },
      propose_rejection: { to: 'rejection_review', kind: 'human', policy: 'verificationReviewer', guards: ['reviewTaskClaimed'] },
      flag_stale_exception: { to: 'supervisor_backstop', kind: 'system' },
    } },

    // An unstaffed queue must not become a silent rejection. If the backstop also lapses the
    // worker is cleared, not dropped — the failure mode favours the person waiting.
    supervisor_backstop: { pendingRole: 'supervisor', sla: { after: '48h', escalate: { action: 'backstop_auto_clear' } }, actions: {
      backstop_manual_clear: { to: 'supervision_gate', kind: 'human', policy: 'verificationSupervisor', guards: ['reviewTaskClaimed'], tracks: { identity: 'verified' } },
      backstop_propose_rejection: { to: 'rejection_review', kind: 'human', policy: 'verificationSupervisor', guards: ['reviewTaskClaimed'] },
      backstop_auto_clear: { to: 'supervision_gate', kind: 'system', tracks: { identity: 'verified' } },
    } },

    resubmission_wait: { pendingRole: 'worker', sla: { after: '72h', escalate: { action: 'expire_resubmission' } }, actions: {
      submit_correction: { to: 'identity_verification', kind: 'human', policy: 'workerOwnsProfile', guards: ['consentCurrent'] },
      expire_resubmission: { to: 'lapsed', kind: 'system', status: 'closed', tracks: { commission: 'reversed' } },
    } },

    // Four eyes. The checker is a different actor from the proposer, enforced by a guard rather
    // than by the graph, and an unreviewed proposal is returned for rework rather than upheld.
    rejection_review: { pendingRole: 'supervisor', sla: { after: '48h', escalate: { action: 'return_rejection_for_rework' } }, actions: {
      confirm_rejection: { to: 'rejected', kind: 'human', policy: 'verificationSupervisor', guards: ['independentRejectionChecker'], status: 'closed', tracks: { identity: 'revoked', commission: 'reversed' }, notify: { template: 'konfam.enrolment_rejected', channels: ['sms', 'whatsapp', 'inbox'] } },
      overturn_rejection: { to: 'supervision_gate', kind: 'human', policy: 'verificationSupervisor', guards: ['independentRejectionChecker'], tracks: { identity: 'verified' } },
      return_rejection_for_rework: { to: 'exception_review', kind: 'system' },
    } },

    // Onboarding Workflows §3 step 5: an agent's first registrations are reviewed before the
    // agent operates unsupervised. `scoreAgentQuality` returns not-applicable for self-serve.
    supervision_gate: { entry: [
      { kind: 'system', ref: 'scoreAgentQuality' },
      { kind: 'rule', ref: 'routeSupervision' },
    ], actions: {
      require_supervised_review: { to: 'supervised_review', kind: 'system' },
      activate_profile: { to: 'active', kind: 'system', status: 'active', tracks: { commission: 'cleared' } },
    } },

    supervised_review: { pendingRole: 'supervisor', sla: { after: '24h', escalate: { action: 'supervision_timeout_release' } }, actions: {
      approve_supervised_registration: { to: 'active', kind: 'human', policy: 'verificationSupervisor', guards: ['reviewTaskClaimed'], status: 'active', tracks: { commission: 'cleared' } },
      flag_agent_registration: { to: 'exception_review', kind: 'human', policy: 'verificationSupervisor', guards: ['reviewTaskClaimed'], tracks: { identity: 'provisional', commission: 'reversed' }, notify: { template: 'konfam.commission_reversed', channels: ['sms', 'inbox'], to: ['agent'] } },
      supervision_timeout_release: { to: 'active', kind: 'system', status: 'active', tracks: { commission: 'cleared' } },
    } },

    // Steady state. No SLA and no pending role: a live profile is the resting position, not a
    // queue item. Both system exits are driven by external signals, never by a timer here.
    active: { steady: true, entryNotify: [{ template: 'konfam.profile_active', channels: ['sms', 'inbox'] }], actions: {
      flag_for_fraud_review: { to: 'integrity_review', kind: 'signal', policy: 'trustedAutomation', status: 'in_review', notify: { template: 'konfam.integrity_flag_raised', channels: ['inbox'], to: ['supervisor'] } },
      open_reverification: { to: 'identity_verification', kind: 'signal', policy: 'trustedAutomation', status: 'in_review' },
    } },

    // Admin & Back-Office Spec §1. Distinct staffing from the verification queues above, which
    // is why the policies are named separately even where the bodies match today.
    integrity_review: { pendingRole: 'reviewer', sla: { after: '72h', escalate: { action: 'close_integrity_review' } }, actions: {
      uphold_profile: { to: 'active', kind: 'human', policy: 'trustSafetyReviewer', guards: ['reviewTaskClaimed'], status: 'active' },
      propose_suspension: { to: 'suspension_review', kind: 'human', policy: 'trustSafetyReviewer', guards: ['reviewTaskClaimed'] },
      close_integrity_review: { to: 'active', kind: 'system', status: 'active' },
    } },

    suspension_review: { pendingRole: 'supervisor', sla: { after: '48h', escalate: { action: 'return_suspension_for_rework' } }, actions: {
      confirm_suspension: { to: 'appeal_window', kind: 'human', policy: 'trustSafetyAdjudicator', guards: ['independentSuspensionChecker'], tracks: { identity: 'disputed' }, notify: { template: 'konfam.suspension_confirmed', channels: ['sms', 'whatsapp', 'inbox'] } },
      dismiss_suspension: { to: 'active', kind: 'human', policy: 'trustSafetyAdjudicator', guards: ['independentSuspensionChecker'], status: 'active' },
      return_suspension_for_rework: { to: 'integrity_review', kind: 'system' },
    } },

    // Due process. The window is long because a low-bandwidth worker may not see an SMS for days.
    appeal_window: { pendingRole: 'worker', sla: { after: '14d', escalate: { action: 'expire_appeal_window' } }, actions: {
      file_appeal: { to: 'appeal_review', kind: 'human', policy: 'workerOwnsProfile' },
      accept_suspension: { to: 'suspended', kind: 'human', policy: 'workerOwnsProfile', status: 'closed', tracks: { identity: 'revoked' } },
      expire_appeal_window: { to: 'suspended', kind: 'system', status: 'closed', tracks: { identity: 'revoked' } },
    } },

    // An appeal nobody adjudicated reinstates the worker. The operator carries the cost of its
    // own unstaffed queue, not the person whose livelihood is suspended.
    appeal_review: { pendingRole: 'supervisor', sla: { after: '10d', escalate: { action: 'appeal_timeout_reinstate' } }, actions: {
      allow_appeal: { to: 'active', kind: 'human', policy: 'trustSafetyAdjudicator', guards: ['independentAppealAdjudicator'], status: 'active', tracks: { identity: 'verified' }, notify: { template: 'konfam.appeal_allowed', channels: ['sms', 'inbox'] } },
      deny_appeal: { to: 'suspended', kind: 'human', policy: 'trustSafetyAdjudicator', guards: ['independentAppealAdjudicator'], status: 'closed', tracks: { identity: 'revoked' }, notify: { template: 'konfam.appeal_denied', channels: ['sms', 'whatsapp', 'inbox'] } },
      appeal_timeout_reinstate: { to: 'active', kind: 'system', status: 'active', tracks: { identity: 'verified' } },
    } },

    // Erasure is a decision, not a delete. A legal hold outranks a withdrawal request, and the
    // rule says which one applies.
    erasure_pending: { disabledGlobalActions: ['withdraw_consent'], entry: [
      { kind: 'system', ref: 'revokeConsentTokens' },
      { kind: 'system', ref: 'assessLegalHold' },
      { kind: 'system', ref: 'scheduleErasure' },
      { kind: 'rule', ref: 'routeErasure' },
    ], actions: {
      complete_erasure: { to: 'erased', kind: 'system', status: 'closed', tracks: { identity: 'revoked' }, notify: { template: 'konfam.erasure_completed', channels: ['sms', 'inbox'] } },
      retain_under_legal_hold: { to: 'retained', kind: 'system', status: 'closed', tracks: { identity: 'revoked' } },
    } },

    consent_declined: { final: true },
    lapsed: { final: true },
    rejected: { final: true },
    suspended: { final: true },
    erased: { final: true },
    retained: { final: true },
  },
});
