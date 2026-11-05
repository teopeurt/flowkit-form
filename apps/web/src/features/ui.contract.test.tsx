import { afterEach, describe, expect, it, mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LoginPage } from './auth/LoginPage';
import { OrganizationSelectionPage } from './auth/OrganizationSelectionPage';
import { ActivityTimeline } from './activity/ActivityTimeline';
import { NotificationInbox } from './notifications/NotificationInbox';
import { RequestForm } from './requests/RequestForm';
import { RequestSummary } from './requests/RequestSummary';
import { TaskInbox } from './tasks/TaskInbox';
import type { FlowRecord, NotificationPayload, TaskRecord } from '../lib/api';

if (typeof document === 'undefined') GlobalRegistrator.register();

afterEach(cleanup);

const flow: FlowRecord = {
  id: 'leave-42',
  employee_id: 'acme-demo-employee',
  manager_id: 'acme-demo-manager',
  start_date: '2026-08-17',
  end_date: '2026-08-21',
  business_days: 5,
  balance_days: 12,
  reason: 'Family commitment',
  definitionHash: 'sha256:abc',
  sequence: 2,
  state: { stage: 'manager_review' },
  nextActions: ['approve', 'reject'],
  activities: [{
    id: 'event-1',
    actorId: 'acme-demo-employee',
    action: 'submit',
    fromStage: 'employee_draft',
    toStage: 'manager_review',
    occurredAt: '2026-08-13T10:00:00.000Z',
  }],
};

describe('authenticated FlowKit feature modules', () => {
  it('submits the keyboard-accessible login form through BetterAuth credentials', async () => {
    const onSignIn = mock(async () => undefined);
    const view = render(<LoginPage onSignIn={onSignIn} />);
    const user = userEvent.setup({ document: window.document });

    await user.type(view.getByRole('textbox', { name: 'Email' }), 'employee@acme-demo.example.test');
    await user.type(view.getByLabelText('Password'), 'demo-password');
    await user.click(view.getByRole('button', { name: 'Sign in' }));

    expect(onSignIn).toHaveBeenCalledWith('employee@acme-demo.example.test', 'demo-password');
  });

  it('requires an explicit organization choice from the authenticated membership list', async () => {
    const onSelect = mock(async () => undefined);
    const view = render(<OrganizationSelectionPage organizations={[{ id: 'acme-demo', name: 'Acme Demo', slug: 'acme-demo' }]} onSelect={onSelect} />);
    const user = userEvent.setup({ document: window.document });

    await user.click(view.getByRole('button', { name: 'Use Acme Demo' }));

    expect(onSelect).toHaveBeenCalledWith('acme-demo');
  });

  it('creates a leave request from labeled domain fields', async () => {
    const onCreate = mock(async () => undefined);
    const view = render(<RequestForm onCreate={onCreate} defaultManagerId="acme-demo-manager" />);
    const user = userEvent.setup({ document: window.document });

    await user.type(view.getByLabelText('Start date'), '2026-08-17');
    await user.type(view.getByLabelText('End date'), '2026-08-21');
    await user.clear(view.getByRole('spinbutton', { name: 'Business days' }));
    await user.type(view.getByRole('spinbutton', { name: 'Business days' }), '5');
    await user.clear(view.getByRole('spinbutton', { name: 'Available balance' }));
    await user.type(view.getByRole('spinbutton', { name: 'Available balance' }), '12');
    await user.type(view.getByRole('textbox', { name: 'Reason' }), 'Family commitment');
    await user.click(view.getByRole('button', { name: 'Create request' }));

    expect(onCreate).toHaveBeenCalledWith({
      startDate: '2026-08-17',
      endDate: '2026-08-21',
      businessDays: 5,
      balanceDays: 12,
      managerId: 'acme-demo-manager',
      reason: 'Family commitment',
    });
  });

  it('shows request state and only the supplied server-authorized actions', () => {
    const view = render(<RequestSummary flow={flow} currentRole="manager" currentUserId="acme-demo-manager" reviewTask={{ id: 'task-1', subjectId: flow.id, stage: 'manager_review', role: 'manager', status: 'claimed', revision: 1, assigneeId: 'acme-demo-manager' }} onAction={async () => undefined} />);

    expect(view.getByRole('heading', { name: 'leave-42' }).isConnected).toBe(true);
    expect(view.getByTestId('request-stage').textContent).toBe('Manager review');
    expect(view.getByRole('button', { name: 'Approve request' }).isConnected).toBe(true);
    expect(view.getByRole('button', { name: 'Reject request' }).isConnected).toBe(true);
    expect(view.queryByRole('button', { name: 'Submit request' })).toBeNull();
  });

  it('hides manager decisions while the known review task is unclaimed', () => {
    const view = render(<RequestSummary flow={flow} currentRole="manager" currentUserId="acme-demo-manager" reviewTask={{ id: 'task-1', subjectId: flow.id, stage: 'manager_review', role: 'manager', status: 'open', revision: 0 }} onAction={async () => undefined} />);

    expect(view.queryByRole('button', { name: 'Approve request' }) === null).toBe(true);
    expect(view.queryByRole('button', { name: 'Reject request' }) === null).toBe(true);
    expect(view.getByText('Claim the review task before recording a decision.').isConnected).toBe(true);
  });

  function expectTerminalRail(stage: 'rejected' | 'withdrawn') {
    const terminal = { ...flow, state: { stage }, nextActions: [] };
    const view = render(<RequestSummary flow={terminal} currentRole="employee" currentUserId={flow.employee_id} onAction={async () => undefined} />);
    const rail = view.getByRole('list', { name: 'Workflow position' });

    expect(rail.textContent).toContain(`${stage === 'rejected' ? 'Rejected' : 'Withdrawn'}Current stage`);
    expect(rail.textContent).not.toContain('ApprovedPending');
  }

  it('ends the workflow rail at the rejected terminal state', () => expectTerminalRail('rejected'));

  it('ends the workflow rail at the withdrawn terminal state', () => expectTerminalRail('withdrawn'));

  it('lets a manager claim an open task and exposes its request link', async () => {
    const task: TaskRecord = { id: 'task-1', subjectId: flow.id, stage: 'manager_review', role: 'manager', status: 'open', revision: 0 };
    const onClaim = mock(async () => undefined);
    const view = render(<TaskInbox tasks={[task]} currentUserId="acme-demo-manager" onClaim={onClaim} />);
    const user = userEvent.setup({ document: window.document });

    expect(view.getByRole('link', { name: 'Open leave-42' }).getAttribute('href')).toBe('/requests/leave-42');
    await user.click(view.getByRole('button', { name: 'Claim task' }));
    expect(onClaim).toHaveBeenCalledWith(task);
  });

  it('renders durable activity and notification history as readable lists', () => {
    const notifications: NotificationPayload = {
      inbox: [{ id: 'notice-1', subject: 'Request approved', body: 'leave-42 was approved', deliveredAt: '2026-08-13T10:05:00.000Z' }],
      deliveries: [{ id: 'delivery-1', subject: 'Request approved', status: 'delivered' }],
    };
    const view = render(<><ActivityTimeline activities={flow.activities} /><NotificationInbox payload={notifications} /></>);

    expect(view.getByRole('list', { name: 'Request activity' }).textContent).toContain('Submitted');
    expect(view.getByRole('region', { name: 'Notifications' }).textContent).toContain('Request approved');
    expect(view.getByRole('region', { name: 'Notifications' }).textContent).toContain('Delivered');
  });

  it('contains no inherited FAAN product language', () => {
    const view = render(<><LoginPage onSignIn={async () => undefined} /><RequestSummary flow={flow} currentRole="manager" currentUserId="acme-demo-manager" onAction={async () => undefined} /></>);

    expect(view.container.textContent).not.toMatch(/FAAN|AVSEC|aviation security/i);
  });
});
