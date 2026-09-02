// Root module of the application. Wires together config, database, and all
// feature modules (AuthModule, UserModule).
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { appConfig, databaseConfig, mailConfig } from './config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { MailModule } from './mail/mail.module';

@Module({
  imports: [
    // ─── Config ──────────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.NODE_ENV || 'local'}`, '.env'],
      load: [appConfig, databaseConfig, mailConfig],
      cache: true,
    }),

    // Baseline rate limit applied to every route by the global ThrottlerGuard
    // below. Routes needing something stricter override it with @Throttle() —
    // e.g. /auth/forgot-password is pinned to 3 requests per 60s to prevent
    // email enumeration and brute-force attempts.
    // Note: the default storage is in-memory, so limits are per container.
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
        limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
      },
    ]),

    // ─── Database ─────────────────────────────────────────────────────────────
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions =>
        config.get<TypeOrmModuleOptions>('database') as TypeOrmModuleOptions,
    }),

    MailModule,

    AuthModule,

    UserModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Enforces ThrottlerModule limits on every route. Without this the
    // @Throttle() decorators have no effect.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
