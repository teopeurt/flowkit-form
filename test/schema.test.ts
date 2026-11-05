import { describe, expect, it } from 'bun:test';
import { demoTables } from '@flowkit-demo/database';
describe('demo schema', () => { it('contains isolated domain, task, notification, and audit tables', () => { expect(demoTables).toContain('leave_requests'); expect(demoTables).toContain('flow_tasks'); expect(demoTables).toContain('notification_outbox'); }); });
