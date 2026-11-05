/**
 * Mirrors `leave/workflow-type.ts`: the command side must name the workflow exactly as the
 * worker exports it, and this constant is kept apart from `workflows.ts` so the API process
 * never imports the workflow module.
 */
export const rideWorkflowType = 'rideWorkflow';
