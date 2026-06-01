// Auth service. Contains authentication logic — register, login, and profile.
// Register: checks duplicate email, hashes password, saves user, returns JWT.
// Login: verifies email + password, returns JWT on success.
// getProfile: fetches fresh user data from DB using the id from the JWT payload.
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UserEntity } from '../user/entities/user.entity';
import { AuthResponse } from './interfaces/auth-response.interface';

const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existing = await this.userService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);
    const user = await this.userService.create({
      ...dto,
      password: hashedPassword,
    });

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    return { accessToken, user };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    // Fetch user with password (select: false means it's excluded by default)
    const user = await this.userService.findByEmailWithPassword(dto.email);

    // Use a generic message for both cases to prevent user enumeration
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    // Remove password from the returned user object
    delete (user as Partial<typeof user>).password;

    return { accessToken, user };
  }

  getProfile(userId: string): Promise<UserEntity> {
    return this.userService.findById(userId);
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.userService.findByEmail(email);

    // Always return the same message to prevent user enumeration
    const message =
      'If that email is registered, a reset link has been sent.';

    if (!user) return { message };

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto
      .createHash('sha256')
      .update(rawToken)
      .digest('hex');

    const expiryMinutes = this.config.get<number>(
      'mail.resetTokenExpiryMinutes',
    )!;
    const expiry = new Date(Date.now() + expiryMinutes * 60 * 1000);

    await this.userService.setResetToken(user.id, hashedToken, expiry);

    const appUrl = this.config.get<string>('mail.appUrl');
    const resetUrl = `${appUrl}/reset-password?token=${rawToken}`;

    await this.mailService.sendPasswordResetEmail(user.email, resetUrl);

    return { message };
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const user = await this.userService.findByResetToken(hashedToken);
    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    await this.userService.updatePassword(user.id, hashedPassword);

    return { message: 'Password updated successfully.' };
  }
}
