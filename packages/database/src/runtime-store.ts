/**
 * Runtime snapshots were deliberately removed. Durable task, outbox, and
 * leave projections own their own rows; runtime state is now heartbeats only.
 */
export { RuntimeHealthRepository as DemoRuntimeStore } from './runtime-health.repository';
