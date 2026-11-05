import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FlowkitActivityRegistry, RecordTransitionInput, ResolveActionContextInput } from '@naakwu/flowkit-temporal';
import { publishDefinition } from '@naakwu/flowkit-temporal';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { enrolmentDefinition } from '@flowkit-demo/domain';

const publishedEnrolmentDefinition = publishDefinition({ definition: enrolmentDefinition });

const taskQueue = 'worker-enrolment-conformance';
let environment: TestWorkflowEnvironment;
let worker: Worker;
let workerRun: Promise<void>;
const transitions: RecordTransitionInput[] = [];
const stepKeys: string[] = [];

const actorFor = (input: ResolveActionContextInput) => {
  if (input.origin === 'signal') {
    if (input.operationId === 'trusted-signal' || input.operationId === 'reverify-entry') {
      return { id: 'fraud-service', roles: ['service'], organizationId: 'org-1' };
    }
    if (input.operationId === 'cross-org-signal') {
      return { id: 'fraud-service', roles: ['service'], organizationId: 'org-2' };
    }
    return undefined;
  }
  const id = input.command.actorId ?? 'system';
  const roles = id.includes('service') ? ['service']
    : id.startsWith('worker') ? ['worker']
      : id.startsWith('reviewer') ? ['reviewer']
        : id.startsWith('supervisor') ? ['supervisor']
          : id.startsWith('founder') ? ['reviewer', 'supervisor']
            : [];
  return { id, roles, organizationId: id.startsWith('other-') ? 'org-2' : 'org-1' };
};

const activities: FlowkitActivityRegistry = {
  async resolveActionContext(input) {
    const facts: Record<string, unknown> = input.command.action.includes('capture')
      ? { consentVersionAccepted: 'notice-v3', currentConsentVersion: 'notice-v3' }
      : {};
    if (input.operationId === 'founder-propose') facts.reviewTaskAssigneeId = 'founder-1';
    if (input.operationId === 'founder-confirm') {
      facts.reviewTaskAssigneeId = 'founder-1';
      facts.suspensionProposedBy = 'founder-1';
    }
    if (input.operationId === 'supervisor-confirm') {
      facts.reviewTaskAssigneeId = 'supervisor-2';
      facts.suspensionProposedBy = 'founder-1';
    }
    return {
      actor: actorFor(input),
      facts,
    };
  },
  async recordTransition(input) {
    transitions.push(input);
    return { state: input.nextState };
  },
  async recordStageReady() {},
  async executeSystemStep(input) {
    stepKeys.push(JSON.stringify({
      ref: input.ref,
      workflowId: input.workflowId,
      entryEpoch: input.entryEpoch,
      stepIndex: input.stepIndex,
      idempotencyKey: input.idempotencyKey,
    }));
    const output: Record<string, unknown> = {
      verifyNin: { ninMatched: input.subject.metadata?.ninMatched ?? true },
      matchLiveness: { livenessScore: input.subject.metadata?.livenessScore ?? 0.99 },
      screenDuplicateBiometric: { duplicateBiometricFound: input.subject.metadata?.duplicateBiometricFound ?? false },
      sealVerificationEvidence: { evidenceBundleHash: 'a'.repeat(64) },
      scoreAgentQuality: { agentId: null, agentClearedRegistrations: 0 },
      revokeConsentTokens: { tokensRevoked: true },
      assessLegalHold: { legalHoldActive: input.subject.metadata?.legalHoldActive === true },
      scheduleErasure: { erasureScheduledAt: '2026-09-02T00:00:00.000Z' },
    }[input.ref] ?? {};
    return { output };
  },
  async executeAiStep() { return {}; },
  async dispatchNotification() {},
};

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal();
  worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: new URL('../apps/worker/src/workflows.ts', import.meta.url).pathname,
    activities,
  });
  workerRun = worker.run();
}, 30_000);

afterAll(async () => {
  if (!worker) return;
  await worker.shutdown();
  await workerRun;
  await environment.teardown();
});

describe('worker enrolment FlowKit conformance', () => {
  it('routes on entry outputs, records stable step keys, notifies every active entry, and supports global withdrawal', async () => {
    transitions.length = 0;
    stepKeys.length = 0;
    const handle = await environment.client.workflow.start('enrolmentWorkflow', {
      taskQueue,
      workflowId: 'org-1:enrolment-1',
      args: [{
        published: publishedEnrolmentDefinition,
        subject: { id: 'enrolment-1', organizationId: 'org-1', metadata: { workerId: 'worker-1', agentId: null } },
      }],
    });

    await handle.executeUpdate('applyAction', { updateId: 'consent', args: [{ action: 'grant_consent', actorId: 'worker-1' }] });
    const active = await handle.executeUpdate('applyAction', { updateId: 'capture', args: [{ action: 'submit_self_capture', actorId: 'worker-1' }] }) as { state: { stage: string; status: string; pendingRole: string | null } };
    expect(active.state.stage).toBe('active');
    expect(active.state).toMatchObject({ stage: 'active', status: 'active', pendingRole: null });
    expect((await handle.query('getState') as { state: { stage: string; pendingRole: string | null }; slaDeadline?: number }).slaDeadline).toBeUndefined();
    expect(publishedEnrolmentDefinition.definitionSnapshot.stages.active).toMatchObject({ steady: true });
    expect(publishedEnrolmentDefinition.definitionSnapshot.stages.active.pendingRole).toBeUndefined();
    expect(publishedEnrolmentDefinition.definitionSnapshot.stages.active.sla).toBeUndefined();
    expect(stepKeys.map((entry) => JSON.parse(entry))).toContainEqual({
      workflowId: 'org-1:enrolment-1',
      ref: 'verifyNin',
      entryEpoch: 2,
      stepIndex: 0,
      idempotencyKey: JSON.stringify(['org-1:enrolment-1', 2, 0]),
    });
    expect(transitions.find((entry) => entry.nextState.stage === 'active')?.notifications).toContainEqual(
      { template: 'konfam.profile_active', channels: ['sms', 'inbox'] },
    );

    const second = await environment.client.workflow.start('enrolmentWorkflow', {
      taskQueue,
      workflowId: 'org-1:enrolment-2',
      args: [{
        published: publishedEnrolmentDefinition,
        subject: { id: 'enrolment-2', organizationId: 'org-1', metadata: { workerId: 'worker-1', agentId: null } },
      }],
    });
    await second.executeUpdate('applyAction', { updateId: 'consent-2', args: [{ action: 'grant_consent', actorId: 'worker-1' }] });
    await second.executeUpdate('applyAction', { updateId: 'capture-2', args: [{ action: 'submit_self_capture', actorId: 'worker-1' }] });
    const workflowKeys = stepKeys
      .map((entry) => JSON.parse(entry) as { workflowId: string; ref: string; entryEpoch: number; stepIndex: number; idempotencyKey: string })
      .filter((entry) => entry.ref === 'verifyNin' && entry.entryEpoch === 2 && entry.stepIndex === 0);
    expect(workflowKeys).toContainEqual({
      workflowId: 'org-1:enrolment-1',
      ref: 'verifyNin',
      entryEpoch: 2,
      stepIndex: 0,
      idempotencyKey: JSON.stringify(['org-1:enrolment-1', 2, 0]),
    });
    expect(workflowKeys).toContainEqual({
      workflowId: 'org-1:enrolment-2',
      ref: 'verifyNin',
      entryEpoch: 2,
      stepIndex: 0,
      idempotencyKey: JSON.stringify(['org-1:enrolment-2', 2, 0]),
    });
    expect(new Set(workflowKeys.map((entry) => entry.idempotencyKey)).size).toBe(2);
    await second.cancel();

    await handle.executeUpdate('applySignal', { updateId: 'reverify-entry', args: [{ action: 'open_reverification' }] });
    const verificationSteps = stepKeys
      .map((entry) => JSON.parse(entry) as { workflowId: string; ref: string; entryEpoch: number; stepIndex: number; idempotencyKey: string })
      .filter((entry) => entry.ref === 'verifyNin' && entry.workflowId === 'org-1:enrolment-1');
    expect(verificationSteps.map((entry) => entry.entryEpoch)).toEqual([2, 5]);
    expect(new Set(verificationSteps.map((entry) => entry.idempotencyKey)).size).toBeGreaterThan(1);
    expect(stepKeys.map((entry) => JSON.parse(entry))).toContainEqual({
      workflowId: 'org-1:enrolment-1',
      ref: 'verifyNin',
      entryEpoch: 5,
      stepIndex: 0,
      idempotencyKey: JSON.stringify(['org-1:enrolment-1', 5, 0]),
    });
    expect(transitions
      .filter((entry) => entry.workflowId === 'org-1:enrolment-1' && entry.nextState.stage === 'active')
      .flatMap((entry) => entry.notifications ?? [])
      .filter((notification) => notification.template === 'konfam.profile_active')).toHaveLength(2);

    const erased = await handle.executeUpdate('applyAction', { updateId: 'withdraw', args: [{ action: 'withdraw_consent', actorId: 'worker-1' }] }) as { state: { stage: string } };
    expect(erased.state.stage).toBe('erased');
    await handle.result();
  }, 30_000);

  it('accepts policy-protected signals only from the subject organization', async () => {
    const handle = await environment.client.workflow.start('enrolmentWorkflow', {
      taskQueue,
      workflowId: 'org-1:enrolment-signal',
      args: [{
        published: publishedEnrolmentDefinition,
        subject: { id: 'enrolment-signal', organizationId: 'org-1', metadata: { workerId: 'worker-1', agentId: null } },
        initialState: { stage: 'active', status: 'active', pendingRole: null, tracks: { identity: 'verified', consent: 'granted', commission: 'cleared' } },
      }],
    });

    await expect(handle.executeUpdate('applySignal', { updateId: 'untrusted-signal', args: [{ action: 'flag_for_fraud_review' }] })).rejects.toThrow();
    await expect(handle.executeUpdate('applySignal', { updateId: 'cross-org-signal', args: [{ action: 'flag_for_fraud_review' }] })).rejects.toThrow();
    const review = await handle.executeUpdate('applySignal', { updateId: 'trusted-signal', args: [{ action: 'flag_for_fraud_review' }] }) as { state: { stage: string } };
    expect(review.state.stage).toBe('integrity_review');
    await handle.cancel();
  }, 30_000);

  it('enforces separation of duties in the packed worker workflow', async () => {
    const handle = await environment.client.workflow.start('enrolmentWorkflow', {
      taskQueue,
      workflowId: 'org-1:enrolment-separation',
      args: [{
        published: publishedEnrolmentDefinition,
        subject: { id: 'enrolment-separation', organizationId: 'org-1', metadata: { workerId: 'worker-1', agentId: null } },
        initialState: { stage: 'active', status: 'active', pendingRole: null, tracks: { identity: 'verified', consent: 'granted', commission: 'cleared' } },
      }],
    });

    await handle.executeUpdate('applySignal', { updateId: 'trusted-signal', args: [{ action: 'flag_for_fraud_review' }] });
    await handle.executeUpdate('applyAction', { updateId: 'founder-propose', args: [{ action: 'propose_suspension', actorId: 'founder-1' }] });
    await expect(handle.executeUpdate('applyAction', { updateId: 'founder-confirm', args: [{ action: 'confirm_suspension', actorId: 'founder-1' }] })).rejects.toThrow();
    const appealWindow = await handle.executeUpdate('applyAction', { updateId: 'supervisor-confirm', args: [{ action: 'confirm_suspension', actorId: 'supervisor-2' }] }) as { state: { stage: string } };
    expect(appealWindow.state.stage).toBe('appeal_window');
    await handle.cancel();
  }, 30_000);

  it('routes exception and hard-failure verification outputs to their queues', async () => {
    const cases = [
      { id: 'exception', metadata: { ninMatched: true, livenessScore: 0.42, duplicateBiometricFound: false }, expected: 'exception_review' },
      { id: 'hard-failure', metadata: { ninMatched: true, livenessScore: 0.99, duplicateBiometricFound: true }, expected: 'rejection_review' },
    ] as const;

    for (const testCase of cases) {
      const handle = await environment.client.workflow.start('enrolmentWorkflow', {
        taskQueue,
        workflowId: `org-1:enrolment-verification-${testCase.id}`,
        args: [{
          published: publishedEnrolmentDefinition,
          subject: { id: `enrolment-verification-${testCase.id}`, organizationId: 'org-1', metadata: { workerId: 'worker-1', agentId: null, ...testCase.metadata } },
          initialState: { stage: 'identity_capture', status: 'pending', pendingRole: 'worker', tracks: { identity: 'unverified', consent: 'granted', commission: 'none' } },
        }],
      });

      const routed = await handle.executeUpdate('applyAction', { updateId: `submit-${testCase.id}`, args: [{ action: 'submit_self_capture', actorId: 'worker-1' }] }) as { state: { stage: string } };
      expect(routed.state.stage).toBe(testCase.expected);
      await handle.cancel();
    }
  }, 30_000);

  it('accepts the top-level withdrawal action before identity capture', async () => {
    const handle = await environment.client.workflow.start('enrolmentWorkflow', {
      taskQueue,
      workflowId: 'org-1:enrolment-top-level-withdrawal',
      args: [{
        published: publishedEnrolmentDefinition,
        subject: { id: 'enrolment-top-level-withdrawal', organizationId: 'org-1', metadata: { workerId: 'worker-1', agentId: null } },
      }],
    });

    await handle.executeUpdate('applyAction', { updateId: 'grant-before-withdrawal', args: [{ action: 'grant_consent', actorId: 'worker-1' }] });
    const erased = await handle.executeUpdate('applyAction', { updateId: 'withdraw-before-capture', args: [{ action: 'withdraw_consent', actorId: 'worker-1' }] }) as { state: { stage: string } };
    expect(erased.state.stage).toBe('erased');
    await handle.result();
  }, 30_000);

  it('routes entry legal-hold output to retained instead of erased', async () => {
    const handle = await environment.client.workflow.start('enrolmentWorkflow', {
      taskQueue,
      workflowId: 'org-1:enrolment-legal-hold',
      args: [{
        published: publishedEnrolmentDefinition,
        subject: { id: 'enrolment-legal-hold', organizationId: 'org-1', metadata: { workerId: 'worker-1', agentId: null, legalHoldActive: true } },
        initialState: { stage: 'active', status: 'active', pendingRole: null, tracks: { identity: 'verified', consent: 'granted', commission: 'cleared' } },
      }],
    });

    const retained = await handle.executeUpdate('applyAction', { updateId: 'withdraw-under-legal-hold', args: [{ action: 'withdraw_consent', actorId: 'worker-1' }] }) as { state: { stage: string } };
    expect(retained.state.stage).toBe('retained');
    await handle.result();
  }, 30_000);
});
