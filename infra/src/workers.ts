import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { name, type DeployConfig } from './config';

export interface WorkerArgs {
  bucket: aws.s3.Bucket;
  queue: aws.sqs.Queue;
  database: aws.rds.Cluster;
  securityGroupId: aws.ec2.SecurityGroup['id'];
  temporalApiKeySecret: aws.secretsmanager.Secret;
}

const WORKERS = [
  { id: 'workflow-worker', command: ['bun', 'run', 'apps/worker/src/main.ts'] },
  { id: 'notify-worker', command: ['bun', 'run', 'apps/notify-worker/src/delivery.worker.ts'] },
] as const;

/**
 * Temporal workers poll continuously, so they run as Fargate services (serverless
 * containers) that connect to Temporal Cloud, rather than as Lambda functions.
 */
export function createWorkers(cfg: DeployConfig, args: WorkerArgs) {
  const cluster = new aws.ecs.Cluster(name(cfg, 'workers'), {
    settings: [{ name: 'containerInsights', value: 'enabled' }],
  });

  const executionRole = new aws.iam.Role(name(cfg, 'worker-exec'), {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ecs-tasks.amazonaws.com' }),
  });
  new aws.iam.RolePolicyAttachment(name(cfg, 'worker-exec-managed'), {
    role: executionRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
  });

  const taskRole = new aws.iam.Role(name(cfg, 'worker-task'), {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'ecs-tasks.amazonaws.com' }),
  });
  new aws.iam.RolePolicy(name(cfg, 'worker-access'), {
    role: taskRole.id,
    policy: pulumi
      .all([args.bucket.arn, args.queue.arn, args.database.masterUserSecrets, args.temporalApiKeySecret.arn])
      .apply(([bucketArn, queueArn, dbSecrets, temporalSecretArn]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: `${bucketArn}/*` },
            {
              Effect: 'Allow',
              Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'],
              Resource: queueArn,
            },
            {
              Effect: 'Allow',
              Action: ['secretsmanager:GetSecretValue'],
              Resource: [temporalSecretArn, ...dbSecrets.map((secret) => secret.secretArn)],
            },
          ],
        }),
      ),
  });

  return WORKERS.map((worker) => {
    const logs = new aws.cloudwatch.LogGroup(name(cfg, `${worker.id}-logs`), { retentionInDays: 30 });

    const task = new aws.ecs.TaskDefinition(name(cfg, worker.id), {
      family: name(cfg, worker.id),
      cpu: '512',
      memory: '1024',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
      executionRoleArn: executionRole.arn,
      taskRoleArn: taskRole.arn,
      containerDefinitions: pulumi
        .all([logs.name, args.queue.url, args.bucket.bucket, args.temporalApiKeySecret.arn])
        .apply(([logGroup, queueUrl, bucket, temporalSecretArn]) =>
          JSON.stringify([
            {
              name: worker.id,
              image: cfg.workerImageUri,
              essential: true,
              command: worker.command,
              environment: [
                { name: 'NODE_ENV', value: 'production' },
                { name: 'TEMPORAL_ADDRESS', value: cfg.temporalAddress },
                { name: 'TEMPORAL_NAMESPACE', value: cfg.temporalNamespace },
                { name: 'NOTIFY_QUEUE_URL', value: queueUrl },
                { name: 'CONTENT_BUCKET', value: bucket },
              ],
              secrets: [{ name: 'TEMPORAL_API_KEY', valueFrom: temporalSecretArn }],
              logConfiguration: {
                logDriver: 'awslogs',
                options: {
                  'awslogs-group': logGroup,
                  'awslogs-region': aws.config.region ?? 'us-east-1',
                  'awslogs-stream-prefix': worker.id,
                },
              },
            },
          ]),
        ),
    });

    return new aws.ecs.Service(name(cfg, worker.id), {
      cluster: cluster.arn,
      taskDefinition: task.arn,
      desiredCount: 1,
      launchType: 'FARGATE',
      networkConfiguration: { subnets: cfg.privateSubnetIds, securityGroups: [args.securityGroupId], assignPublicIp: false },
    });
  });
}
