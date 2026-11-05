import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { LeaveFlowRepository } from '@flowkit-demo/database';
import { LeaveService } from '../apps/api/src/leave/leave.service';
import { clearDurableLeaveServiceData, durableLeaveServiceDatabase } from './durable-test-database';

const sql = await durableLeaveServiceDatabase('resilience boundaries');
const durableTests = sql ? describe : describe.skip;
afterEach(() => clearDurableLeaveServiceData(sql));
afterAll(async () => { if (sql) await sql.end({ timeout: 5 }); });

durableTests('resilience boundaries', () => {
  it('keeps task claim compare-and-set single-winner semantics', async () => {
    const service = new LeaveService(new LeaveFlowRepository({ sql: sql! }));
    const leave = await service.create({ managerId: 'manager-1', startDate: '2026-08-03', endDate: '2026-08-07', businessDays: 5, reason: 'Holiday', balanceDays: 10 }, 'employee-1');
    await service.command(leave.id, { action: 'submit' }, { id: 'employee-1', roles: ['employee'] });
    await service.command(leave.id, { action: 'require_manager' }, { id: 'system', roles: ['system'] });
    const task = (await service.tasks.inbox({ view: 'all', statuses: ['open'] })).items[0]!;
    const results = await Promise.allSettled([service.claim(task, 'manager-1'), service.claim(task, 'manager-2')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await service.get(leave.id)).not.toBeNull();
  });
});
