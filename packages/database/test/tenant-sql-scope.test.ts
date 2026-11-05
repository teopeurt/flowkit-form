import { describe, expect, it } from 'bun:test';
import type { Sql } from 'postgres';

import { LeaveFlowRepository } from '../src/leave-flow.repository';
import { PostgresInboxAdapter } from '../src/postgres-inbox.adapter';
import { PostgresOutboxStore } from '../src/postgres-outbox-store';
import { PostgresTaskStore } from '../src/postgres-task-store';

type RecordedQuery = { text: string; values: unknown[] };

function recordingSql() {
  const queries: RecordedQuery[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values });
    return Promise.resolve([]);
  }) as unknown as Sql;
  return { sql, queries };
}

describe('tenant-scoped SQL', () => {
  it('combines a leave identifier with its organization scope', async () => {
    const { sql, queries } = recordingSql();
    const repository = new LeaveFlowRepository({ sql });

    await (repository.getRequest as unknown as (
      scope: { organizationId: string },
      id: string,
    ) => Promise<unknown>)({ organizationId: 'acme-demo' }, 'leave-1');

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain('organization_id');
    expect(queries[0]!.values).toContain('acme-demo');
    expect(queries[0]!.values).toContain('leave-1');
  });

  it('binds Temporal flow identifiers to an organization-owned leave row', async () => {
    const { sql, queries } = recordingSql();
    const repository = new LeaveFlowRepository({ sql });

    await repository.getRequestByFlowId({ organizationId: 'acme-demo' }, 'shared-flow');

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain('organization_id');
    expect(queries[0]!.text).toContain('flow_id');
    expect(queries[0]!.values).toEqual(['acme-demo', 'shared-flow']);
  });

  it('filters task reads and inboxes in SQL before returning rows', async () => {
    const { sql, queries } = recordingSql();
    const tasks = new PostgresTaskStore(sql);

    await tasks.get({ organizationId: 'globex-demo' }, 'task-1');
    await tasks.inbox({ organizationId: 'globex-demo' }, { view: 'all', limit: 1 });

    const selects = queries.filter((query) => query.text.includes('SELECT t.*'));
    expect(selects).toHaveLength(2);
    for (const query of selects) {
      expect(query.text).toContain('t.organization_id');
    }
    expect(queries.filter((query) => query.values.includes('globex-demo'))).toHaveLength(2);
  });

  it('filters both outbox and delivered inbox notification reads by organization', async () => {
    const { sql, queries } = recordingSql();
    const scope = { organizationId: 'acme-demo' };

    await new PostgresOutboxStore(sql).listForRecipient(scope, 'employee-1');
    await new PostgresInboxAdapter(sql).forUser(scope, 'employee-1');

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.text).toContain('organization_id');
      expect(query.values).toContain('acme-demo');
      expect(query.values).toContain('employee-1');
    }
  });

  it('rejects an empty tenant scope before issuing SQL', async () => {
    const { sql, queries } = recordingSql();
    const tasks = new PostgresTaskStore(sql);

    await expect(tasks.get({ organizationId: '' }, 'task-1')).rejects.toThrow('organization scope');
    expect(queries).toEqual([]);
  });
});
