import { createServer } from 'node:net';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'bun:test';
import { serializeSignedCookie } from 'better-call';
import { drizzle } from 'drizzle-orm/pg-proxy';

import { betterAuthSchema } from '@flowkit-demo/database';
import { loadConfig } from '@flowkit-demo/domain';

import { auth, createAuth } from '../apps/api/src/auth/auth.config';
import { AppModule } from '../apps/api/src/app.module';
import {
  BETTER_AUTH_INSTANCE,
  BetterAuthController,
} from '../apps/api/src/auth/auth.module';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function post(path: string, body: unknown) {
  return auth.handler(new Request(`http://localhost:3011${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('BetterAuth HTTP boundary', () => {
  it('resolves the production organization-context guard from AppModule', async () => {
    const app = await NestFactory.create(AppModule, { logger: false });

    try {
      await app.init();
    } finally {
      await app.close();
    }
  });

  it('does not expose the removed development identity-switcher login', async () => {
    const response = await post('/auth/login', { userId: 'manager-1' });

    expect(response.status).toBe(404);
  });

  it('exposes BetterAuth email/password validation at its configured base path', async () => {
    const response = await post('/api/auth/sign-in/email', {});
    const payload = await response.json() as { code: string };

    expect(response.status).toBe(400);
    expect(payload.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unauthenticated organization creation before database access', async () => {
    const response = await post('/api/auth/organization/create', {
      name: 'Body Controlled Organization',
      slug: 'body-controlled-organization',
    });

    expect(response.status).toBe(401);
  });

  it('serves membership application roles through the mounted Nest BetterAuth controller', async () => {
    const now = new Date('2026-08-13T00:00:00.000Z');
    const sessionToken = 'nest-adapter-session';
    const sessionExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const database = drizzle(async (sql) => {
      if (sql.includes('from "better_auth"."session"')) {
        return { rows: [[
          'session-1', 'user-1', sessionToken, sessionExpiresAt,
          null, null, 'acme', now, now,
        ]] };
      }
      if (sql.includes('from "better_auth"."user"')) {
        return { rows: [['user-1', 'User One', 'user@example.test', true, null, now, now]] };
      }
      if (sql.includes('from "better_auth"."member"')) {
        return { rows: [['member-1', 'acme', 'user-1', 'member', 'employee', true, now]] };
      }
      return { rows: [] };
    }, { schema: betterAuthSchema });
    const testAuth = createAuth({ database });

    class TestModule {}
    Module({
      controllers: [BetterAuthController],
      providers: [{ provide: BETTER_AUTH_INSTANCE, useValue: testAuth }],
    })(TestModule);
    const app = await NestFactory.create(TestModule, { logger: false });
    const port = await availablePort();

    try {
      await app.listen(port, '127.0.0.1');
      const config = loadConfig();
      const cookie = await serializeSignedCookie(
        'flowkit-demo.session_token',
        sessionToken,
        config.BETTER_AUTH_SECRET,
      );
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auth/organization/get-active-member`,
        { headers: { cookie } },
      );
      const member = await response.json() as { applicationRole?: string };

      expect(response.status).toBe(200);
      expect(member.applicationRole).toBe('employee');
    } finally {
      await app.close();
    }
  });
});
