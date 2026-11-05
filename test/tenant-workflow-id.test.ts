import { describe, expect, it } from 'bun:test';

import { tenantFlowId, tenantWorkflowId } from '@flowkit-demo/domain';

describe('tenant-qualified Temporal workflow IDs', () => {
  it('round-trips a tenant-local flow identifier', () => {
    const workflowId = tenantWorkflowId('acme/demo', 'leave/shared');

    expect(workflowId).toBe('flowkit/acme%2Fdemo/leave%2Fshared');
    expect(tenantFlowId('acme/demo', workflowId)).toBe('leave/shared');
  });

  it('rejects a workflow identifier bound to another organization', () => {
    const workflowId = tenantWorkflowId('globex-demo', 'shared-flow');

    expect(() => tenantFlowId('acme-demo', workflowId)).toThrow('workflow_tenant_mismatch');
  });
});
