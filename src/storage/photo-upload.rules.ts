// One answer to "is this upload acceptable" for every photo route: F1 scan
// views (E6, E8) and F5 shoe photos (E27). Type comes from the bytes, never
// from the file name or the declared Content-Type (both client-controlled).
import { HttpStatus } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import type { PhotoType } from '../config/scan.config';
import { checkPhoto, sniffImageType } from '../scan/scan-rules';

/** Minimal file shape (subset of Express.Multer.File) the services need. */
export interface UploadedPhoto {
  fieldname: string;
  buffer: Buffer;
  size: number;
}

export interface PhotoLimits {
  photoMaxBytes: number;
  allowedTypes: readonly PhotoType[];
}

/** Returns the detected type or throws the documented ApiError. */
export function validateUploadedPhoto(
  file: UploadedPhoto | undefined,
  limits: PhotoLimits,
): PhotoType {
  const type = file ? sniffImageType(file.buffer) : null;
  const rejection = checkPhoto(file ? { size: file.size, type } : undefined, {
    photoMaxBytes: limits.photoMaxBytes,
    allowedTypes: limits.allowedTypes,
  });
  if (rejection === 'FILE_REQUIRED') {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      'FILE_REQUIRED',
      'A photo file is required',
    );
  }
  if (rejection === 'FILE_TOO_LARGE') {
    throw new ApiError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'FILE_TOO_LARGE',
      `Photo must be at most ${limits.photoMaxBytes} bytes`,
    );
  }
  if (rejection === 'UNSUPPORTED_TYPE') {
    throw new ApiError(
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      'UNSUPPORTED_TYPE',
      `Photo must be one of: ${limits.allowedTypes.join(', ')}`,
    );
  }
  return type!;
}
