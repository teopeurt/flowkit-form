const workflowPrefix = (organizationId: string) => `flowkit/${encodeURIComponent(organizationId)}/`;

export function tenantWorkflowId(organizationId: string, flowId: string): string {
  if (!organizationId || !flowId) throw new Error('invalid_tenant_workflow_id');
  return `${workflowPrefix(organizationId)}${encodeURIComponent(flowId)}`;
}

export function tenantFlowId(organizationId: string, workflowId: string): string {
  const prefix = workflowPrefix(organizationId);
  if (!organizationId || !workflowId.startsWith(prefix)) throw new Error('workflow_tenant_mismatch');
  const flowId = decodeURIComponent(workflowId.slice(prefix.length));
  if (!flowId) throw new Error('invalid_tenant_workflow_id');
  return flowId;
}
