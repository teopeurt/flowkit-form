import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

import { name, type DeployConfig } from './config';

export interface ApiArgs {
  bucket: aws.s3.Bucket;
  queue: aws.sqs.Queue;
  database: aws.rds.Cluster;
  securityGroupId: aws.ec2.SecurityGroup['id'];
  temporalApiKeySecret: aws.secretsmanager.Secret;
}

/**
 * HTTP API + Lambda. The existing NestJS server runs unchanged on Lambda through
 * the AWS Lambda Web Adapter (bake the adapter extension into the image).
 * Default authorization is AWS IAM (SigV4), like the reference `openapi-iam.yaml`;
 * an OIDC JWT authorizer is added when `oidcIssuer` is configured (spec §9).
 */
export function createApi(cfg: DeployConfig, args: ApiArgs) {
  const role = new aws.iam.Role(name(cfg, 'api-role'), {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
  });
  new aws.iam.RolePolicyAttachment(name(cfg, 'api-vpc'), {
    role: role.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaVPCAccessExecutionRole,
  });
  new aws.iam.RolePolicy(name(cfg, 'api-access'), {
    role: role.id,
    policy: pulumi
      .all([args.bucket.arn, args.queue.arn, args.database.masterUserSecrets, args.temporalApiKeySecret.arn])
      .apply(([bucketArn, queueArn, dbSecrets, temporalSecretArn]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:GetObjectVersion'], Resource: `${bucketArn}/*` },
            { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: bucketArn },
            { Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: queueArn },
            {
              Effect: 'Allow',
              Action: ['secretsmanager:GetSecretValue'],
              Resource: [temporalSecretArn, ...dbSecrets.map((secret) => secret.secretArn)],
            },
          ],
        }),
      ),
  });

  const logs = new aws.cloudwatch.LogGroup(name(cfg, 'api-logs'), { retentionInDays: 30 });

  const fn = new aws.lambda.Function(name(cfg, 'api'), {
    packageType: 'Image',
    imageUri: cfg.apiImageUri,
    role: role.arn,
    timeout: 29,
    memorySize: 1024,
    architectures: ['arm64'],
    vpcConfig: { subnetIds: cfg.privateSubnetIds, securityGroupIds: [args.securityGroupId] },
    loggingConfig: { logFormat: 'JSON', logGroup: logs.name },
    environment: {
      variables: {
        NODE_ENV: 'production',
        PORT: '3011',
        AWS_LWA_PORT: '3011',
        AWS_LWA_READINESS_CHECK_PATH: '/health/live',
        CONTENT_BUCKET: args.bucket.bucket,
        NOTIFY_QUEUE_URL: args.queue.url,
        TEMPORAL_ADDRESS: cfg.temporalAddress,
        TEMPORAL_NAMESPACE: cfg.temporalNamespace,
      },
    },
  });

  const api = new aws.apigatewayv2.Api(name(cfg, 'http'), { protocolType: 'HTTP' });

  const integration = new aws.apigatewayv2.Integration(name(cfg, 'lambda'), {
    apiId: api.id,
    integrationType: 'AWS_PROXY',
    integrationUri: fn.invokeArn,
    payloadFormatVersion: '2.0',
  });
  const target = pulumi.interpolate`integrations/${integration.id}`;

  const jwt =
    cfg.oidcIssuer && cfg.oidcAudience
      ? new aws.apigatewayv2.Authorizer(name(cfg, 'jwt'), {
          apiId: api.id,
          authorizerType: 'JWT',
          identitySources: ['$request.header.Authorization'],
          jwtConfiguration: { issuer: cfg.oidcIssuer, audiences: [cfg.oidcAudience] },
        })
      : undefined;

  // Liveness/readiness stay open for load balancers and uptime checks.
  new aws.apigatewayv2.Route(name(cfg, 'route-health'), {
    apiId: api.id,
    routeKey: 'GET /health/{proxy+}',
    target,
    authorizationType: 'NONE',
  });
  // Everything else is IAM-authorized, or JWT-authorized when an OIDC issuer is configured.
  new aws.apigatewayv2.Route(name(cfg, 'route-default'), {
    apiId: api.id,
    routeKey: '$default',
    target,
    authorizationType: jwt ? 'JWT' : 'AWS_IAM',
    authorizerId: jwt?.id,
  });

  new aws.apigatewayv2.Stage(name(cfg, 'stage'), {
    apiId: api.id,
    name: '$default',
    autoDeploy: true,
    defaultRouteSettings: { throttlingBurstLimit: 200, throttlingRateLimit: 100 },
  });

  new aws.lambda.Permission(name(cfg, 'invoke'), {
    action: 'lambda:InvokeFunction',
    function: fn.name,
    principal: 'apigateway.amazonaws.com',
    sourceArn: pulumi.interpolate`${api.executionArn}/*/*`,
  });

  return { api, fn };
}
