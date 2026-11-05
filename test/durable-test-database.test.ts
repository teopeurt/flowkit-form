import { describe, expect, it } from 'bun:test';

import { durableTestsEnabled } from '@flowkit-demo/domain';

describe('durable test opt-in', () => {
  it('is disabled unless explicitly set to true', () => {
    expect(durableTestsEnabled({})).toBe(false);
    expect(durableTestsEnabled({ FLOWKIT_DEMO_DURABLE_TESTS: 'false' })).toBe(false);
    expect(durableTestsEnabled({ FLOWKIT_DEMO_DURABLE_TESTS: 'true' })).toBe(true);
  });

  it('rejects malformed opt-in values', () => {
    expect(() => durableTestsEnabled({ FLOWKIT_DEMO_DURABLE_TESTS: 'yes' })).toThrow();
  });
});
