// Auth module. Bundles together the auth controller, service, JWT setup, and guard.
// Imports UserModule so AuthService can look up and create users.
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    UserModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('app.jwtSecret'),
        // expiresIn is a branded StringValue in @nestjs/jwt — cast required
        signOptions: {
          expiresIn: config.get<string>('app.jwtExpiresIn') as string,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
