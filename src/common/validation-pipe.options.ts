// Options for the global ValidationPipe. Shared by main.ts and the DTO specs so
// the tests validate exactly the way production does.
import type { ValidationPipeOptions } from '@nestjs/common';

export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true, // strip unknown properties
  forbidNonWhitelisted: true, // throw on unknown properties
  transform: true, // auto-transform payloads to DTO types
  transformOptions: {
    enableImplicitConversion: true,
  },
};
