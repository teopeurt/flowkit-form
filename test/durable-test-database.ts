import postgres, { type Sql } from 'postgres';

import { durableTestsEnabled, loadConfig } from '@flowkit-demo/domain';

const leaveServiceTables = [
  'leave_requests', 'leave_transitions', 'flow_tasks', 'flow_task_events',
  'flow_task_projection_operations', 'flow_task_invitations', 'notification_outbox', 'audit_events',
];

export async function durableTestDatabase(label: string, requiredTables: string[]): Promise<Sql | null> {
  if (!durableTestsEnabled()) {
    process.stderr.write(`Skipping ${label}: set FLOWKIT_DEMO_DURABLE_TESTS=true to enable durable database tests.\n`);
    return null;
  }

  const config = loadConfig();
  const databaseName = new URL(config.DATABASE_URL).pathname.slice(1);
  if (databaseName !== config.FLOWKIT_DEMO_DURABLE_TEST_DATABASE) {
    throw new Error(
      `${label} requires DATABASE_URL pathname ${config.FLOWKIT_DEMO_DURABLE_TEST_DATABASE}; received ${databaseName}.`,
    );
  }

  const sql = postgres(config.DATABASE_URL, { max: 5, connect_timeout: 2 });
  // The element type has to be stated: an untyped parameter array leaves `ANY` with no operator.
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${requiredTables}::text[])
  `;
  const present = new Set(rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !present.has(table));
  if (missing.length > 0) {
    await sql.end({ timeout: 1 });
    throw new Error(`${label} requires migrated tables: ${missing.join(', ')}.`);
  }
  return sql;
}

export function durableLeaveServiceDatabase(label: string): Promise<Sql | null> {
  return durableTestDatabase(label, leaveServiceTables);
}

export async function clearDurableLeaveServiceData(sql: Sql | null): Promise<void> {
  if (!sql) return;
  await sql`DELETE FROM notification_outbox`;
  await sql`DELETE FROM flow_task_invitations`;
  await sql`DELETE FROM flow_task_projection_operations`;
  await sql`DELETE FROM flow_task_events`;
  await sql`DELETE FROM flow_tasks`;
  await sql`DELETE FROM leave_transitions`;
  await sql`DELETE FROM audit_events`;
  await sql`DELETE FROM leave_requests`;
}
