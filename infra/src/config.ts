import * as pulumi from '@pulumi/pulumi';

export interface DeployConfig {
  stack: string;
  vpcId: string;
  privateSubnetIds: string[];
  apiImageUri: string;
  workerImageUri: string;
  temporalAddress: string;
  temporalNamespace: string;
  /** Optional OIDC issuer; when set, a JWT authorizer is added next to IAM auth (spec §9). */
  oidcIssuer?: string;
  oidcAudience?: string;
  /** Minimum Aurora capacity; 0 enables auto-pause (scale to zero). */
  dbMinAcu: number;
  dbMaxAcu: number;
  retainData: boolean;
}

export function loadConfig(): DeployConfig {
  const config = new pulumi.Config();
  return {
    stack: pulumi.getStack(),
    vpcId: config.require('vpcId'),
    privateSubnetIds: config.requireObject<string[]>('privateSubnetIds'),
    apiImageUri: config.require('apiImageUri'),
    workerImageUri: config.require('workerImageUri'),
    temporalAddress: config.require('temporalAddress'),
    temporalNamespace: config.require('temporalNamespace'),
    oidcIssuer: config.get('oidcIssuer'),
    oidcAudience: config.get('oidcAudience'),
    dbMinAcu: config.getNumber('dbMinAcu') ?? 0.5,
    dbMaxAcu: config.getNumber('dbMaxAcu') ?? 4,
    retainData: config.getBoolean('retainData') ?? true,
  };
}

export const name = (cfg: Pick<DeployConfig, 'stack'>, part: string) => `flowkitform-${cfg.stack}-${part}`;
