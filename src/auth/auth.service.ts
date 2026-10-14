// Auth service. Contains authentication logic — register, login, and profile.
// Register: checks duplicate email, hashes password, saves user, returns JWT.
// Login: verifies email + password, returns JWT on success.
// getProfile: fetches fresh user data from DB using the id from the JWT payload.
import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
  UnprocessableEntityException,
  Logger,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { RefreshTokenService } from './refresh-token.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { FacebookLoginDto } from './dto/facebook-login.dto';
import { AppleLoginDto } from './dto/apple-login.dto';
import { GoogleTokenVerifier } from './google/google-token-verifier';
import { FacebookTokenVerifier } from './facebook/facebook-token-verifier';
import { AppleTokenVerifier } from './apple/apple-token-verifier';
import { SocialIdentity } from './social/social-identity';
import { UserEntity } from '../user/entities/user.entity';
import { AuthResponse } from './interfaces/auth-response.interface';
import { ApiError } from '../common/errors/api-error';

export const BCRYPT_SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly config: ConfigService,
    private readonly googleVerifier: GoogleTokenVerifier,
    private readonly facebookVerifier: FacebookTokenVerifier,
    private readonly appleVerifier: AppleTokenVerifier,
  ) {}

  // `role` (F7) is for the client only - RolesGuard re-reads it from the DB, so
  // a demotion takes effect before this token expires.
  private signAccessToken(user: UserEntity): string {
    return this.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
  }

  // Signs a short-lived access JWT and issues a rotating refresh token.
  // Used by register, login, and refresh so token issuance stays consistent.
  private async issueTokens(
    user: UserEntity,
    userAgent?: string,
  ): Promise<AuthResponse> {
    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.refreshTokenService.issue(
      user.id,
      userAgent,
    );

    return { accessToken, refreshToken, user };
  }

  // Social sign-in auto-links by email, so without this anyone holding a
  // provider identity for ADMIN_EMAIL would get an admin session without the
  // admin password. The admin signs in with POST /auth/login only (F7).
  private issueSocialTokens(
    user: UserEntity,
    userAgent?: string,
  ): Promise<AuthResponse> {
    if (user.role === 'ADMIN') {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        'ADMIN_PASSWORD_LOGIN_ONLY',
        'This account must sign in with email and password',
      );
    }
    return this.issueTokens(user, userAgent);
  }

  async register(dto: RegisterDto, userAgent?: string): Promise<AuthResponse> {
    const existing = await this.userService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);
    const user = await this.userService.create({
      ...dto,
      password: hashedPassword,
    });

    return this.issueTokens(user, userAgent);
  }

  async login(dto: LoginDto, userAgent?: string): Promise<AuthResponse> {
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

    // Remove password from the returned user object
    delete (user as Partial<typeof user>).password;

    return this.issueTokens(user, userAgent);
  }

  // Rotates the presented refresh token and mints a fresh access token.
  async refresh(rawToken: string, userAgent?: string): Promise<AuthResponse> {
    const { userId, rawToken: refreshToken } =
      await this.refreshTokenService.rotate(rawToken, userAgent);
    const user = await this.userService.findById(userId);

    const accessToken = this.signAccessToken(user);

    return { accessToken, refreshToken, user };
  }

  // Revokes a single session (the one owning the presented refresh token).
  async logout(rawToken: string): Promise<{ message: string }> {
    await this.refreshTokenService.revoke(rawToken);
    return { message: 'Logged out successfully.' };
  }

  // Revokes every active session for the user (all devices).
  async logoutAll(userId: string): Promise<{ message: string }> {
    await this.refreshTokenService.revokeAllForUser(userId);
    return { message: 'Logged out of all sessions successfully.' };
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
  async googleLogin(
    dto: GoogleLoginDto,
    userAgent?: string,
  ): Promise<AuthResponse> {
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

    // Same token issuance as login()/register() - so the response carries a
    // refreshToken too and the app needs no special-casing.
    return this.issueSocialTokens(user, userAgent);
  }

  /**
   * Signs a user in with a Facebook token (Limited Login JWT on iOS, classic
   * access token on Android - the verifier tells them apart).
   */
  async facebookLogin(
    dto: FacebookLoginDto,
    userAgent?: string,
  ): Promise<AuthResponse> {
    const identity = await this.facebookVerifier.verify(dto.accessToken);
    return this.socialLogin(identity, userAgent);
  }

  /**
   * Signs a user in with an Apple identity token. The optional fullName in the
   * body is Apple's one-time name delivery and only matters on account creation.
   */
  async appleLogin(
    dto: AppleLoginDto,
    userAgent?: string,
  ): Promise<AuthResponse> {
    const identity = await this.appleVerifier.verify(
      dto.identityToken,
      dto.fullName,
    );
    return this.socialLogin(identity, userAgent);
  }

  /**
   * Shared find-or-link-or-create for providers that give us a stable user ID.
   *
   * Lookup order:
   *   1. (provider, providerUserId) - the provider's own stable key. Survives an
   *      email change or an Apple relay address being turned off.
   *   2. email - auto-link onto an existing local/Google/other account. First
   *      provider wins: the existing row is NOT rewritten, so a Google-created
   *      account stays a Google account and next time we simply fall through to
   *      this step again. Safe because every verifier only passes through
   *      provider-confirmed addresses.
   *   3. create.
   *
   * A brand-new identity with no email cannot be created: email is the unique
   * key the rest of the system (profile, password reset, the app's session
   * store) relies on. 422 rather than 401 - the token was perfectly valid, the
   * account just lacks what we need, and the message is actionable for the user.
   */
  private async socialLogin(
    identity: SocialIdentity,
    userAgent?: string,
  ): Promise<AuthResponse> {
    const label = identity.provider === 'apple' ? 'Apple' : 'Facebook';

    let user = await this.userService.findByProvider(
      identity.provider,
      identity.providerUserId,
    );

    if (!user && identity.email) {
      user = await this.userService.findByEmail(identity.email);
    }

    if (!user) {
      if (!identity.email) {
        this.logger.warn(
          `${label} sign-in rejected: no email on account ${identity.providerUserId}`,
        );
        throw new UnprocessableEntityException(
          `Your ${label} account has no email address. Please sign up with email instead.`,
        );
      }
      user = await this.userService.createSocialUser({
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        email: identity.email,
        fullName: identity.fullName,
      });
      this.logger.log(`Created account from ${label} sign-in: ${user.email}`);
    }

    return this.issueSocialTokens(user, userAgent);
  }

  getProfile(userId: string): Promise<UserEntity> {
    return this.userService.findById(userId);
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.userService.findByEmail(email);

    if (!user) {
      throw new BadRequestException('Email not found');
    }

    const message = 'Password reset link has been sent to your email.';

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
