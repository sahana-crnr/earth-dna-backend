// Scan-route error filter. Multer raises generic 413/400 errors before the
// handler runs; this gives them stable codes, then defers to the global format.
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import { AllExceptionsFilter } from '../common/filters/http-exception.filter';
import { ApiError } from '../common/errors/api-error';

const MULTER_400: Record<string, [string, number, string]> = {
  'Too many files': [
    'BATCH_TOO_LARGE',
    HttpStatus.PAYLOAD_TOO_LARGE,
    'Too many photos in one upload',
  ],
  'Too many parts': [
    'BATCH_TOO_LARGE',
    HttpStatus.PAYLOAD_TOO_LARGE,
    'Too many parts in one upload',
  ],
  'Too many fields': [
    'BATCH_TOO_LARGE',
    HttpStatus.PAYLOAD_TOO_LARGE,
    'Too many fields in one upload',
  ],
  'Field value too long': [
    'MANIFEST_TOO_LARGE',
    HttpStatus.PAYLOAD_TOO_LARGE,
    'A text field is too long',
  ],
  'Unexpected file field': [
    'UNEXPECTED_FILE_FIELD',
    HttpStatus.BAD_REQUEST,
    "Send the photo in a part named 'file'",
  ],
  'Unexpected field': [
    'UNEXPECTED_FILE_FIELD',
    HttpStatus.BAD_REQUEST,
    "Send the photo in a part named 'file'",
  ],
};

@Catch()
export class ScanHttpErrorFilter extends AllExceptionsFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    super.catch(mapMulter(exception), host);
  }
}

export function mapMulter(exception: unknown): unknown {
  if (exception instanceof ApiError) return exception;
  if (exception instanceof PayloadTooLargeException) {
    return new ApiError(
      HttpStatus.PAYLOAD_TOO_LARGE,
      'FILE_TOO_LARGE',
      'Photo is larger than the allowed size',
    );
  }
  if (exception instanceof BadRequestException) {
    const res = exception.getResponse();
    const msg =
      typeof res === 'object' && res && 'message' in res ? res.message : res;
    // Multer wording differs between releases ("Unexpected field" vs
    // "Unexpected file field - photo"), so match on the start of the message.
    const hit =
      typeof msg === 'string'
        ? Object.entries(MULTER_400).find(([k]) => msg.startsWith(k))?.[1]
        : undefined;
    if (hit) return new ApiError(hit[1], hit[0], hit[2]);
  }
  return exception;
}
