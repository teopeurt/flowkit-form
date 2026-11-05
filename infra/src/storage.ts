import * as aws from '@pulumi/aws';

import { name, type DeployConfig } from './config';

/** Content store (spec §5.1): versioned, encrypted, private; blobs are immutable per version. */
export function createContentBucket(cfg: DeployConfig) {
  const bucket = new aws.s3.Bucket(
    name(cfg, 'content'),
    { forceDestroy: !cfg.retainData },
    { protect: cfg.retainData },
  );

  new aws.s3.BucketVersioning(name(cfg, 'content-versioning'), {
    bucket: bucket.id,
    versioningConfiguration: { status: 'Enabled' },
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(name(cfg, 'content-sse'), {
    bucket: bucket.id,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'aws:kms' }, bucketKeyEnabled: true }],
  });

  new aws.s3.BucketPublicAccessBlock(name(cfg, 'content-private'), {
    bucket: bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });

  new aws.s3.BucketLifecycleConfiguration(name(cfg, 'content-lifecycle'), {
    bucket: bucket.id,
    rules: [{ id: 'abort-incomplete-uploads', status: 'Enabled', abortIncompleteMultipartUpload: { daysAfterInitiation: 7 } }],
  });

  return bucket;
}
