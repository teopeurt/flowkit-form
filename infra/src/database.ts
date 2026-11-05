import * as aws from '@pulumi/aws';

import { name, type DeployConfig } from './config';

/**
 * Aurora Serverless v2 (PostgreSQL). The application already uses PostgreSQL
 * (`packages/database`), so the same repositories and migrations apply.
 */
export function createDatabase(cfg: DeployConfig, securityGroupId: aws.ec2.SecurityGroup['id']) {
  const subnets = new aws.rds.SubnetGroup(name(cfg, 'db-subnets'), { subnetIds: cfg.privateSubnetIds });

  const cluster = new aws.rds.Cluster(
    name(cfg, 'db'),
    {
      engine: 'aurora-postgresql',
      engineMode: 'provisioned',
      databaseName: 'flowkitform',
      masterUsername: 'flowkitform',
      manageMasterUserPassword: true,
      storageEncrypted: true,
      dbSubnetGroupName: subnets.name,
      vpcSecurityGroupIds: [securityGroupId],
      deletionProtection: cfg.retainData,
      skipFinalSnapshot: !cfg.retainData,
      serverlessv2ScalingConfiguration: { minCapacity: cfg.dbMinAcu, maxCapacity: cfg.dbMaxAcu },
    },
    { protect: cfg.retainData },
  );

  new aws.rds.ClusterInstance(name(cfg, 'db-writer'), {
    clusterIdentifier: cluster.id,
    instanceClass: 'db.serverless',
    engine: 'aurora-postgresql',
  });

  return cluster;
}
