import { describe, expect, it } from 'bun:test';
import { buildInitialState, lintFlow, lintInterpreterFlow, validateRegistryRefs } from '@naakwu/flowkit-core';
import { publishDefinition, verifyPublishedDefinition } from '@naakwu/flowkit-temporal';
import { leaveDefinition } from '@flowkit-demo/domain';
import { leaveChannels, leaveGuards, leavePolicies, leaveRules, leaveSystemSteps, leaveTemplates } from '@flowkit-demo/domain';

describe('leave approval definition', () => {
  it('is strict, lint-clean, and has a stable immutable snapshot', () => {
    expect(lintFlow(leaveDefinition)).toEqual([]);
    expect(lintInterpreterFlow(leaveDefinition)).toEqual([]);
    expect(validateRegistryRefs(leaveDefinition, { guards: leaveGuards, policies: leavePolicies, steps: { ...leaveSystemSteps, ...leaveRules }, templates: leaveTemplates, channels: leaveChannels })).toEqual([]);
    const published = publishDefinition({ definition: leaveDefinition });
    verifyPublishedDefinition(published);
    expect(Object.isFrozen(published.definitionSnapshot)).toBe(true);
    expect(buildInitialState(leaveDefinition).stage).toBe('employee_draft');
  });
});
