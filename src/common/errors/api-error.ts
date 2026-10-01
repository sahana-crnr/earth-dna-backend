// HttpException carrying a stable machine-readable `code` (and optional
// `details`) for the app to branch on. The global filter copies both into the
// error body next to `message`.
import { HttpException } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super({ message, code, ...(details ? { details } : {}) }, status);
  }
}
