export const demoTables = ['users', 'roles', 'leave_requests', 'leave_transitions', 'flow_tasks', 'flow_task_events', 'flow_task_projection_operations', 'flow_task_invitations', 'notification_outbox', 'notification_inbox', 'audit_events', 'demo_runtime_state'] as const;
export type DemoTable = typeof demoTables[number];

/** Tables whose rows are never valid outside an owning BetterAuth organization. */
export const tenantOwnedTables = [
  'users',
  'leave_requests',
  'leave_transitions',
  'flow_tasks',
  'flow_task_events',
  'flow_task_projection_operations',
  'flow_task_invitations',
  'notification_outbox',
  'notification_inbox',
  'audit_events',
] as const satisfies readonly DemoTable[];
export type TenantOwnedTable = typeof tenantOwnedTables[number];
