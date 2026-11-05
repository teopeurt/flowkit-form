import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { leaveWorkflowType } from '@flowkit-demo/domain';

describe('leave workflow module', () => {
  it('reads no configuration, because the sandbox that imports it has no process', async () => {
    const source = await readFile(new URL('../apps/worker/src/workflows.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/loadConfig|process\.env/);
  });
});

describe('leave workflow type', () => {
  it('names a workflow the worker bundle actually exports', async () => {
    const workflows = await import('../apps/worker/src/workflows');

    expect(Object.keys(workflows)).toContain(leaveWorkflowType);
    expect(typeof (workflows as Record<string, unknown>)[leaveWorkflowType]).toBe('function');
  });

  it('is a plain name, because a factory-built workflow value is anonymous', () => {
    expect(leaveWorkflowType).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });
});
