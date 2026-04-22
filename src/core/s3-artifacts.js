/**
 * Shared S3 client helper for release artifacts.
 * Returns { client, bucket } or null if not configured.
 */
function getArtifactsS3() {
  const bucket = process.env.RELEASE_ARTIFACTS_BUCKET;
  const region = process.env.RELEASE_ARTIFACTS_REGION || 'us-east-1';
  const accessKeyId = process.env.RELEASE_ARTIFACTS_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RELEASE_ARTIFACTS_AWS_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const { S3Client } = require('@aws-sdk/client-s3');
  return {
    client: new S3Client({ region, credentials: { accessKeyId, secretAccessKey } }),
    bucket,
  };
}

module.exports = { getArtifactsS3 };
