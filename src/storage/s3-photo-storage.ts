// S3 implementation of PhotoStorage. Locally STORAGE_S3_ENDPOINT points at an
// S3 emulator (MinIO in local-infra) and the STORAGE_S3_ACCESS_KEY / SECRET_KEY
// pair is used (dummy `test`/`test` by default), so a developer's real AWS
// profile is never sent to the emulator. On dev/prod the endpoint is unset and
// the SDK uses the ECS task role.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageConfig } from '../config/storage.config';
import {
  PhotoStorage,
  StorageNotConfiguredError,
  StorageUnavailableError,
} from './photo-storage';

@Injectable()
export class S3PhotoStorage extends PhotoStorage {
  private readonly logger = new Logger(S3PhotoStorage.name);
  private readonly bucket: string | null;
  private readonly client: S3Client | null;
  /** Same as `client` unless STORAGE_S3_PUBLIC_ENDPOINT is set. */
  private readonly signer: S3Client | null;

  constructor(config: ConfigService) {
    super();
    const cfg = config.get<StorageConfig>('storage');
    this.bucket = cfg?.bucket ?? null;
    const make = (endpoint: string | null | undefined) =>
      new S3Client({
        region: cfg?.region ?? 'us-east-1',
        ...(endpoint
          ? {
              endpoint,
              forcePathStyle: cfg?.forcePathStyle ?? false,
              credentials: {
                accessKeyId: cfg?.accessKey ?? 'test',
                secretAccessKey: cfg?.secretKey ?? 'test',
              },
            }
          : {}),
      });
    this.client = this.bucket ? make(cfg?.endpoint) : null;
    this.signer =
      this.bucket && cfg?.publicEndpoint
        ? make(cfg.publicEndpoint)
        : this.client;
    if (!this.bucket) {
      this.logger.warn(
        'SHOE_PHOTOS_BUCKET is not set — /scans routes will answer 503',
      );
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const client = this.requireClient();
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket!,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      this.logger.error(`put ${key} failed: ${describe(err)}`);
      throw new StorageUnavailableError('put', err);
    }
  }

  async delete(key: string): Promise<void> {
    const client = this.requireClient();
    try {
      await client.send(
        new DeleteObjectCommand({ Bucket: this.bucket!, Key: key }),
      );
    } catch (err) {
      this.logger.error(`delete ${key} failed: ${describe(err)}`);
      throw new StorageUnavailableError('delete', err);
    }
  }

  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    this.requireClient();
    const client = this.signer!;
    try {
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: this.bucket!, Key: key }),
        { expiresIn: ttlSeconds },
      );
    } catch (err) {
      this.logger.error(`sign ${key} failed: ${describe(err)}`);
      throw new StorageUnavailableError('sign', err);
    }
  }

  private requireClient(): S3Client {
    if (!this.client) throw new StorageNotConfiguredError();
    return this.client;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
