export type ReadinessProbe = { ping: () => Promise<void> };

export function liveHealth() {
  return { status: 'ok', service: 'flowkit-demo' };
}

export async function readyHealth(readiness: ReadinessProbe) {
  await readiness.ping();
  return { status: 'ready', definition: 'leave-approval-demo@1', database: 'ok' };
}
