// Root module of the application. Wires together config, database, and all
// feature modules (AuthModule, UserModule, ScanModule, CatalogModule).
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
  appConfig,
  databaseConfig,
  mailConfig,
  googleConfig,
  facebookConfig,
  appleConfig,
  storageConfig,
  scanConfig,
  catalogConfig,
  shoesConfig,
} from './config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { MailModule } from './mail/mail.module';
import { ScheduleModule } from '@nestjs/schedule';
import { ScanModule } from './scan/scan.module';
import { CatalogModule } from './catalog/catalog.module';
import { ShoesModule } from './shoes/shoes.module';

@Module({
  imports: [
    // ─── Config ──────────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [`.env.${process.env.NODE_ENV || 'local'}`, '.env'],
      load: [
        appConfig,
        databaseConfig,
        mailConfig,
        googleConfig,
        facebookConfig,
        appleConfig,
        storageConfig,
        scanConfig,
        catalogConfig,
        shoesConfig,
      ],
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

    // F1 scan sessions (+ daily abandon job, hence the scheduler).
    ScheduleModule.forRoot(),
    ScanModule,
    // F3 catalog lookups for the review form dropdowns.
    CatalogModule,

    // F5 — My Shoes profile, edit, photos, share, rescan, condition feedback
    ShoesModule,
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
