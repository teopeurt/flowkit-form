import { defineFlow, type FlowDefinition } from '@naakwu/flowkit-core';

/**
 * On-demand ride hail, modelled as one durable flow per trip.
 *
 * Two things about a ride do not fit a single linear stage machine, so they are
 * tracks rather than stages: who currently holds the trip (`driver`) and how far
 * the money has moved (`payment`). A rider cancellation at `driver_arrived` and a
 * completed trip both end with money captured, but from opposite stages — the
 * track carries that fact without duplicating stages per payment outcome.
 *
 * The dispatch retry loop is the other non-linear part: `driver_offer` returns to
 * `driver_matching` on decline or on the 15s acceptance SLA, and `routeDispatch`
 * decides from `facts.dispatchAttempt` whether to offer again or give up.
 */
export const rideDefinition: FlowDefinition = defineFlow({
  id: 'ride-hail-demo', version: 1, roles: ['rider', 'driver', 'support'],
  initialStage: 'trip_draft', initialStatus: 'draft',
  tracks: {
    driver: { initial: 'unassigned', values: ['unassigned', 'offered', 'assigned', 'arrived', 'released'] },
    payment: { initial: 'none', values: ['none', 'authorized', 'captured', 'failed', 'released'] },
  },
  stages: {
    trip_draft: { pendingRole: 'rider', steady: true, actions: {
      request_ride: { to: 'fare_quote', kind: 'human', policy: 'riderOwnsTrip', status: 'pending' },
      discard_draft: { to: 'abandoned', kind: 'human', policy: 'riderOwnsTrip', status: 'closed' },
    } },

    // Price and payment-authorize before anything is promised to the rider.
    fare_quote: { entry: [
      { kind: 'system', ref: 'estimateRoute' },
      { kind: 'system', ref: 'priceTrip' },
      { kind: 'system', ref: 'authorizePaymentMethod' },
      { kind: 'rule', ref: 'routeQuote' },
    ], actions: {
      offer_quote: { to: 'rider_confirmation', kind: 'system', tracks: { payment: 'authorized' } },
      decline_payment: { to: 'payment_failed', kind: 'system', status: 'closed', tracks: { payment: 'failed' }, notify: { template: 'ride.payment_failed', channels: ['push', 'inbox'] } },
    } },

    // A held quote is a priced promise, so it expires rather than waiting forever.
    rider_confirmation: { pendingRole: 'rider', sla: { after: '2m', escalate: { action: 'expire_quote' } }, actions: {
      confirm_ride: { to: 'driver_matching', kind: 'human', policy: 'riderOwnsTrip' },
      cancel_quote: { to: 'cancelled', kind: 'human', policy: 'riderOwnsTrip', status: 'closed', tracks: { payment: 'released' } },
      expire_quote: { to: 'expired', kind: 'system', status: 'closed', tracks: { payment: 'released' } },
    } },

    driver_matching: { entry: [
      { kind: 'system', ref: 'dispatchNearestDriver' },
      { kind: 'rule', ref: 'routeDispatch' },
    ], actions: {
      offer_ride: { to: 'driver_offer', kind: 'system', status: 'active', tracks: { driver: 'offered' }, notify: { template: 'ride.driver_offer', channels: ['push'], to: ['driver'] } },
      no_drivers_available: { to: 'unfulfilled', kind: 'system', status: 'closed', tracks: { driver: 'released', payment: 'released' }, notify: { template: 'ride.no_drivers', channels: ['push', 'inbox'] } },
    } },

    // Acceptance window. Timeout and explicit decline are the same edge, but stay
    // separate actions so the audit trail distinguishes a busy driver from an idle one.
    driver_offer: { pendingRole: 'driver', sla: { after: '15s', escalate: { action: 'decline_timeout' } }, actions: {
      accept_ride: { to: 'driver_en_route', kind: 'human', policy: 'offeredDriver', guards: ['driverOnline'], tracks: { driver: 'assigned' }, notify: { template: 'ride.driver_assigned', channels: ['push', 'inbox'] } },
      decline_ride: { to: 'driver_matching', kind: 'human', policy: 'offeredDriver', tracks: { driver: 'unassigned' } },
      decline_timeout: { to: 'driver_matching', kind: 'system', tracks: { driver: 'unassigned' } },
      cancel_during_match: { to: 'cancelled', kind: 'human', policy: 'riderOwnsTrip', status: 'closed', tracks: { driver: 'released', payment: 'released' } },
    } },

    // From here a rider cancellation is no longer free: it routes through fee assessment.
    driver_en_route: { pendingRole: 'driver', steady: true, actions: {
      arrive_at_pickup: { to: 'driver_arrived', kind: 'human', policy: 'assignedDriver', tracks: { driver: 'arrived' }, notify: { template: 'ride.driver_arriving', channels: ['push'] } },
      rider_cancel_en_route: { to: 'cancellation_fee_assessment', kind: 'human', policy: 'riderOwnsTrip' },
      driver_cancel_en_route: { to: 'driver_matching', kind: 'human', policy: 'assignedDriver', tracks: { driver: 'unassigned' } },
    } },

    driver_arrived: { pendingRole: 'driver', sla: { after: '5m', escalate: { action: 'report_no_show' } }, actions: {
      start_trip: { to: 'trip_in_progress', kind: 'human', policy: 'assignedDriver', guards: ['riderOnboard'], notify: { template: 'ride.trip_started', channels: ['inbox'] } },
      report_no_show: { to: 'cancellation_fee_assessment', kind: 'system' },
      rider_cancel_at_pickup: { to: 'cancellation_fee_assessment', kind: 'human', policy: 'riderOwnsTrip' },
    } },

    trip_in_progress: { pendingRole: 'driver', steady: true, actions: {
      complete_trip: { to: 'fare_finalization', kind: 'human', policy: 'assignedDriver' },
      report_incident: { to: 'support_review', kind: 'human', policy: 'tripParticipant', notify: { template: 'ride.incident_raised', channels: ['inbox'], to: ['support'] } },
    } },

    // Either party can pull a live trip to a human; support decides whether it resumes.
    support_review: { pendingRole: 'support', sla: { after: '10m', escalate: { action: 'terminate_trip' } }, actions: {
      resume_trip: { to: 'trip_in_progress', kind: 'human', policy: 'supportAgent', guards: ['supportTaskClaimed'] },
      terminate_trip: { to: 'fare_finalization', kind: 'system' },
    } },

    fare_finalization: { entry: [
      { kind: 'system', ref: 'computeFinalFare' },
      { kind: 'system', ref: 'applyPromotions' },
      { kind: 'rule', ref: 'routeSettlement' },
    ], actions: {
      capture_fare: { to: 'payment_settlement', kind: 'system' },
      waive_fare: { to: 'rating', kind: 'system', tracks: { driver: 'released', payment: 'released' } },
    } },

    payment_settlement: { entry: [
      { kind: 'system', ref: 'captureRiderPayment' },
      { kind: 'rule', ref: 'routeCapture' },
    ], actions: {
      settle_payment: { to: 'rating', kind: 'system', tracks: { driver: 'released', payment: 'captured' }, notify: { template: 'ride.receipt', channels: ['email', 'inbox'] } },
      retry_settlement: { to: 'payment_recovery', kind: 'system', tracks: { driver: 'released', payment: 'failed' }, notify: { template: 'ride.payment_failed', channels: ['push', 'inbox'] } },
    } },

    // The trip is over; the debt is not. This stage outlives the ride itself.
    payment_recovery: { pendingRole: 'rider', sla: { after: '24h', escalate: { action: 'write_off_fare' } }, actions: {
      update_payment_method: { to: 'payment_settlement', kind: 'human', policy: 'riderOwnsTrip' },
      write_off_fare: { to: 'rating', kind: 'system', tracks: { payment: 'released' } },
    } },

    cancellation_fee_assessment: { entry: [
      { kind: 'system', ref: 'assessCancellationFee' },
      { kind: 'rule', ref: 'routeCancellationFee' },
    ], actions: {
      charge_cancellation_fee: { to: 'cancelled', kind: 'system', status: 'closed', tracks: { driver: 'released', payment: 'captured' }, notify: { template: 'ride.cancellation_fee', channels: ['push', 'inbox', 'email'] } },
      waive_cancellation_fee: { to: 'cancelled', kind: 'system', status: 'closed', tracks: { driver: 'released', payment: 'released' }, notify: { template: 'ride.cancelled', channels: ['push', 'inbox'] } },
    } },

    rating: { pendingRole: 'rider', sla: { after: '24h', escalate: { action: 'skip_rating' } }, actions: {
      submit_rating: { to: 'completed', kind: 'human', policy: 'tripParticipant', status: 'closed' },
      skip_rating: { to: 'completed', kind: 'system', status: 'closed' },
    } },

    completed: { final: true },
    cancelled: { final: true },
    abandoned: { final: true },
    expired: { final: true },
    unfulfilled: { final: true },
    payment_failed: { final: true },
  },
});
