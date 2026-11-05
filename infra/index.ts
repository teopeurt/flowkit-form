import * as aws from '@pulumi/aws';

import { createApi } from './src/api';
import { loadConfig, name } from './src/config';
import { createDatabase } from './src/database';
import { createNotificationQueues } from './src/queues';
import { createContentBucket } from './src/storage';
import { createWorkers } from './src/workers';

const cfg = loadConfig();

const bucket = createContentBucket(cfg);
const { queue, dead } = createNotificationQueues(cfg);

const serviceSecurityGroup = new aws.ec2.SecurityGroup(name(cfg, 'services'), {
  vpcId: cfg.vpcId,
  description: 'FlowKitForm API and workers (egress only)',
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
});

// PostgreSQL is reachable only from members of this same security group (API and workers).
new aws.vpc.SecurityGroupIngressRule(name(cfg, 'db-from-services'), {
  securityGroupId: serviceSecurityGroup.id,
  referencedSecurityGroupId: serviceSecurityGroup.id,
  ipProtocol: 'tcp',
  fromPort: 5432,
  toPort: 5432,
});

const database = createDatabase(cfg, serviceSecurityGroup.id);

// Holds the Temporal Cloud API key. Set its value out of band; never in Pulumi config or code.
const temporalApiKeySecret = new aws.secretsmanager.Secret(name(cfg, 'temporal-api-key'), {
  description: 'Temporal Cloud API key for FlowKitForm workers',
});

const { api } = createApi(cfg, {
  bucket,
  queue,
  database,
  securityGroupId: serviceSecurityGroup.id,
  temporalApiKeySecret,
});
createWorkers(cfg, { bucket, queue, database, securityGroupId: serviceSecurityGroup.id, temporalApiKeySecret });

export const apiUrl = api.apiEndpoint;
export const contentBucket = bucket.bucket;
export const notifyQueueUrl = queue.url;
export const notifyDeadLetterQueueUrl = dead.url;
export const databaseEndpoint = database.endpoint;
