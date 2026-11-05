import type { PredicateContext } from '@naakwu/flowkit-core';
import type { FlowkitPureRegistries, RuleContext } from '@naakwu/flowkit-temporal';

/** Registrations an agent completes under supervision before operating independently. */
export const SUPERVISED_REGISTRATION_QUOTA = 5;

/** Confidence below which an identity match is an exception rather than a pass. */
export const IDENTITY_MATCH_THRESHOLD = 0.9;

export const enrolmentGuards = {
  /** A reviewer may only act on a task they hold, so two reviewers cannot decide in parallel. */
  reviewTaskClaimed: ({ actor, facts }: PredicateContext) =>
    facts.reviewTaskAssigneeId === actor?.id,

  /**
   * Consent is a precondition for processing, not a completed step. A worker who granted consent
   * against an older notice must re-consent before any further capture is accepted.
   */
  consentCurrent: ({ facts }: PredicateContext) =>
    facts.consentVersionAccepted != null &&
    facts.consentVersionAccepted === facts.currentConsentVersion,

  /**
   * Four eyes on a rejection. The kernel does not know who acted previously, so the proposer's id
   * is supplied as a fact by `resolveActionContext` and compared here. In the runtime consumer this
   * fact is produced by `evaluateMakerChecker` from `@naakwu/flowkit-tasks` rather than by a bespoke
   * query — see `docs/worker-enrolment-spec.md` §8, KF-2.
   */
  independentRejectionChecker: ({ actor, facts }: PredicateContext) =>
    facts.rejectionProposedBy != null && facts.rejectionProposedBy !== actor?.id,

  independentSuspensionChecker: ({ actor, facts }: PredicateContext) =>
    facts.suspensionProposedBy != null && facts.suspensionProposedBy !== actor?.id,

  /**
   * Three eyes, not two. An appeal is only independent if the adjudicator neither proposed the
   * suspension nor confirmed it. `MakerCheckerRule` models a two-party chain, so this third link is
   * expressed here rather than delegated.
   */
  independentAppealAdjudicator: ({ actor, facts }: PredicateContext) =>
    facts.suspensionProposedBy !== actor?.id &&
    facts.suspensionConfirmedBy != null &&
    facts.suspensionConfirmedBy !== actor?.id,
};

export const enrolmentPolicies = {
  workerOwnsProfile: ({ actor, subject }: PredicateContext) =>
    actor?.roles.includes('worker') === true && actor.id === subject.workerId,

  /** Scoped to the agent who captured this registration, not to agents in general. */
  assistingAgent: ({ actor, subject }: PredicateContext) =>
    actor?.roles.includes('agent') === true && actor.id === subject.agentId,

  verificationReviewer: ({ actor }: PredicateContext) =>
    actor?.roles.includes('reviewer') === true,
  verificationSupervisor: ({ actor }: PredicateContext) =>
    actor?.roles.includes('supervisor') === true,

  /**
   * Trust & Safety is a different console and, per Admin & Back-Office Spec §1 and §2, a different
   * staffing pool from Verification Operations. The bodies match today because both consoles are
   * one founder at Phase 1 volume; the names are kept apart so splitting the pools is a policy
   * change rather than a graph change.
   */
  trustSafetyReviewer: ({ actor }: PredicateContext) =>
    actor?.roles.includes('reviewer') === true,
  trustSafetyAdjudicator: ({ actor }: PredicateContext) =>
    actor?.roles.includes('supervisor') === true,
  trustedAutomation: ({ actor }: PredicateContext) =>
    actor?.roles.includes('service') === true,
};

/**
 * Reads values produced by the entry steps immediately before this rule runs. The temporal
 * interpreter accumulates each system-step output into `facts`, keeping routing deterministic
 * while allowing a re-entered stage to make a fresh decision from its current evidence.
 */
const routingInput = ({ facts }: RuleContext, key: string): unknown => facts[key];

export const enrolmentRules = {
  /**
   * The only three-way rule in the repository. A hard failure and an ambiguous result are
   * different outcomes with different due-process consequences, so they are separate edges rather
   * than one `failed` edge with a reason code.
   */
  routeVerification: {
    actions: ['verification_passed', 'verification_exception', 'verification_failed'],
    run: (ctx: RuleContext) => {
      if (routingInput(ctx, 'duplicateBiometricFound') === true) return 'verification_failed';
      if (routingInput(ctx, 'ninMatched') !== true) return 'verification_exception';
      return Number(routingInput(ctx, 'livenessScore') ?? 0) >= IDENTITY_MATCH_THRESHOLD
        ? 'verification_passed'
        : 'verification_exception';
    },
  },

  /** Self-serve registrations carry no agent, so they never enter supervised review. */
  routeSupervision: {
    actions: ['require_supervised_review', 'activate_profile'],
    run: (ctx: RuleContext) => {
      const agentId = routingInput(ctx, 'agentId');
      if (!agentId) return 'activate_profile';
      return Number(routingInput(ctx, 'agentClearedRegistrations') ?? 0) < SUPERVISED_REGISTRATION_QUOTA
        ? 'require_supervised_review'
        : 'activate_profile';
    },
  },

  /** A legal hold outranks a withdrawal request; erasure is what happens when none applies. */
  routeErasure: {
    actions: ['complete_erasure', 'retain_under_legal_hold'],
    run: (ctx: RuleContext) =>
      routingInput(ctx, 'legalHoldActive') === true ? 'retain_under_legal_hold' : 'complete_erasure',
  },
} satisfies NonNullable<FlowkitPureRegistries['rules']>;

export const enrolmentSystemSteps = {
  verifyNin: true,
  matchLiveness: true,
  screenDuplicateBiometric: true,
  sealVerificationEvidence: true,
  scoreAgentQuality: true,
  revokeConsentTokens: true,
  assessLegalHold: true,
  scheduleErasure: true,
};

export const enrolmentTemplates = Object.fromEntries(
  [
    'konfam.consent_receipt',
    'konfam.verification_pending',
    'konfam.resubmission_requested',
    'konfam.profile_active',
    'konfam.enrolment_rejected',
    'konfam.commission_reversed',
    'konfam.integrity_flag_raised',
    'konfam.suspension_confirmed',
    'konfam.appeal_allowed',
    'konfam.appeal_denied',
    'konfam.erasure_completed',
  ].map((key) => [key, true]),
);

/** `sms` and `whatsapp` have no delivery adapter in this repository — deliberately, per §7.3. */
export const enrolmentChannels = { inbox: true, sms: true, whatsapp: true };
