// Global response interceptor. Wraps every successful response in a standard
// envelope: { statusCode, message, data, timestamp }.
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface ApiResponse<T> {
  statusCode: number;
  message: string;
  data: T;
  timestamp: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T>> {
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => ({
        // Read AFTER the handler, not before. @HttpCode is already applied by
        // the time intercept() runs, so static routes are unaffected — but a
        // handler that sets the status itself (the F2 result submit answers 201
        // on create, 200 on replace) would otherwise put a number in the body
        // that contradicts the status line.
        statusCode: response.statusCode,
        message: 'Success',
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
