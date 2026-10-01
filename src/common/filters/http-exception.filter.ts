// Global exception filter. Catches every thrown exception and returns a
// consistent JSON error response: { statusCode, timestamp, path, message }.
// When the exception carries a `code` (see common/errors/api-error.ts) it is
// added as `code`, plus `details` when present. Other responses are unchanged.
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    this.logger.error(
      `${request.method} ${request.url} → ${status}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    const body =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)
        : null;

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: body && 'message' in body ? body.message : message,
      ...(body && typeof body.code === 'string' ? { code: body.code } : {}),
      ...(body && body.details !== undefined ? { details: body.details } : {}),
    });
  }
}
