// Root module of the application. Wires together config, database, and all
// feature modules (AuthModule, UserModule).
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { appConfig, databaseConfig, mailConfig, googleConfig } from './config';
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
      load: [appConfig, databaseConfig, mailConfig, googleConfig],
      cache: true,
    }),

    // forRoot sets the GLOBAL default for every route, not a per-route rule.
    // It used to read FORGOT_PASSWORD_THROTTLE_* and default to 3, which made it
    // look route-specific; combined with ThrottlerGuard never being registered,
    // that meant NO rate limiting happened anywhere. Registering the guard while
    // leaving the default at 3 would have capped the entire API at 3 req/min.
    //
    // So: a generous global default here, and strict per-route limits declared
    // with @Throttle() on the routes that need them (see auth.controller.ts).
    // The name 'default' is required for @Throttle({ default: ... }) to resolve.
    ThrottlerModule.forRoot([
      {
        name: 'default',
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
    // Without this, every @Throttle() decorator in the app is inert metadata and
    // no rate limiting occurs at all.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
