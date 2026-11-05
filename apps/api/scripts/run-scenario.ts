import { LeaveService } from '../src/leave/leave.service';
const service = new LeaveService();
const leave = await service.create({ managerId: 'manager-1', startDate: '2026-08-03', endDate: '2026-08-03', businessDays: 1, reason: 'Scenario run', balanceDays: 10 }, 'employee-1');
await service.command(leave.id, { action: 'submit' }, { id: 'employee-1', roles: ['employee'] });
await service.command(leave.id, { action: 'auto_approve' }, { id: 'system', roles: ['system'] });
await service.command(leave.id, { action: 'complete' }, { id: 'system', roles: ['system'] });
const finalLeave = await service.get(leave.id);
const deliveries = await service.listNotifications('employee-1');
process.stdout.write(JSON.stringify({ scenario: process.argv[2] ?? 'short-auto-approved', leaveId: leave.id, stage: finalLeave?.state.stage, deliveries: deliveries.length }) + '\n');
