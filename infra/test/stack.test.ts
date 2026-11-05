import { beforeAll, describe, expect, it } from 'bun:test';
import * as pulumi from '@pulumi/pulumi';

type Resource = { type: string; name: string; inputs: Record<string, any> };
const resources: Resource[] = [];

pulumi.runtime.setAllConfig({
  'flowkitform:vpcId': 'vpc-1',
  'flowkitform:privateSubnetIds': JSON.stringify(['subnet-a', 'subnet-b']),
  'flowkitform:apiImageUri': '123.dkr.ecr.us-east-1.amazonaws.com/api:1',
  'flowkitform:workerImageUri': '123.dkr.ecr.us-east-1.amazonaws.com/worker:1',
  'flowkitform:temporalAddress': 'ns.acct.tmprl.cloud:7233',
  'flowkitform:temporalNamespace': 'ns.acct',
});

pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      resources.push({ type: args.type, name: args.name, inputs: args.inputs });
      return {
        id: `${args.name}-id`,
        state: {
          ...args.inputs,
          arn: `arn:aws:mock:::${args.name}`,
          bucket: args.name,
          url: `https://sqs.mock/${args.name}`,
          endpoint: `${args.name}.mock`,
          apiEndpoint: `https://${args.name}.execute-api.mock`,
          executionArn: `arn:aws:execute-api:mock:1:${args.name}`,
          invokeArn: `arn:aws:apigateway:mock:lambda:path/${args.name}`,
          masterUserSecrets: [{ secretArn: `arn:aws:secretsmanager:mock:1:secret:${args.name}-db` }],
        },
      };
    },
    call: (args) => args.inputs,
  },
  'flowkitform',
  'test',
  false,
);

const ofType = (type: string) => resources.filter((resource) => resource.type === type);

describe('FlowKitForm serverless stack', () => {
  beforeAll(async () => {
    await import('../index');
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('keeps the content bucket private, versioned and encrypted', () => {
    const block = ofType('aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock')[0]?.inputs;
    expect(block).toMatchObject({ blockPublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true });
    expect(ofType('aws:s3/bucketVersioning:BucketVersioning')[0]?.inputs.versioningConfiguration.status).toBe('Enabled');
    expect(ofType('aws:s3/bucketServerSideEncryptionConfiguration:BucketServerSideEncryptionConfiguration')).toHaveLength(1);
  });

  it('requires IAM authorization on every non-health route', () => {
    const routes = ofType('aws:apigatewayv2/route:Route').map((route) => route.inputs);
    const open = routes.filter((route) => route.authorizationType === 'NONE');
    expect(open.map((route) => route.routeKey)).toEqual(['GET /health/{proxy+}']);
    expect(routes.find((route) => route.routeKey === '$default')?.authorizationType).toBe('AWS_IAM');
  });

  it('encrypts the database and manages its password in Secrets Manager', () => {
    const cluster = ofType('aws:rds/cluster:Cluster')[0]?.inputs;
    expect(cluster).toMatchObject({ storageEncrypted: true, manageMasterUserPassword: true, deletionProtection: true });
  });

  it('dead-letters failed notifications', () => {
    expect(ofType('aws:sqs/queue:Queue')).toHaveLength(2);
  });

  it('runs both workers as Fargate services', () => {
    const services = ofType('aws:ecs/service:Service');
    expect(services).toHaveLength(2);
    expect(services.every((service) => service.inputs.launchType === 'FARGATE')).toBe(true);
    expect(services.every((service) => service.inputs.networkConfiguration.assignPublicIp === false)).toBe(true);
  });

  it('never grants wildcard actions or resources to the roles it creates', async () => {
    const policies = ofType('aws:iam/rolePolicy:RolePolicy');
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      const document = await new Promise<string>((resolve) => pulumi.output(policy.inputs.policy).apply(resolve));
      expect(document).not.toContain('"Action":"*"');
      expect(document).not.toContain('"Resource":"*"');
    }
  });
});
