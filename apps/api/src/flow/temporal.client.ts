import { Client, Connection } from '@temporalio/client';
import type { FlowRuntime } from '@naakwu/flowkit-consumer';
import { createFlowkitTemporalRuntime } from '@naakwu/flowkit-temporal';

import { loadConfig } from '@flowkit-demo/domain';
import { leaveWorkflowType } from '@flowkit-demo/domain';

const config = loadConfig();
const connection = Connection.lazy({ address: config.TEMPORAL_ADDRESS });
const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });

export const leaveRuntime: FlowRuntime = createFlowkitTemporalRuntime({
  client,
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  workflowType: leaveWorkflowType,
  async healthProbe() {
    const checkedAt = new Date().toISOString();

    try {
      await connection.ensureConnected();
      return { ready: true, checkedAt };
    } catch {
      return { ready: false, checkedAt };
    }
  },
});
