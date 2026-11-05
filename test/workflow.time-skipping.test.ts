import { describe, expect, it } from 'bun:test';
import type { RuleContext } from '@naakwu/flowkit-temporal';

import { leaveRules } from '@flowkit-demo/domain';

describe('reference leave workflow automatic routing', () => {
  it('routes a short leave through the Flowkit rule without an HTTP system action', () => {
    const action = leaveRules.routeLeaveRequest.run({
      subject: { businessDays: 1 },
    } as unknown as RuleContext);

    expect(action).toBe('auto_approve');
    expect(leaveRules.completeFulfillment.run()).toBe('complete');
  });
});
