// The four storage moves every photo-owning service makes, written once
// (PR 15 review): fail closed when no bucket is configured, turn a put failure
// into the documented 502, never let a delete or a signing failure fail the
// request that triggered it. ScanService (F1), ShoesService (F5) and
// ShoeViewMapper (F3/F4 cards) all delegate here.
import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import {
  PhotoStorage,
  StorageNotConfiguredError,
  StorageUnavailableError,
} from './photo-storage';

/** 503 STORAGE_NOT_CONFIGURED unless a bucket is set. */
export function requireStorage(storage: PhotoStorage): void {
  if (!storage.isConfigured()) {
    throw new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'STORAGE_NOT_CONFIGURED',
      'Photo storage is not available',
    );
  }
}

/** Writes the object or throws 502 STORAGE_UNAVAILABLE (503 when unconfigured). */
export async function putOrThrow(
  storage: PhotoStorage,
  logger: Logger,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  try {
    await storage.put(key, body, contentType);
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) requireStorage(storage);
    logger.error(
      `put ${key} failed: ${err instanceof StorageUnavailableError ? err.message : String(err)}`,
    );
    throw new ApiError(
      HttpStatus.BAD_GATEWAY,
      'STORAGE_UNAVAILABLE',
      'Photo storage failed, try again',
    );
  }
}

/** Best-effort delete: logged, never thrown. */
export async function safeDelete(
  storage: PhotoStorage,
  logger: Logger,
  key: string,
): Promise<void> {
  try {
    await storage.delete(key);
  } catch (err) {
    logger.warn(`could not delete ${key}: ${String(err)}`);
  }
}

/** Signed GET URL, or null when unconfigured or signing fails. */
export async function signOrNull(
  storage: PhotoStorage,
  logger: Logger,
  key: string,
  ttlSeconds: number,
): Promise<string | null> {
  if (!storage.isConfigured()) return null;
  try {
    return await storage.signedGetUrl(key, ttlSeconds);
  } catch (err) {
    logger.warn(`could not sign ${key}: ${String(err)}`);
    return null;
  }
}
