// Auth module. Bundles together the auth controller, service, JWT setup, and guard.
// Imports UserModule so AuthService can look up and create users.
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { StringValue } from 'ms';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GoogleTokenVerifier } from './google/google-token-verifier';
import { FacebookTokenVerifier } from './facebook/facebook-token-verifier';
import { AppleTokenVerifier } from './apple/apple-token-verifier';
import { JwksJwtVerifier } from './social/jwks-jwt-verifier';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    UserModule,
    TypeOrmModule.forFeature([RefreshTokenEntity]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('app.jwtSecret'),
        // expiresIn is a branded StringValue in @nestjs/jwt — cast required
        signOptions: {
          expiresIn: config.get<string>('app.jwtExpiresIn') as StringValue,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    RefreshTokenService,
    JwtAuthGuard,
    GoogleTokenVerifier,
    JwksJwtVerifier,
    FacebookTokenVerifier,
    AppleTokenVerifier,
  ],
})
export class AuthModule {}
