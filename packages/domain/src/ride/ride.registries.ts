import type { PredicateContext } from '@naakwu/flowkit-core';
import type { FlowkitPureRegistries, RuleContext } from '@naakwu/flowkit-temporal';

/** Dispatch gives up after this many refused or timed-out offers. */
export const MAX_DISPATCH_ATTEMPTS = 5;

export const rideGuards = {
  /** A driver who went offline mid-offer must not be able to accept it. */
  driverOnline: ({ actor, facts }: PredicateContext) =>
    facts.onlineDriverIds instanceof Array && facts.onlineDriverIds.includes(actor?.id),
  /** Prevents a driver from starting the meter before the rider is in the car. */
  riderOnboard: ({ facts }: PredicateContext) => facts.pickupVerified === true,
  supportTaskClaimed: ({ actor, facts }: PredicateContext) =>
    facts.supportTaskAssigneeId === actor?.id,
};

export const ridePolicies = {
  riderOwnsTrip: ({ actor, subject }: PredicateContext) =>
    actor?.roles.includes('rider') === true && actor.id === subject.riderId,
  /** Scoped to the current offer holder, not to drivers in general. */
  offeredDriver: ({ actor, subject }: PredicateContext) =>
    actor?.roles.includes('driver') === true && actor.id === subject.driverId,
  assignedDriver: ({ actor, subject }: PredicateContext) =>
    actor?.roles.includes('driver') === true && actor.id === subject.driverId,
  tripParticipant: ({ actor, subject }: PredicateContext) =>
    actor?.id === subject.riderId || actor?.id === subject.driverId,
  supportAgent: ({ actor }: PredicateContext) => actor?.roles.includes('support') === true,
};

/** Reads a routing input, preferring the current entry-step facts over subject metadata. */
const routingInput = ({ facts, subject }: RuleContext, key: string): unknown =>
  facts[key] ?? subject[key];

export const rideRules = {
  routeQuote: {
    actions: ['offer_quote', 'decline_payment'],
    run: (ctx: RuleContext) =>
      routingInput(ctx, 'paymentAuthorized') === true ? 'offer_quote' : 'decline_payment',
  },
  /**
   * The retry budget lives here, so changing it never touches the stage graph. Note that the bound
   * is only enforceable once `dispatchAttempt` is a live fact; under FK-1's current behaviour this
   * reads a static subject value and cannot terminate the re-dispatch loop on its own.
   */
  routeDispatch: {
    actions: ['offer_ride', 'no_drivers_available'],
    run: (ctx: RuleContext) =>
      routingInput(ctx, 'candidateDriverId') && Number(routingInput(ctx, 'dispatchAttempt') ?? 0) < MAX_DISPATCH_ATTEMPTS
        ? 'offer_ride'
        : 'no_drivers_available',
  },
  routeSettlement: {
    actions: ['capture_fare', 'waive_fare'],
    run: (ctx: RuleContext) =>
      Number(routingInput(ctx, 'finalFareCents') ?? 0) > 0 && routingInput(ctx, 'serviceCreditApplied') !== true
        ? 'capture_fare'
        : 'waive_fare',
  },
  routeCapture: {
    actions: ['settle_payment', 'retry_settlement'],
    run: (ctx: RuleContext) =>
      routingInput(ctx, 'captureSucceeded') === true ? 'settle_payment' : 'retry_settlement',
  },
  /** No fee before the driver was committed, or when the driver caused the cancellation. */
  routeCancellationFee: {
    actions: ['charge_cancellation_fee', 'waive_cancellation_fee'],
    run: (ctx: RuleContext) =>
      Number(routingInput(ctx, 'cancellationFeeCents') ?? 0) > 0 ? 'charge_cancellation_fee' : 'waive_cancellation_fee',
  },
} satisfies NonNullable<FlowkitPureRegistries['rules']>;

export const rideSystemSteps = {
  estimateRoute: true,
  priceTrip: true,
  authorizePaymentMethod: true,
  dispatchNearestDriver: true,
  computeFinalFare: true,
  applyPromotions: true,
  captureRiderPayment: true,
  assessCancellationFee: true,
};

export const rideTemplates = Object.fromEntries(
  [
    'ride.payment_failed',
    'ride.driver_offer',
    'ride.no_drivers',
    'ride.driver_assigned',
    'ride.driver_arriving',
    'ride.trip_started',
    'ride.incident_raised',
    'ride.receipt',
    'ride.cancellation_fee',
    'ride.cancelled',
  ].map((key) => [key, true]),
);

export const rideChannels = { inbox: true, push: true, email: true };
