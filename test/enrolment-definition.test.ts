import { describe, expect, it } from 'bun:test';
import { buildInitialState, getDeclaredActions, lintFlow, lintInterpreterFlow, transition, validateRegistryRefs, type FlowState } from '@naakwu/flowkit-core';
import { publishDefinition, validateFlowkit, verifyPublishedDefinition } from '@naakwu/flowkit-temporal';
import { SUPERVISED_REGISTRATION_QUOTA, enrolmentChannels, enrolmentDefinition, enrolmentGuards, enrolmentPolicies, enrolmentRules, enrolmentSystemSteps, enrolmentTemplates } from '@flowkit-demo/domain';

/** Interpreter boot shape: rules are pure, system steps are declared I/O refs. */
const interpreterRegistries = { guards: enrolmentGuards, policies: enrolmentPolicies, rules: enrolmentRules, systemSteps: enrolmentSystemSteps, templates: enrolmentTemplates, channels: enrolmentChannels };

/** Kernel shape: `steps` covers both entry-step kinds, so rules go in alongside system steps. */
const coreRefs = { guards: enrolmentGuards, policies: enrolmentPolicies, steps: { ...enrolmentSystemSteps, ...enrolmentRules }, templates: enrolmentTemplates, channels: enrolmentChannels };

const worker = { id: 'worker-1', roles: ['worker'] };
const agent = { id: 'agent-3', roles: ['agent'] };
const reviewer = { id: 'reviewer-2', roles: ['reviewer'] };
const supervisor = { id: 'supervisor-5', roles: ['supervisor'] };
const otherSupervisor = { id: 'supervisor-9', roles: ['supervisor'] };
const service = { id: 'fraud-service', roles: ['service'] };
/** Phase 1 reality: one person staffs both consoles, so the role split alone separates nobody. */
const founder = { id: 'founder-1', roles: ['reviewer', 'supervisor'] };

const subject = { workerId: worker.id, agentId: agent.id };
const currentConsent = { consentVersionAccepted: 'notice-v3', currentConsentVersion: 'notice-v3' };
const claimedBy = (actor: { id: string }) => ({ reviewTaskAssigneeId: actor.id });

const step = (state: FlowState, action: string, context: Parameters<typeof transition>[3] = {}) =>
  transition(enrolmentDefinition, state, { action, actorId: context.actor?.id }, { subject, guards: enrolmentGuards, policies: enrolmentPolicies, ...context }).state;

/** Consent granted, captured by the assisting agent, sitting in the exception queue. */
const atExceptionReview = (actor = agent) => {
  let state = buildInitialState(enrolmentDefinition);
  state = step(state, 'grant_consent', { actor: worker });
  state = step(state, actor === agent ? 'submit_assisted_capture' : 'submit_self_capture', { actor, facts: currentConsent });
  return step(state, 'verification_exception');
};

/** A live profile reached through the self-serve path. */
const atActive = () => {
  let state = buildInitialState(enrolmentDefinition);
  state = step(state, 'grant_consent', { actor: worker });
  state = step(state, 'submit_self_capture', { actor: worker, facts: currentConsent });
  state = step(state, 'verification_passed');
  return step(state, 'activate_profile');
};

describe('worker enrolment definition', () => {
  it('is strict, lint-clean, and has a stable immutable snapshot', () => {
    expect(lintFlow(enrolmentDefinition)).toEqual([]);
    expect(lintInterpreterFlow(enrolmentDefinition)).toEqual([]);
    expect(validateRegistryRefs(enrolmentDefinition, coreRefs)).toEqual([]);
    const published = publishDefinition({ definition: enrolmentDefinition });
    verifyPublishedDefinition(published);
    expect(Object.isFrozen(published.definitionSnapshot)).toBe(true);
  });

  it('passes interpreter boot validation', () => {
    expect(validateFlowkit({ published: publishDefinition({ definition: enrolmentDefinition }), registries: interpreterRegistries })).toEqual([]);
  });

  it('starts as an unverified worker who has consented to nothing', () => {
    expect(buildInitialState(enrolmentDefinition)).toEqual({ stage: 'consent_capture', status: 'draft', pendingRole: 'worker', tracks: { identity: 'unverified', consent: 'pending', commission: 'none' } });
  });

  it('clears an agent commission on the supervised assisted path', () => {
    let state = buildInitialState(enrolmentDefinition);
    state = step(state, 'grant_consent', { actor: worker });
    state = step(state, 'submit_assisted_capture', { actor: agent, facts: currentConsent });
    expect(state.tracks.commission).toBe('held');

    state = step(state, 'verification_passed');
    state = step(state, 'require_supervised_review');
    state = step(state, 'approve_supervised_registration', { actor: supervisor, facts: claimedBy(supervisor) });

    expect(state).toEqual({ stage: 'active', status: 'active', pendingRole: null, tracks: { identity: 'verified', consent: 'granted', commission: 'cleared' } });
  });

  it('carries a self-serve exception through resubmission back to active', () => {
    let state = atExceptionReview(worker);
    expect(state.tracks.identity).toBe('provisional');

    state = step(state, 'request_resubmission', { actor: reviewer, facts: claimedBy(reviewer) });
    state = step(state, 'submit_correction', { actor: worker, facts: currentConsent });
    state = step(state, 'verification_passed');
    state = step(state, 'activate_profile');

    expect(state.stage).toBe('active');
    expect(state.tracks.identity).toBe('verified');
  });

  it('requires a second actor to confirm a rejection', () => {
    const proposed = step(atExceptionReview(), 'propose_rejection', { actor: reviewer, facts: claimedBy(reviewer) });
    const rejected = step(proposed, 'confirm_rejection', { actor: supervisor, facts: { rejectionProposedBy: reviewer.id } });

    expect(rejected).toEqual({ stage: 'rejected', status: 'closed', pendingRole: null, tracks: { identity: 'revoked', consent: 'granted', commission: 'reversed' } });
  });

  // The role split does not separate anybody when one principal holds both roles, which is the
  // expected Phase 1 staffing. Only `independentRejectionChecker` refuses. Pinned so a future
  // simplification that drops the guard as "redundant with the policies" fails here.
  it('refuses a dual-role principal who confirms their own rejection proposal', () => {
    const proposed = step(atExceptionReview(), 'propose_rejection', { actor: founder, facts: claimedBy(founder) });

    expect(() => step(proposed, 'confirm_rejection', { actor: founder, facts: { rejectionProposedBy: founder.id } })).toThrow(/independentRejectionChecker/);
    expect(step(proposed, 'confirm_rejection', { actor: otherSupervisor, facts: { rejectionProposedBy: founder.id } }).stage).toBe('rejected');
  });

  it('requires a third actor to adjudicate an appeal', () => {
    let state = step(atActive(), 'flag_for_fraud_review', { actor: service });
    state = step(state, 'propose_suspension', { actor: reviewer, facts: claimedBy(reviewer) });
    state = step(state, 'confirm_suspension', { actor: supervisor, facts: { suspensionProposedBy: reviewer.id } });
    expect(state.tracks.identity).toBe('disputed');

    state = step(state, 'file_appeal', { actor: worker });
    const chain = { suspensionProposedBy: reviewer.id, suspensionConfirmedBy: supervisor.id };

    expect(() => step(state, 'allow_appeal', { actor: supervisor, facts: chain })).toThrow(/independentAppealAdjudicator/);
    expect(step(state, 'allow_appeal', { actor: otherSupervisor, facts: chain })).toEqual({ stage: 'active', status: 'active', pendingRole: null, tracks: { identity: 'verified', consent: 'granted', commission: 'cleared' } });
  });

  it('reinstates a worker whose appeal nobody adjudicated', () => {
    let state = step(atActive(), 'flag_for_fraud_review', { actor: service });
    state = step(state, 'propose_suspension', { actor: reviewer, facts: claimedBy(reviewer) });
    state = step(state, 'confirm_suspension', { actor: supervisor, facts: { suspensionProposedBy: reviewer.id } });
    state = step(state, 'file_appeal', { actor: worker });

    expect(step(state, 'appeal_timeout_reinstate').tracks.identity).toBe('verified');
  });

  // §6.4: an operator's unstaffed queue must never resolve against the worker. The only SLA that
  // reaches a terminal is `expire_appeal_window`, which resolves the worker's own silence.
  it('never escalates an operator delay into a terminal decision', () => {
    const terminals = Object.entries(enrolmentDefinition.stages)
      .filter(([, stage]) => stage.sla)
      .map(([name, stage]) => [name, stage.actions?.[stage.sla!.escalate.action!]?.to] as const)
      .filter(([, to]) => to === 'rejected' || to === 'suspended');

    expect(terminals).toEqual([['appeal_window', 'suspended']]);
  });

  it('refuses capture against a stale consent notice', () => {
    const consented = step(buildInitialState(enrolmentDefinition), 'grant_consent', { actor: worker });

    expect(() => step(consented, 'submit_self_capture', { actor: worker, facts: { consentVersionAccepted: 'notice-v2', currentConsentVersion: 'notice-v3' } })).toThrow(/consentCurrent/);
    expect(() => step(consented, 'submit_self_capture', { actor: worker, facts: {} })).toThrow(/consentCurrent/);
  });

  it('routes a consent withdrawal to erasure rather than to a flag', () => {
    const withdrawn = step(atActive(), 'withdraw_consent', { actor: worker });
    expect(withdrawn.stage).toBe('erasure_pending');
    expect(withdrawn.tracks.consent).toBe('withdrawn');

    expect(step(withdrawn, 'complete_erasure').stage).toBe('erased');
    expect(step(withdrawn, 'retain_under_legal_hold').tracks.identity).toBe('revoked');
  });

  // `active` is a resting position, not a queue item. KF-5: nothing in the definition distinguishes
  // this deliberate absence of an SLA from an accidental one, so it is asserted here instead.
  it('rests in active with no holder and no clock', () => {
    const active = enrolmentDefinition.stages.active!;
    expect(active.pendingRole ?? null).toBeNull();
    expect(active.sla).toBeUndefined();
    expect(active.final ?? false).toBe(false);
    expect(active.steady).toBe(true);

    const inbound = Object.values(enrolmentDefinition.stages)
      .flatMap((stage) => Object.values(stage.actions ?? {}))
      .filter((action) => action.to === 'active');
    expect(inbound).toHaveLength(8);
  });

  it('models withdrawal once as a cross-cutting action', () => {
    expect(enrolmentDefinition.actions?.withdraw_consent).toEqual(
      expect.objectContaining({ to: 'erasure_pending', policy: 'workerOwnsProfile' }),
    );
    expect(getDeclaredActions(enrolmentDefinition, 'appeal_window')).toContain('withdraw_consent');
    expect(getDeclaredActions(enrolmentDefinition, 'consent_capture')).not.toContain('withdraw_consent');
  });

  it('requires policies for externally issued fraud and re-verification signals', () => {
    expect(enrolmentDefinition.stages.active?.actions?.flag_for_fraud_review).toEqual(
      expect.objectContaining({ kind: 'signal', policy: 'trustedAutomation' }),
    );
    expect(enrolmentDefinition.stages.active?.actions?.open_reverification).toEqual(
      expect.objectContaining({ kind: 'signal', policy: 'trustedAutomation' }),
    );
  });

  it('notifies profile activation on every entry into active', () => {
    expect(enrolmentDefinition.stages.active?.entryNotify).toEqual([
      { template: 'konfam.profile_active', channels: ['sms', 'inbox'] },
    ]);
    const inboundWithDuplicateProfileNotification = Object.values(enrolmentDefinition.stages)
      .flatMap((stage) => Object.values(stage.actions ?? {}))
      .filter((action) => action.to === 'active')
      .filter((action) => {
        const notifications = action.notify === undefined ? [] : Array.isArray(action.notify) ? action.notify : [action.notify];
        return notifications.some((notification) => notification.template === 'konfam.profile_active');
      });
    expect(inboundWithDuplicateProfileNotification).toHaveLength(0);
  });

  it('separates an ambiguous identity result from a hard failure', () => {
    const route = (facts: Record<string, unknown>) =>
      enrolmentRules.routeVerification.run({ definition: enrolmentDefinition, state: buildInitialState(enrolmentDefinition), subject, facts });

    expect(route({ ninMatched: true, livenessScore: 0.97 })).toBe('verification_passed');
    expect(route({ ninMatched: true, livenessScore: 0.42 })).toBe('verification_exception');
    expect(route({ ninMatched: false })).toBe('verification_exception');
    expect(route({ duplicateBiometricFound: true, ninMatched: true, livenessScore: 0.99 })).toBe('verification_failed');
  });

  it('supervises an agent only until their quota clears', () => {
    const route = (facts: Record<string, unknown>) =>
      enrolmentRules.routeSupervision.run({ definition: enrolmentDefinition, state: buildInitialState(enrolmentDefinition), subject, facts });

    expect(route({ agentId: agent.id, agentClearedRegistrations: 0 })).toBe('require_supervised_review');
    expect(route({ agentId: agent.id, agentClearedRegistrations: SUPERVISED_REGISTRATION_QUOTA })).toBe('activate_profile');
    expect(route({ agentId: null })).toBe('activate_profile');
  });

  it('does not treat subject metadata as completed entry-step facts', () => {
    const state = buildInitialState(enrolmentDefinition);
    const noFacts = (rule: keyof typeof enrolmentRules, seeded: Record<string, unknown>) =>
      enrolmentRules[rule].run({ definition: enrolmentDefinition, state, subject: { ...subject, ...seeded }, facts: {} });

    expect(noFacts('routeVerification', { ninMatched: true, livenessScore: 0.99 })).toBe('verification_exception');
    expect(noFacts('routeVerification', {})).toBe('verification_exception');
    expect(noFacts('routeSupervision', { agentId: 'agent-1', agentClearedRegistrations: 0 })).toBe('activate_profile');
    expect(noFacts('routeErasure', { legalHoldActive: true })).toBe('complete_erasure');
    expect(noFacts('routeErasure', {})).toBe('complete_erasure');
  });
});
