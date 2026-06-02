// Root module of the application. Wires together config, database, and all
// feature modules (AuthModule, UserModule).
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
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

    ThrottlerModule.forRoot([
      {
        ttl: parseInt(
          process.env.FORGOT_PASSWORD_THROTTLE_TTL_MS ?? '60000',
          10,
        ),
        limit: parseInt(process.env.FORGOT_PASSWORD_THROTTLE_LIMIT ?? '3', 10),
      },
    ]),

    // Throttling prevents brute-force attacks on password-reset endpoints.
    // Max 3 forgot-password requests per 60 seconds per IP to prevent email enumeration.
    // Applied via @Throttle() decorator on /auth/forgot-password route.

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
  providers: [AppService],
})
export class AppModule {}
