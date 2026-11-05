import type { NotificationChannelAdapter, NotificationDeliveryEnvelope } from '@naakwu/flowkit-notify';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { loadConfig, type DemoConfig } from '@flowkit-demo/domain';
import { requireTenantScope, type TenantScope } from '@flowkit-demo/database';

const require = createRequire(import.meta.url);

export type SmtpMail = {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  headers: Record<string, string>;
};

export interface SmtpTransport {
  sendMail(message: SmtpMail): Promise<{ messageId?: string }>;
  close?(): void | Promise<void>;
}

type NodemailerModule = {
  createTransport(options: { host: string; port: number; secure: boolean }): SmtpTransport;
};

const nodemailer = require('nodemailer') as NodemailerModule;
const deliveryKey = (scope: TenantScope, dedupeKey: string) => JSON.stringify([scope.organizationId, dedupeKey]);
const messageIdFor = (scope: TenantScope, dedupeKey: string) => `<${createHash('sha256').update(deliveryKey(scope, dedupeKey)).digest('hex')}@flowkit-demo.local>`;

/**
 * Mailpit SMTP channel adapter.
 *
 * SMTP provides no durable idempotency key: a process can crash after the server
 * accepts a message but before the outbox records its receipt. The stable
 * Message-ID and local cache help make ordinary retries easier to inspect, but
 * neither survives a restart, so Flowkit must treat this channel as
 * non-idempotent.
 */
export class MailpitSmtpAdapter {
  readonly channel = 'email';
  readonly idempotent = false;
  private readonly sent = new Map<string, string>();
  private readonly transport: SmtpTransport;
  private readonly from: string;

  constructor(options: { config?: DemoConfig; transport?: SmtpTransport; from?: string } = {}) {
    const config = options.config ?? (options.transport ? undefined : loadConfig());
    this.transport = options.transport ?? nodemailer.createTransport({
      host: config?.SMTP_HOST ?? 'localhost',
      port: config?.SMTP_PORT ?? 1025,
      secure: false,
    });
    this.from = options.from ?? config?.SMTP_FROM ?? 'notifications@flowkit-demo.test';
  }

  forOrganization(scope: TenantScope): NotificationChannelAdapter {
    requireTenantScope(scope);
    return {
      channel: this.channel,
      idempotent: this.idempotent,
      send: (input) => this.send(scope, input),
    };
  }

  async send(scope: TenantScope, input: { envelope: NotificationDeliveryEnvelope; attemptId: string }) {
    requireTenantScope(scope);
    const { envelope } = input;
    const key = deliveryKey(scope, envelope.dedupeKey);
    const prior = this.sent.get(key);
    if (prior) return { providerMessageId: prior };

    const result = await this.transport.sendMail({
      from: this.from,
      to: envelope.recipient.address,
      subject: envelope.rendered.subject,
      text: envelope.rendered.body,
      messageId: messageIdFor(scope, envelope.dedupeKey),
      headers: { 'X-Flowkit-Dedupe-Key': envelope.dedupeKey },
    });
    const providerMessageId = result.messageId ?? messageIdFor(scope, envelope.dedupeKey);
    this.sent.set(key, providerMessageId);
    return { providerMessageId };
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}
