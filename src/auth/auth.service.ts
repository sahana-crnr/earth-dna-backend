// Auth service. Contains authentication logic — register, login, and profile.
// Register: checks duplicate email, hashes password, saves user, returns JWT.
// Login: verifies email + password, returns JWT on success.
// getProfile: fetches fresh user data from DB using the id from the JWT payload.
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { GoogleTokenVerifier } from './google/google-token-verifier';
import { UserEntity } from '../user/entities/user.entity';
import { AuthResponse } from './interfaces/auth-response.interface';

const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly config: ConfigService,
    private readonly googleVerifier: GoogleTokenVerifier,
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

    // Google-created accounts have no password. bcrypt.compare() throws
    // "data and hash arguments required" on a null hash, which would surface as a
    // 500 on a completely ordinary user action. The message stays generic so this
    // does not become a way to discover which addresses are Google accounts.
    if (!user.password) {
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

  /**
   * Signs a user in with a Google ID token.
   *
   * Returns exactly the same shape as login(): the mobile app treats both
   * responses identically, with no special-casing.
   *
   * Accounts are linked by verified email - if someone registered with a password
   * and later signs in with Google using the same address, they land in their
   * existing account. That is safe only because GoogleTokenVerifier refuses any
   * token whose email is not verified by Google.
   */
  async googleLogin(dto: GoogleLoginDto): Promise<AuthResponse> {
    const identity = await this.googleVerifier.verify(dto.idToken);

    const existing = await this.userService.findByEmail(identity.email);
    const user =
      existing ??
      (await this.userService.createGoogleUser({
        email: identity.email,
        fullName: identity.fullName,
      }));

    if (!existing) {
      this.logger.log(`Created account from Google sign-in: ${user.email}`);
    }

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    return { accessToken, user };
  }

  getProfile(userId: string): Promise<UserEntity> {
    return this.userService.findById(userId);
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.userService.findByEmail(email);

    // Always return the same message to prevent user enumeration
    const message = 'If that email is registered, a reset link has been sent.';

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

    const backendUrl = this.config.get<string>('mail.backendUrl');
    const apiPrefix = this.config.get<string>('app.apiPrefix');
    const resetUrl = `${backendUrl}/${apiPrefix}/auth/reset-password?token=${rawToken}`;

    try {
      await this.mailService.sendPasswordResetEmail(user.email, resetUrl);
    } catch (err) {
      await this.userService.clearResetToken(user.id);
      this.logger.error(
        `Failed to send password reset email to ${user.email}`,
        err instanceof Error ? err.stack : String(err),
      );
      // Same response as success to avoid leaking whether the account exists or mail failed.
    }

    return { message };
  }

  async resetPassword(
    token: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<{ message: string }> {
    if (newPassword !== confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await this.userService.findByResetToken(hashedToken);
    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    await this.userService.updatePassword(user.id, hashedPassword);

    return { message: 'Password updated successfully.' };
  }
}
