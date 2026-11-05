import { NotificationAdapterRegistry, NotificationDeliveryRuntime, type NotificationChannelAdapter, type RegisteredAdapter } from '@naakwu/flowkit-notify';

import { loadConfig } from '@flowkit-demo/domain';
import { PostgresOutboxStore } from '@flowkit-demo/database';
import { RuntimeHealthRepository } from '@flowkit-demo/database';
import { MailpitSmtpAdapter } from './mailpit-smtp.adapter';
import { PostgresInboxAdapter } from '@flowkit-demo/database';
import type { TenantScope } from '@flowkit-demo/database';

const retryPolicy = { maxAttempts: 3, initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 10_000 };

export function createDeliveryAdapters(options: { inbox: NotificationChannelAdapter; smtp: NotificationChannelAdapter }): NotificationAdapterRegistry {
  const adapters = new NotificationAdapterRegistry();
  const registered: RegisteredAdapter[] = [
    { channel: options.inbox.channel, idempotent: options.inbox.idempotent, send: options.inbox.send.bind(options.inbox), enabled: true, retryPolicy },
    { channel: options.smtp.channel, idempotent: options.smtp.idempotent, send: options.smtp.send.bind(options.smtp), enabled: true, retryPolicy },
  ];
  for (const adapter of registered) adapters.register(adapter);
  adapters.freeze();
  return adapters;
}

export async function runDeliveryCycle(options: {
  scope: TenantScope;
  owner: string;
  outbox: PostgresOutboxStore;
  adapters: NotificationAdapterRegistry;
  health: RuntimeHealthRepository;
}): Promise<{ claimed: number }> {
  const runtime = new NotificationDeliveryRuntime({ store: options.outbox.forOrganization(options.scope), adapters: options.adapters });
  const claimed = await runtime.claimAndDeliver(options.owner, 50);
  await options.health.heartbeat('delivery-worker');
  return { claimed };
}

export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => { clearTimeout(timer); done(); };
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runDeliveryLoop(signal: AbortSignal, options: {
  scope: TenantScope;
  owner: string;
  outbox: PostgresOutboxStore;
  adapters: NotificationAdapterRegistry;
  health: RuntimeHealthRepository;
  activePollMs?: number;
  idlePollMs?: number;
  logger?: Pick<Console, 'error'>;
}): Promise<void> {
  while (!signal.aborted) {
    let claimed = 0;
    try {
      ({ claimed } = await runDeliveryCycle(options));
    } catch (error) {
      options.logger?.error('Flowkit notification delivery cycle failed', error);
    }
    await sleep(claimed > 0 ? options.activePollMs ?? 100 : options.idlePollMs ?? 1_000, signal);
  }
}

if (import.meta.main) {
  const outbox = new PostgresOutboxStore();
  const inbox = new PostgresInboxAdapter(outbox.sql);
  const smtp = new MailpitSmtpAdapter();
  const health = new RuntimeHealthRepository(outbox.sql);
  const config = loadConfig();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    process.stdout.write(`${JSON.stringify({ status: 'ready', worker: 'delivery-worker' })}\n`);
    const rows = await outbox.sql<Array<{ organization_id: string }>>`
      SELECT id AS organization_id FROM better_auth.organization ORDER BY id
    `;
    await Promise.all(rows.map(({ organization_id: organizationId }) => {
      const scope = { organizationId };
      return runDeliveryLoop(controller.signal, {
        scope,
        owner: `delivery-worker-${process.pid}-${organizationId}`,
        outbox,
        adapters: createDeliveryAdapters({ inbox: inbox.forOrganization(scope), smtp: smtp.forOrganization(scope) }),
        health,
        activePollMs: config.FLOWKIT_DEMO_NOTIFY_ACTIVE_POLL_MS,
        idlePollMs: config.FLOWKIT_DEMO_NOTIFY_IDLE_POLL_MS,
        logger: console,
      });
    }));
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await smtp.close();
    await outbox.close();
  }
}
