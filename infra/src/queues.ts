import * as aws from '@pulumi/aws';

import { name, type DeployConfig } from './config';

/** Notification delivery queue (spec §4 queue port) with a dead-letter queue. */
export function createNotificationQueues(cfg: DeployConfig) {
  const dead = new aws.sqs.Queue(name(cfg, 'notify-dlq'), {
    messageRetentionSeconds: 14 * 24 * 3600,
    sqsManagedSseEnabled: true,
  });

  const queue = new aws.sqs.Queue(name(cfg, 'notify'), {
    visibilityTimeoutSeconds: 120,
    sqsManagedSseEnabled: true,
    redrivePolicy: dead.arn.apply((arn) => JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 })),
  });

  return { queue, dead };
}
