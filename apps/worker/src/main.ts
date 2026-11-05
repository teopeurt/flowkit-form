import { loadConfig } from '@flowkit-demo/domain';
import { RuntimeHealthRepository } from '@flowkit-demo/database';
import { activities, validateWorkerRegistries } from './activities';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';

export async function startWorker() {
  const config = loadConfig();
  validateWorkerRegistries();
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)) });
  return Worker.create({ connection, namespace: config.TEMPORAL_NAMESPACE, taskQueue: config.TEMPORAL_TASK_QUEUE, workflowBundle, activities });
}

if (import.meta.main) {
  const worker = await startWorker();
  const health = new RuntimeHealthRepository();
  const heartbeat = async () => health.heartbeat('flowkit-runtime');
  await heartbeat();
  const interval = setInterval(() => { void heartbeat(); }, 10_000);
  const stop = () => { void worker.shutdown(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    process.stdout.write('flowkit-demo Flowkit runtime ready\n');
    await worker.run();
  } finally {
    clearInterval(interval);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await health.close();
  }
}
