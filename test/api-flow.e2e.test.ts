import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AuthenticatedPrincipal } from '@naakwu/flowkit-auth';

import { FlowController } from '../apps/api/src/flow.controller';
import { NotificationsController } from '../apps/api/src/notifications.controller';
import { RuntimeController } from '../apps/api/src/runtime.controller';
import { TasksController } from '../apps/api/src/tasks.controller';
import {
  ORGANIZATION_CONTEXT_PROVIDER,
  OrganizationContextGuard,
} from '../apps/api/src/auth/auth.module';
import { principal } from '@flowkit-demo/domain';
import { RuntimeHealthRepository } from '@flowkit-demo/database';
import { FlowkitDemoConsumer } from '../apps/api/src/flow/flowkit-demo.consumer';

const fiveDayLeave = {
  managerId: 'manager-1',
  startDate: '2026-08-03',
  endDate: '2026-08-07',
  businessDays: 5,
  reason: 'Family travel',
  balanceDays: 10,
  metadata: {},
};

type RequestClient = {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown, headers?: HeadersInit): Promise<any>;
};

const identities = new Map<string, AuthenticatedPrincipal>([
  ['employee-1', principal('employee-1', 'employee')],
  ['employee-2', principal('employee-2', 'employee')],
  ['manager-1', principal('manager-1', 'manager')],
  ['manager-2', principal('manager-2', 'manager')],
]);

class FakeOrganizationContextProvider {
  async resolve(headers: Headers) {
    const userId = headers.get('authorization')?.replace(/^Bearer test-/, '') ?? '';
    const current = identities.get(userId);
    return current ? { organizationId: 'acme', userId, principal: current } : null;
  }
}

class FakeConsumer {
  private readonly requests = new Map<string, any>();
  private readonly states = new Map<string, string>();
  private task: any = null;
  readonly repository = {
    getRequest: async (_scope: unknown, id: string) => this.requests.get(id) ?? null,
    listActivities: async () => [],
    tasks: {
      get: async (_scope: unknown, id: string) => this.task?.id === id ? this.task : null,
      find: async () => this.task,
    },
  };
  private readonly scopedTasks = {
    list: async ({ actor }: any) => {
      const request = this.task ? this.requests.get(this.task.subjectId) : null;
      const visible = this.task && (
        (this.task.status === 'open' && request?.manager_id === actor.id)
        || (this.task.status === 'claimed' && this.task.assigneeId === actor.id)
      );
      return { items: visible ? [this.task] : [], nextCursor: null };
    },
    claim: async (input: any) => {
      if (!this.task || input.expectedRevision !== this.task.revision || this.task.status !== 'open') {
        throw new Error('stale_task_revision');
      }
      this.task = { ...this.task, status: 'claimed', assigneeId: input.actor.id, revision: input.expectedRevision + 1 };
      return this.task;
    },
  };
  readonly outbox = { listForRecipient: async () => [] };
  readonly inbox = { forUser: async () => [] };

  tasks() { return this.scopedTasks; }

  async start(scope: { organizationId: string }, input: any) {
    this.requests.set(input.subject.id, { organization_id: scope.organizationId, id: input.subject.id, flow_id: input.flowId, employee_id: input.actor.id, manager_id: input.subject.metadata.managerId, definition_hash: 'sha256:demo' });
    this.states.set(input.flowId, 'employee_draft');
    return this.view(input.flowId);
  }

  async getFlow(_scope: unknown, flowId: string) {
    if (!this.states.has(flowId)) throw new Error('flow_not_found');
    return this.view(flowId);
  }

  async act(_scope: unknown, input: any) {
    if (input.action === 'submit') {
      this.states.set(input.flowId, 'manager_review');
      const request = [...this.requests.values()].find((item) => item.flow_id === input.flowId)!;
      this.task = { id: 'task-1', flowId: input.flowId, subjectType: 'leave', subjectId: request.id, stage: 'manager_review', role: 'manager', status: 'open', assigneeId: null, revision: 0 };
    }
    if (input.action === 'approve') this.states.set(input.flowId, 'approved');
    return this.view(input.flowId);
  }

  async health() { return { ready: true, checkedAt: '2026-07-29T00:00:00.000Z' }; }

  private view(flowId: string) {
    const stage = this.states.get(flowId)!;
    return { state: { stage, status: stage === 'approved' ? 'completed' : 'pending', pendingRole: stage === 'manager_review' ? 'manager' : null, tracks: {} }, sequence: 1, stepResults: {}, completed: stage === 'approved', nextActions: [] };
  }
}

class FakeRuntimeHealth {
  async health(name: string) { return { name, ready: true, checkedAt: '2026-07-29T00:00:00.000Z', heartbeatAt: '2026-07-29T00:00:00.000Z' }; }
}

async function request(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.message ?? 'request_failed'), { status: response.status, payload });
  return { payload, response };
}

async function login(baseUrl: string, userId: string): Promise<RequestClient> {
  if (!identities.has(userId)) throw new Error('test user not found');
  const authorization = `Bearer test-${userId}`;
  return {
    get: async (path) => (await request(baseUrl, path, { headers: { authorization } })).payload,
    post: async (path, body, headers = {}) => (await request(baseUrl, path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    })).payload,
  };
}

type TestApplication = Awaited<ReturnType<typeof NestFactory.create>>;

let app: TestApplication;
let baseUrl: string;

function addressInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EADDRINUSE';
}

function highPortCandidates() {
  const firstPort = 40_000 + Math.floor(Math.random() * 10_000);
  return Array.from({ length: 20 }, (_, attempt) => (
    40_000 + ((firstPort - 40_000 + attempt * 977) % 10_000)
  ));
}

async function closeAfterFailedListen(target: TestApplication) {
  try {
    await target.close();
  } catch {
    // A failed Nest listen can leave the adapter without an active listener.
  }
}

async function startTestApplication(
  createApplication: () => Promise<TestApplication>,
  ports = highPortCandidates(),
): Promise<{ app: TestApplication; baseUrl: string; attemptedPorts: number[] }> {
  let lastError: unknown;
  const attemptedPorts: number[] = [];

  for (const port of ports) {
    const target = await createApplication();
    attemptedPorts.push(port);
    try {
      await target.listen(port, '127.0.0.1');
      return { app: target, baseUrl: await target.getUrl(), attemptedPorts };
    } catch (error) {
      lastError = error;
      await closeAfterFailedListen(target);
      if (!addressInUse(error)) throw error;
    }
  }
  throw lastError ?? new Error('Could not bind the HTTP test server to an available port.');
}

async function createTestApplication(): Promise<TestApplication> {
  const consumer = new FakeConsumer();
  class TestModule {}
  Module({
    controllers: [FlowController, TasksController, NotificationsController, RuntimeController],
    providers: [
      { provide: FlowkitDemoConsumer, useValue: consumer },
      { provide: ORGANIZATION_CONTEXT_PROVIDER, useValue: new FakeOrganizationContextProvider() },
      OrganizationContextGuard,
      { provide: RuntimeHealthRepository, useValue: new FakeRuntimeHealth() },
    ],
  })(TestModule);
  return NestFactory.create(TestModule, { logger: false });
}

beforeAll(async () => {
  // Bun's Node-compatible HTTP server cannot bind to port zero here. A fresh
  // Nest application is created for every candidate, so EADDRINUSE never
  // leaves the application used by the API contract tests in a failed state.
  const started = await startTestApplication(createTestApplication);
  app = started.app;
  baseUrl = started.baseUrl;
});

afterAll(async () => { await app.close(); });

describe('Flowkit API organization context and role paths', () => {
  it('rebuilds the Nest fixture after a real address collision', async () => {
    const blockedPort = Number(new URL(baseUrl).port);
    const createdApps: TestApplication[] = [];
    const started = await startTestApplication(async () => {
      const candidate = await createTestApplication();
      createdApps.push(candidate);
      return candidate;
    }, [blockedPort, ...highPortCandidates().filter((port) => port !== blockedPort)]);

    try {
      expect(started.attemptedPorts[0]).toBe(blockedPort);
      expect(started.attemptedPorts.length).toBeGreaterThan(1);
      const successfulApp = createdApps[createdApps.length - 1]!;
      expect(started.app).toBe(successfulApp);
      expect(started.app).not.toBe(createdApps[0]);
      expect(new URL(started.baseUrl).port).not.toBe(String(blockedPort));
    } finally {
      await started.app.close();
    }
  });

  it('returns Flowkit activity and durable inbox views for an authenticated organization member', async () => {
    const employee = await login(baseUrl, 'employee-1');
    const { id } = await employee.post('/flows', fiveDayLeave);
    const flow = await employee.get(`/flows/${id}`) as any;
    const notifications = await employee.get('/notifications') as any;

    expect(flow).toMatchObject({
      id,
      definitionHash: 'sha256:demo',
      activities: [],
    });
    expect(notifications).toEqual({ inbox: [], deliveries: [] });
  });

  it('rejects approval before the manager task is claimed', async () => {
    const employee = await login(baseUrl, 'employee-1');
    const { id } = await employee.post('/flows', fiveDayLeave);
    await employee.post(`/flows/${id}/actions`, { action: 'submit' });
    const manager = await login(baseUrl, 'manager-1');
    await expect(manager.post(`/flows/${id}/actions`, { action: 'approve' })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps a claimed manager task visible after refresh and permits the decision', async () => {
    const employee = await login(baseUrl, 'employee-1');
    const { id } = await employee.post('/flows', fiveDayLeave);
    await employee.post(`/flows/${id}/actions`, { action: 'submit' });
    const manager = await login(baseUrl, 'manager-1');
    const [task] = await manager.get('/tasks') as any[];
    await manager.post(`/tasks/${task.id}/claim`, { expectedRevision: task.revision });
    const [claimed] = await manager.get('/tasks') as any[];
    expect(claimed).toMatchObject({ id: task.id, status: 'claimed', assigneeId: 'manager-1' });
    await manager.post(`/flows/${id}/actions`, { action: 'approve' });
    expect(await employee.get(`/flows/${id}`)).toMatchObject({ state: { stage: 'approved' } });
    await expect(employee.post(`/flows/${id}/actions`, { action: 'approve' }, { 'x-demo-user': 'manager-1', 'x-demo-role': 'manager' })).rejects.toMatchObject({ status: 404 });
  });

  it('lists a claim action only for the assigned manager and still rejects an unassigned claim attempt', async () => {
    const employee = await login(baseUrl, 'employee-1');
    const { id } = await employee.post('/flows', fiveDayLeave);
    await employee.post(`/flows/${id}/actions`, { action: 'submit' });
    const manager2 = await login(baseUrl, 'manager-2');
    expect(await manager2.get('/tasks')).toEqual([]);

    const manager1 = await login(baseUrl, 'manager-1');
    const [task] = await manager1.get('/tasks') as any[];
    expect(task).toMatchObject({ subjectId: id, status: 'open', assigneeId: null });

    await expect(manager2.post(`/tasks/${task.id}/claim`, { expectedRevision: task.revision })).rejects.toMatchObject({ status: 404 });

    await expect(manager1.post(`/tasks/${task.id}/claim`, { expectedRevision: task.revision })).resolves.toMatchObject({
      status: 'claimed',
      assigneeId: 'manager-1',
    });
  });

  it('makes unauthorized and missing flow identifiers indistinguishable', async () => {
    const employee1 = await login(baseUrl, 'employee-1');
    const employee2 = await login(baseUrl, 'employee-2');
    const { id } = await employee1.post('/flows', fiveDayLeave);

    await expect(employee2.get(`/flows/${id}`)).rejects.toMatchObject({ status: 404 });
    await expect(employee2.get('/flows/missing-flow')).rejects.toMatchObject({ status: 404 });
    await expect(employee2.post(`/flows/${id}/actions`, { action: 'submit' })).rejects.toMatchObject({ status: 404 });
    await expect(employee2.post('/flows/missing-flow/actions', { action: 'submit' })).rejects.toMatchObject({ status: 404 });
  });

  it('makes unauthorized and missing task identifiers indistinguishable', async () => {
    const employee = await login(baseUrl, 'employee-1');
    const manager1 = await login(baseUrl, 'manager-1');
    const manager2 = await login(baseUrl, 'manager-2');
    const { id } = await employee.post('/flows', fiveDayLeave);
    await employee.post(`/flows/${id}/actions`, { action: 'submit' });
    const [task] = await manager1.get('/tasks') as any[];

    await expect(manager2.post(`/tasks/${task.id}/claim`, { expectedRevision: task.revision })).rejects.toMatchObject({ status: 404 });
    await expect(manager2.post('/tasks/missing-task/claim', { expectedRevision: task.revision })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects requests without recognized authentication credentials', async () => {
    await expect(request(baseUrl, '/tasks')).rejects.toMatchObject({ status: 401 });
    await expect(request(baseUrl, '/tasks', { headers: { authorization: 'Bearer forged-user' } })).rejects.toMatchObject({ status: 401 });
  });

  it('reports worker heartbeats separately from API observation time', async () => {
    const employee = await login(baseUrl, 'employee-1');
    const runtime = await employee.get('/runtime') as any;
    expect(runtime.flowkitRuntime).toMatchObject({
      ready: true,
      heartbeatAt: '2026-07-29T00:00:00.000Z',
      checkedAt: '2026-07-29T00:00:00.000Z',
    });
    expect(runtime.delivery.heartbeatAt).toBe('2026-07-29T00:00:00.000Z');
    expect(runtime.mailpitUrl).toBe('http://localhost:8025');

    const previousMailpitUrl = process.env.MAILPIT_URL;
    process.env.MAILPIT_URL = 'http://localhost:8026';
    try {
      expect((await employee.get('/runtime') as any).mailpitUrl).toBe('http://localhost:8026');
    } finally {
      if (previousMailpitUrl === undefined) delete process.env.MAILPIT_URL;
      else process.env.MAILPIT_URL = previousMailpitUrl;
    }
  });
});
