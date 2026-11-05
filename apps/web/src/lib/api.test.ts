import { afterEach, describe, expect, it, mock } from 'bun:test';

import { ApiClient } from './api';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('same-origin API client', () => {
  it('uses the BetterAuth session and organization endpoints with same-origin credentials', async () => {
    const fetchSpy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ user: { id: 'u1' }, session: { activeOrganizationId: null } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new ApiClient();

    await client.getSession();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/auth/get-session');
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('keeps JSON resources under an API namespace distinct from browser page routes', async () => {
    const fetchSpy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json([]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new ApiClient();

    await client.listTasks();
    await client.listNotifications();

    expect(fetchSpy.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspace/tasks',
      '/api/workspace/notifications',
    ]);
  });

  it('adds idempotency keys to every state-changing BetterAuth POST', async () => {
    const keys = ['sign-in-key', 'sign-out-key', 'organization-key'];
    const fetchSpy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new ApiClient(() => keys.shift() ?? 'unexpected');

    await client.signIn('employee@example.test', 'password');
    await client.signOut();
    await client.setActiveOrganization('acme-demo');

    expect(fetchSpy.mock.calls.map(([, options]) => new Headers(options?.headers).get('idempotency-key'))).toEqual([
      'sign-in-key',
      'sign-out-key',
      'organization-key',
    ]);
  });

  it('adds a fresh idempotency key and never sends organization input for request mutations', async () => {
    const fetchSpy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ id: 'leave-1' }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new ApiClient(() => 'operation-123');

    await client.createRequest({
      startDate: '2026-08-17',
      endDate: '2026-08-21',
      businessDays: 5,
      balanceDays: 12,
      managerId: 'acme-demo-manager',
      reason: 'Family commitment',
    });

    const options = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/workspace/flows');
    expect(new Headers(options.headers).get('idempotency-key')).toBe('operation-123');
    expect(JSON.parse(String(options.body))).toEqual({
      startDate: '2026-08-17',
      endDate: '2026-08-21',
      businessDays: 5,
      balanceDays: 12,
      managerId: 'acme-demo-manager',
      reason: 'Family commitment',
    });
    expect(String(options.body)).not.toContain('organization');
  });

  it('adds idempotency keys to task claims and workflow decisions', async () => {
    const keys = ['claim-key', 'decision-key'];
    const fetchSpy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const client = new ApiClient(() => keys.shift() ?? 'unexpected');

    await client.claimTask('task-1', 3);
    await client.transitionRequest('leave-1', 'approve', 'Coverage confirmed');

    const first = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const second = fetchSpy.mock.calls[1]?.[1] as RequestInit;
    expect(fetchSpy.mock.calls.map(([path]) => path)).toEqual([
      '/api/workspace/tasks/task-1/claim',
      '/api/workspace/flows/leave-1/actions',
    ]);
    expect(new Headers(first.headers).get('idempotency-key')).toBe('claim-key');
    expect(JSON.parse(String(first.body))).toEqual({ expectedRevision: 3 });
    expect(new Headers(second.headers).get('idempotency-key')).toBe('decision-key');
    expect(JSON.parse(String(second.body))).toEqual({ action: 'approve', comment: 'Coverage confirmed' });
  });
});
