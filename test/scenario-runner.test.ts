import { afterAll, afterEach, describe, expect, it } from 'bun:test';

import { LeaveFlowRepository } from '@flowkit-demo/database';
import { LeaveService } from '../apps/api/src/leave/leave.service';
import { clearDurableLeaveServiceData, durableLeaveServiceDatabase } from './durable-test-database';

const sql = await durableLeaveServiceDatabase('scenario runner primitives');
const durableTests = sql ? describe : describe.skip;
afterEach(() => clearDurableLeaveServiceData(sql));
afterAll(async () => { if (sql) await sql.end({ timeout: 5 }); });

durableTests('scenario runner primitives', () => {
  it('produces an approved short-leave outcome', async () => {
    const service = new LeaveService(new LeaveFlowRepository({ sql: sql! }));
    const leave = await service.create({ managerId: 'manager-1', startDate: '2026-08-03', endDate: '2026-08-03', businessDays: 1, reason: 'Scenario', balanceDays: 10 }, 'employee-1');
    await service.command(leave.id, { action: 'submit' }, { id: 'employee-1', roles: ['employee'] });
    await service.command(leave.id, { action: 'auto_approve' }, { id: 'system', roles: ['system'] });
    await service.command(leave.id, { action: 'complete' }, { id: 'system', roles: ['system'] });
    expect((await service.get(leave.id))?.state.stage).toBe('approved');
  });
});
