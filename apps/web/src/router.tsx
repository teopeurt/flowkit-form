import { useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  createBrowserRouter,
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteError,
  useRouteLoaderData,
  type LoaderFunctionArgs,
} from 'react-router-dom';

import { Alert, Badge, Button, LoadingState, Panel } from '@flowkit-demo/ui';
import { ActivityTimeline } from './features/activity/ActivityTimeline';
import { LoginPage } from './features/auth/LoginPage';
import { OrganizationSelectionPage } from './features/auth/OrganizationSelectionPage';
import { NotificationInbox } from './features/notifications/NotificationInbox';
import { RequestForm } from './features/requests/RequestForm';
import { RequestSummary } from './features/requests/RequestSummary';
import { TaskInbox } from './features/tasks/TaskInbox';
import {
  ApiError,
  api,
  errorMessage,
  type ActiveMember,
  type FlowRecord,
  type NotificationPayload,
  type Organization,
  type RuntimeStatus,
  type SessionPayload,
  type TaskRecord,
} from './lib/api';

type ProtectedContext = {
  session: SessionPayload;
  member: ActiveMember;
  organization: Organization;
};

export const router = createBrowserRouter([
  {
    path: '/login',
    loader: loginLoader,
    element: <LoginRoute />,
    errorElement: <RouteError />,
  },
  {
    path: '/organizations',
    loader: organizationsLoader,
    element: <OrganizationRoute />,
    errorElement: <RouteError />,
  },
  {
    id: 'protected',
    path: '/',
    loader: protectedLoader,
    element: <ApplicationShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, loader: dashboardLoader, element: <Dashboard /> },
      { path: 'requests/new', element: <NewRequestRoute /> },
      { path: 'requests/:requestId', loader: requestDetailLoader, element: <RequestRoute /> },
      { path: 'tasks', loader: tasksLoader, element: <TasksRoute /> },
      { path: 'activity/:requestId', loader: requestLoader, element: <ActivityRoute /> },
      { path: 'notifications', loader: notificationsLoader, element: <NotificationsRoute /> },
    ],
  },
]);

async function loginLoader() {
  const session = await api.getSession();
  if (session?.session.activeOrganizationId) throw redirect('/');
  if (session) throw redirect('/organizations');
  return null;
}

async function organizationsLoader() {
  const session = await api.getSession();
  if (!session) throw redirect('/login');
  return { organizations: await api.listOrganizations() };
}

async function protectedLoader(): Promise<ProtectedContext> {
  const session = await api.getSession();
  if (!session) throw redirect('/login');
  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) throw redirect('/organizations');
  const [organizations, member] = await Promise.all([api.listOrganizations(), api.getActiveMember()]);
  const organization = organizations.find((candidate) => candidate.id === organizationId);
  if (!organization) throw redirect('/organizations');
  return { session, member, organization };
}

async function dashboardLoader() {
  const [tasks, notifications, runtime] = await Promise.all([
    api.listTasks(),
    api.listNotifications(),
    api.getRuntime().catch(() => ({}) as RuntimeStatus),
  ]);
  return { tasks, notifications, runtime };
}

async function requestLoader({ params }: LoaderFunctionArgs) {
  if (!params.requestId) throw new Response('Request identifier is required.', { status: 400 });
  return api.getRequest(params.requestId);
}

async function requestDetailLoader({ params }: LoaderFunctionArgs) {
  if (!params.requestId) throw new Response('Request identifier is required.', { status: 400 });
  const [flow, tasks] = await Promise.all([api.getRequest(params.requestId), api.listTasks()]);
  return { flow, tasks };
}

async function tasksLoader() {
  return api.listTasks();
}

async function notificationsLoader() {
  return api.listNotifications();
}

function LoginRoute() {
  const navigate = useNavigate();
  return <LoginPage onSignIn={async (email, password) => { await api.signIn(email, password); await navigate('/organizations'); }} />;
}

function OrganizationRoute() {
  const { organizations } = useLoaderData() as { organizations: Organization[] };
  const navigate = useNavigate();
  return <OrganizationSelectionPage organizations={organizations} onSelect={async (organizationId) => { await api.setActiveOrganization(organizationId); await navigate('/'); }} />;
}

function ApplicationShell() {
  const { member, organization, session } = useLoaderData() as ProtectedContext;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const navItems = [
    { to: '/', label: 'Overview', end: true },
    { to: '/requests/new', label: 'New request' },
    { to: '/tasks', label: 'Task inbox' },
    { to: '/notifications', label: 'Notifications' },
  ];

  async function signOut() {
    await api.signOut();
    await navigate('/login');
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <div className="wordmark wordmark--sidebar"><span>FK</span><strong>FlowKit</strong></div>
        <p className="eyebrow">Workspace</p>
        <nav aria-label="Primary navigation">
          {navItems.map((item) => <NavLink key={item.to} to={item.to} end={item.end}>{item.label}</NavLink>)}
        </nav>
        <div className="sidebar-context"><small>Organization</small><strong>{organization.name}</strong><code>{organization.slug}</code></div>
      </aside>
      <div className="app-frame">
        <header className="topbar">
          <div><small>Signed in as</small><strong>{session.user.name}</strong><span>{member.applicationRole.replaceAll('_', ' ')}</span></div>
          <div className="topbar-actions"><Link className="text-link" to="/organizations">Change organization</Link><Button variant="quiet" onClick={signOut}>Sign out</Button></div>
        </header>
        {navigation.state !== 'idle' && navigation.location?.pathname !== location.pathname ? <div className="route-loading"><LoadingState label="Loading workspace" /></div> : null}
        <main id="main-content" className="main-content"><Outlet /></main>
      </div>
    </div>
  );
}

function Dashboard() {
  const { tasks, notifications, runtime } = useLoaderData() as { tasks: TaskRecord[]; notifications: NotificationPayload; runtime: RuntimeStatus };
  const { member } = useRouteLoaderData('protected') as ProtectedContext;
  const ready = Boolean(runtime.flowkitRuntime?.ready && runtime.delivery?.ready);
  return (
    <div className="page-stack">
      <header className="page-heading"><p className="eyebrow">Workflow overview</p><h1>Work waiting for you</h1><p>Start a request or continue an assigned decision from one place.</p></header>
      <section className="metric-grid" aria-label="Workspace summary">
        <article><small>Your role</small><strong>{member.applicationRole.replaceAll('_', ' ')}</strong><span>Membership derived</span></article>
        <article><small>Assigned tasks</small><strong>{tasks.length}</strong><span>Current inbox</span></article>
        <article><small>Notifications</small><strong>{notifications.inbox.length}</strong><span>Durable inbox</span></article>
        <article><small>Service status</small><strong>{ready ? 'Ready' : 'Check'}</strong><span>Runtime and delivery</span></article>
      </section>
      <Panel title="Choose your next step" meta={<Badge tone="accent">Active</Badge>}>
        <div className="quick-actions">
          <Link to="/requests/new"><strong>Create a request</strong><span>Record leave dates and route a decision.</span></Link>
          <Link to="/tasks"><strong>Open task inbox</strong><span>Claim and review work assigned to your role.</span></Link>
          <Link to="/notifications"><strong>Read notifications</strong><span>Check in-app updates and delivery evidence.</span></Link>
        </div>
      </Panel>
    </div>
  );
}

function NewRequestRoute() {
  const { organization } = useRouteLoaderData('protected') as ProtectedContext;
  const navigate = useNavigate();
  return (
    <div className="page-stack">
      <header className="page-heading"><p className="eyebrow">Employee request</p><h1>Create a request</h1><p>A new request begins as a draft, ready for your review.</p></header>
      <RequestForm defaultManagerId={`${organization.id}-manager`} onCreate={async (input) => {
        const flow = await api.createRequest(input);
        sessionStorage.setItem('flowkit:last-request', flow.id);
        await navigate(`/requests/${flow.id}`);
      }} />
    </div>
  );
}

function RequestRoute() {
  const initial = useLoaderData() as { flow: FlowRecord; tasks: TaskRecord[] };
  const { member, session } = useRouteLoaderData('protected') as ProtectedContext;
  const [flow, setFlow] = useState(initial.flow);

  useEffect(() => setFlow(initial.flow), [initial.flow]);

  async function runAction(action: string, comment?: string) {
    await api.transitionRequest(flow.id, action, comment);
    setFlow(await pollUntilOwnedStage(flow.id));
  }

  return (
    <RequestSummary
      flow={flow}
      currentRole={member.applicationRole}
      currentUserId={session.user.id}
      reviewTask={initial.tasks.find((task) => task.subjectId === flow.id && task.stage === 'manager_review')}
      onAction={runAction}
    />
  );
}

function TasksRoute() {
  const initial = useLoaderData() as TaskRecord[];
  const { session } = useRouteLoaderData('protected') as ProtectedContext;
  const [tasks, setTasks] = useState(initial);
  useEffect(() => setTasks(initial), [initial]);
  return (
    <div className="page-stack">
      <header className="page-heading"><p className="eyebrow">Assigned work</p><h1>Task inbox</h1><p>Claim open work before recording a decision.</p></header>
      <TaskInbox tasks={tasks} currentUserId={session.user.id} onClaim={async (task) => { await api.claimTask(task.id, task.revision); setTasks(await api.listTasks()); }} />
    </div>
  );
}

function ActivityRoute() {
  const flow = useLoaderData() as FlowRecord;
  return (
    <div className="page-stack">
      <header className="page-heading"><p className="eyebrow">Immutable history</p><h1>Activity for {flow.id}</h1><p>Each transition records who acted and how the request moved.</p></header>
      <Panel title="Activity history" meta={<Badge tone="neutral">{flow.activities.length} events</Badge>}><ActivityTimeline activities={flow.activities} /></Panel>
    </div>
  );
}

function NotificationsRoute() {
  const initial = useLoaderData() as NotificationPayload;
  const [payload, setPayload] = useState(initial);
  const [pollError, setPollError] = useState<string>();

  useEffect(() => {
    let active = true;
    const interval = window.setInterval(() => {
      api.listNotifications().then((next) => { if (active) { setPayload(next); setPollError(undefined); } }).catch((error) => { if (active) setPollError(errorMessage(error)); });
    }, 1000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  return (
    <div className="page-stack">
      <header className="page-heading"><p className="eyebrow">Delivery history</p><h1>Notifications</h1><p>See durable inbox messages and outbound delivery evidence.</p></header>
      {pollError ? <Alert tone="error" title="Notifications unavailable">{pollError}</Alert> : null}
      <NotificationInbox payload={payload} />
    </div>
  );
}

function RouteError() {
  const error = useRouteError();
  const message = error instanceof ApiError ? error.message : error instanceof Response ? `${error.status} ${error.statusText}` : errorMessage(error);
  return (
    <main className="error-shell">
      <Alert tone="error" title="This view could not be loaded">{message}</Alert>
      <Link className="text-link" to="/">Return to overview</Link>
    </main>
  );
}

async function pollUntilOwnedStage(requestId: string) {
  const automaticStages = new Set(['policy_evaluation', 'fulfillment']);
  const deadline = Date.now() + 30_000;
  let flow = await api.getRequest(requestId);
  while (automaticStages.has(flow.state.stage) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    flow = await api.getRequest(requestId);
  }
  return flow;
}
