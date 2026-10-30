import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Thin wrapper around S3 so the rest of the code (and the tests) only see two functions:
 *   presignPut({ key, contentType, sizeBytes, expiresIn }) -> URL the browser PUTs the file to
 *   publicUrl(key) -> URL the image is served from
 * Credentials are resolved by the AWS SDK from the environment; they never appear in our code.
 * Presigning is a local computation (no network call), so this works without reaching AWS.
 */
export function createStorage({ region, bucket, publicBaseUrl }) {
  const client = new S3Client({ region });
  const base = (publicBaseUrl ?? `https://${bucket}.s3.${region}.amazonaws.com`).replace(
    /\/+$/,
    '',
  );

  return {
    bucket,
    publicUrl: (key) => `${base}/${key}`,
    presignPut({ key, contentType, sizeBytes, expiresIn }) {
      // ContentLength is part of the signature: S3 rejects an upload whose size differs from
      // what we approved, which is how the 5 MB limit is enforced server-side. The same goes for
      // the content type (see signableHeaders below).
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      });
      // content-type is not signed by default; signableHeaders makes S3 reject any other type too.
      return getSignedUrl(client, command, {
        expiresIn,
        signableHeaders: new Set(['content-type']),
      });
    },
  };
}
