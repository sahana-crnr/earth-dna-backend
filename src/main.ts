// Entry point of the application. Bootstraps the NestJS app, sets up global
// prefix, CORS, validation pipe, serialization interceptor, exception filter,
// and Swagger documentation at /docs.
import { NestFactory, Reflector } from '@nestjs/core';
import {
  ValidationPipe,
  ClassSerializerInterceptor,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { validateJwtSecret } from './config/validate-jwt-secret';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port') ?? 1234;
  const apiPrefix = config.get<string>('app.apiPrefix') ?? 'api/v1';
  const nodeEnv = config.get<string>('app.nodeEnv') ?? 'development';

  // Refuse to start rather than sign tokens with a known-public key.
  validateJwtSecret(config.get<string>('app.jwtSecret'));

  // ─── Global prefix ─────────────────────────────────────────────────────────
  app.setGlobalPrefix(apiPrefix);

  // ─── CORS ──────────────────────────────────────────────────────────────────
  app.enableCors({
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ─── Validation ────────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties
      forbidNonWhitelisted: true, // throw on unknown properties
      transform: true, // auto-transform payloads to DTO types
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ─── Serialization ─────────────────────────────────────────────────────────
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
    new ResponseInterceptor(),
  );

  // ─── Exception Filter ──────────────────────────────────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter());

  // ─── Swagger ───────────────────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Earth DNA API')
    .setDescription('REST API for the Earth DNA platform')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Enter your JWT access token (from /auth/login or /auth/register)',
      },
      'access-token', // ← named reference — must match @ApiBearerAuth('access-token')
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(
    `🚀 Application running on: http://localhost:${port}/${apiPrefix}`,
  );
  logger.log(`📖 Swagger docs:          http://localhost:${port}/docs`);
  logger.log(`📦 Environment: ${nodeEnv}`);
}

bootstrap();
