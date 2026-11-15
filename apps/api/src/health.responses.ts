export type ReadinessProbe = { ping: () => Promise<void> };

export function liveHealth() {
  return { status: 'ok', service: 'flowkitform' };
}

export async function readyHealth(readiness: ReadinessProbe) {
  await readiness.ping();
  return { status: 'ready', definition: 'leave-approval-demo@1', database: 'ok' };
}
