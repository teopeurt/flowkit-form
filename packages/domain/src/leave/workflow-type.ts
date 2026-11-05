/**
 * The runtime registers a workflow under the name it is exported as from `workflows.ts`, so the
 * command side must send that same name. It lives here, apart from `workflows.ts`, so the API
 * process never loads the workflow module — that module builds activity proxies at import time and
 * belongs only to the worker bundle. `test/workflow-type.test.ts` keeps the two in step.
 */
export const leaveWorkflowType = 'leaveWorkflow';
