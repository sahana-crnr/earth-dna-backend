// Object storage for scan photos (S3). Locally the endpoint points at LocalStack
// (path-style addressing); on dev/prod it is unset and the SDK talks to real S3
// using the task role's credentials.
//
// A missing bucket does NOT fall back to a default: the scan routes fail closed
// with 503 STORAGE_NOT_CONFIGURED while the rest of the API keeps working.
import { registerAs } from '@nestjs/config';
import { parseBool } from './scan.config';

export interface StorageConfig {
  bucket: string | null;
  endpoint: string | null;
  /**
   * Host used only when signing thumbnail URLs. Needed when the backend reaches
   * S3 by a name the browser cannot resolve (backend container → `localstack`).
   * Unset: signed URLs use `endpoint` (or real S3).
   */
  publicEndpoint: string | null;
  forcePathStyle: boolean;
  region: string;
  /**
   * Credentials sent ONLY when `endpoint` is set (local emulator). Dummy by
   * default so a developer's real AWS profile never reaches the emulator; MinIO
   * needs a real pair (8+ char secret), hence configurable. Ignored on dev/prod,
   * where the SDK uses the task role.
   */
  accessKey: string;
  secretKey: string;
}

export default registerAs(
  'storage',
  (): StorageConfig => ({
    bucket: nonEmpty(process.env.SHOE_PHOTOS_BUCKET),
    endpoint: nonEmpty(process.env.STORAGE_S3_ENDPOINT),
    publicEndpoint: nonEmpty(process.env.STORAGE_S3_PUBLIC_ENDPOINT),
    forcePathStyle: parseBool(process.env.STORAGE_S3_FORCE_PATH_STYLE, false),
    region: nonEmpty(process.env.AWS_REGION) ?? 'us-east-1',
    accessKey: nonEmpty(process.env.STORAGE_S3_ACCESS_KEY) ?? 'test',
    secretKey: nonEmpty(process.env.STORAGE_S3_SECRET_KEY) ?? 'test',
  }),
);

function nonEmpty(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return v.length > 0 ? v : null;
}
