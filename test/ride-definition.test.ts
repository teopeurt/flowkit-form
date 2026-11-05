import { describe, expect, it } from 'bun:test';
import { buildInitialState, lintFlow, lintInterpreterFlow, transition, validateRegistryRefs, type FlowState } from '@naakwu/flowkit-core';
import { publishDefinition, validateFlowkit, verifyPublishedDefinition } from '@naakwu/flowkit-temporal';
import { MAX_DISPATCH_ATTEMPTS, rideChannels, rideDefinition, rideGuards, ridePolicies, rideRules, rideSystemSteps, rideTemplates } from '@flowkit-demo/domain';

/** Interpreter boot shape: rules are pure, system steps are declared I/O refs. */
const interpreterRegistries = { guards: rideGuards, policies: ridePolicies, rules: rideRules, systemSteps: rideSystemSteps, templates: rideTemplates, channels: rideChannels };

/** Kernel shape: `steps` covers both entry-step kinds, so rules go in alongside system steps. */
const coreRefs = { guards: rideGuards, policies: ridePolicies, steps: { ...rideSystemSteps, ...rideRules }, templates: rideTemplates, channels: rideChannels };

const rider = { id: 'rider-1', roles: ['rider'] };
const driver = { id: 'driver-7', roles: ['driver'] };
const subject = { riderId: rider.id, driverId: driver.id };

const step = (state: FlowState, action: string, context: Parameters<typeof transition>[3] = {}) =>
  transition(rideDefinition, state, { action, actorId: context.actor?.id }, { subject, guards: rideGuards, policies: ridePolicies, ...context }).state;

describe('ride hail definition', () => {
  it('is strict, lint-clean, and has a stable immutable snapshot', () => {
    expect(lintFlow(rideDefinition)).toEqual([]);
    expect(lintInterpreterFlow(rideDefinition)).toEqual([]);
    expect(validateRegistryRefs(rideDefinition, coreRefs)).toEqual([]);
    const published = publishDefinition({ definition: rideDefinition });
    verifyPublishedDefinition(published);
    expect(Object.isFrozen(published.definitionSnapshot)).toBe(true);
  });

  it('passes interpreter boot validation', () => {
    expect(validateFlowkit({ published: publishDefinition({ definition: rideDefinition }), registries: interpreterRegistries })).toEqual([]);
  });

  it('starts as an unassigned, unpaid rider draft', () => {
    expect(buildInitialState(rideDefinition)).toEqual({ stage: 'trip_draft', status: 'draft', pendingRole: 'rider', tracks: { driver: 'unassigned', payment: 'none' } });
  });

  it('captures payment and releases the driver on the happy path', () => {
    let state = buildInitialState(rideDefinition);
    state = step(state, 'request_ride', { actor: rider });
    state = step(state, 'offer_quote');
    state = step(state, 'confirm_ride', { actor: rider });
    state = step(state, 'offer_ride');
    state = step(state, 'accept_ride', { actor: driver, facts: { onlineDriverIds: [driver.id] } });
    state = step(state, 'arrive_at_pickup', { actor: driver });
    state = step(state, 'start_trip', { actor: driver, facts: { pickupVerified: true } });
    state = step(state, 'complete_trip', { actor: driver });
    state = step(state, 'capture_fare');
    state = step(state, 'settle_payment');
    state = step(state, 'submit_rating', { actor: rider });

    expect(state).toEqual({ stage: 'completed', status: 'closed', pendingRole: null, tracks: { driver: 'released', payment: 'captured' } });
  });

  it('returns a timed-out offer to dispatch without losing the payment authorization', () => {
    let state = buildInitialState(rideDefinition);
    state = step(state, 'request_ride', { actor: rider });
    state = step(state, 'offer_quote');
    state = step(state, 'confirm_ride', { actor: rider });
    state = step(state, 'offer_ride');
    state = step(state, 'decline_timeout');

    expect(state.stage).toBe('driver_matching');
    expect(state.tracks).toEqual({ driver: 'unassigned', payment: 'authorized' });
  });

  it('routes a late rider cancellation through fee assessment', () => {
    let state = buildInitialState(rideDefinition);
    state = step(state, 'request_ride', { actor: rider });
    state = step(state, 'offer_quote');
    state = step(state, 'confirm_ride', { actor: rider });
    state = step(state, 'offer_ride');
    state = step(state, 'accept_ride', { actor: driver, facts: { onlineDriverIds: [driver.id] } });
    state = step(state, 'rider_cancel_en_route', { actor: rider });
    expect(state.stage).toBe('cancellation_fee_assessment');

    state = step(state, 'charge_cancellation_fee');
    expect(state).toEqual({ stage: 'cancelled', status: 'closed', pendingRole: null, tracks: { driver: 'released', payment: 'captured' } });
  });

  it('lets a rider cancel for free before a driver commits', () => {
    let state = buildInitialState(rideDefinition);
    state = step(state, 'request_ride', { actor: rider });
    state = step(state, 'offer_quote');
    state = step(state, 'cancel_quote', { actor: rider });

    expect(state.tracks.payment).toBe('released');
  });

  it('refuses to start the meter until the rider is verified onboard', () => {
    let state = buildInitialState(rideDefinition);
    state = step(state, 'request_ride', { actor: rider });
    state = step(state, 'offer_quote');
    state = step(state, 'confirm_ride', { actor: rider });
    state = step(state, 'offer_ride');
    state = step(state, 'accept_ride', { actor: driver, facts: { onlineDriverIds: [driver.id] } });
    state = step(state, 'arrive_at_pickup', { actor: driver });

    expect(() => step(state, 'start_trip', { actor: driver, facts: { pickupVerified: false } })).toThrow();
  });

  it('gives up dispatching once the retry budget is spent', () => {
    const dispatch = (facts: Record<string, unknown>) =>
      rideRules.routeDispatch.run({ definition: rideDefinition, state: buildInitialState(rideDefinition), subject, facts });

    expect(dispatch({ candidateDriverId: 'driver-9', dispatchAttempt: 0 })).toBe('offer_ride');
    expect(dispatch({ candidateDriverId: 'driver-9', dispatchAttempt: MAX_DISPATCH_ATTEMPTS })).toBe('no_drivers_available');
    expect(dispatch({ dispatchAttempt: 0 })).toBe('no_drivers_available');
  });

  // The interpreter evaluates entry rules with `facts: {}`, so every rule must still terminate on
  // subject metadata alone. Pinned here so FK-1 (docs/ride-hail-spec.md §8) cannot regress silently.
  it('routes deterministically when the interpreter supplies no facts', () => {
    const state = buildInitialState(rideDefinition);
    const noFacts = (rule: keyof typeof rideRules, seeded: Record<string, unknown>) =>
      rideRules[rule].run({ definition: rideDefinition, state, subject: { ...subject, ...seeded }, facts: {} });

    expect(noFacts('routeQuote', { paymentAuthorized: true })).toBe('offer_quote');
    expect(noFacts('routeQuote', {})).toBe('decline_payment');
    expect(noFacts('routeDispatch', { candidateDriverId: 'driver-9' })).toBe('offer_ride');
    expect(noFacts('routeDispatch', {})).toBe('no_drivers_available');
    expect(noFacts('routeCapture', { captureSucceeded: true })).toBe('settle_payment');
    expect(noFacts('routeSettlement', { finalFareCents: 2400 })).toBe('capture_fare');
    expect(noFacts('routeCancellationFee', { cancellationFeeCents: 500 })).toBe('charge_cancellation_fee');
  });
});
