// Storage port for scan photos. The service depends on this abstract class, so
// tests swap in an in-memory fake and production uses S3PhotoStorage.

/** Thrown for any storage failure; the API maps it to a generic 502. */
export class StorageUnavailableError extends Error {
  constructor(operation: string, cause?: unknown) {
    super(`storage ${operation} failed`);
    this.name = 'StorageUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** Thrown when SHOE_PHOTOS_BUCKET is not set; the API maps it to 503. */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super('photo storage is not configured');
    this.name = 'StorageNotConfiguredError';
  }
}

export abstract class PhotoStorage {
  /** False when no bucket is configured; scan routes then fail closed. */
  abstract isConfigured(): boolean;
  abstract put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Deleting a key that does not exist is not an error. */
  abstract delete(key: string): Promise<void>;
  abstract signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
}
