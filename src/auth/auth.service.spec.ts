import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { ApiError } from '../common/errors/api-error';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { RefreshTokenService } from './refresh-token.service';
import { UserEntity } from '../user/entities/user.entity';
import { GoogleTokenVerifier } from './google/google-token-verifier';
import { FacebookTokenVerifier } from './facebook/facebook-token-verifier';
import { AppleTokenVerifier } from './apple/apple-token-verifier';
import { SocialIdentity } from './social/social-identity';

describe('AuthService', () => {
  let service: AuthService;
  let userService: jest.Mocked<
    Pick<
      UserService,
      | 'findByEmail'
      | 'findByEmailWithPassword'
      | 'create'
      | 'findById'
      | 'setResetToken'
      | 'clearResetToken'
      | 'findByResetToken'
      | 'updatePassword'
      | 'createGoogleUser'
      | 'findByProvider'
      | 'createSocialUser'
    >
  >;
  let mailService: jest.Mocked<Pick<MailService, 'sendPasswordResetEmail'>>;
  let googleVerifier: jest.Mocked<Pick<GoogleTokenVerifier, 'verify'>>;
  let facebookVerifier: jest.Mocked<Pick<FacebookTokenVerifier, 'verify'>>;
  let appleVerifier: jest.Mocked<Pick<AppleTokenVerifier, 'verify'>>;
  let jwtService: jest.Mocked<Pick<JwtService, 'sign'>>;
  let refreshTokenService: jest.Mocked<
    Pick<
      RefreshTokenService,
      'issue' | 'rotate' | 'revoke' | 'revokeAllForUser'
    >
  >;

  const mockUser: UserEntity = {
    id: 'user-uuid',
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    password: 'hashed',
    resetPasswordToken: null,
    resetPasswordExpiry: null,
    country: 'USA',
    countryCode: null,
    zipCode: null,
    authProvider: 'local',
    providerUserId: null,
    role: 'USER',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const facebookIdentity: SocialIdentity = {
    provider: 'facebook',
    providerUserId: 'fb-123',
    email: 'jane@example.com',
    fullName: 'Jane Doe',
  };
  const appleIdentity: SocialIdentity = {
    provider: 'apple',
    providerUserId: 'apple-001.abc',
    email: 'jane@privaterelay.appleid.com',
    fullName: 'Jane Doe',
  };

  beforeEach(async () => {
    userService = {
      findByEmail: jest.fn(),
      findByEmailWithPassword: jest.fn(),
      create: jest.fn(),
      findById: jest.fn(),
      setResetToken: jest.fn().mockResolvedValue(undefined),
      clearResetToken: jest.fn().mockResolvedValue(undefined),
      findByResetToken: jest.fn(),
      updatePassword: jest.fn().mockResolvedValue(undefined),
      createGoogleUser: jest.fn(),
      findByProvider: jest.fn().mockResolvedValue(null),
      createSocialUser: jest.fn(),
    };

    facebookVerifier = {
      verify: jest.fn().mockResolvedValue(facebookIdentity),
    };
    appleVerifier = { verify: jest.fn().mockResolvedValue(appleIdentity) };

    googleVerifier = {
      verify: jest.fn().mockResolvedValue({
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        emailVerified: true,
      }),
    };

    mailService = {
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    };

    refreshTokenService = {
      issue: jest.fn().mockResolvedValue('refresh-token'),
      rotate: jest
        .fn()
        .mockResolvedValue({ userId: 'user-uuid', rawToken: 'refresh-token' }),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: UserService,
          useValue: userService,
        },
        {
          provide: MailService,
          useValue: mailService,
        },
        {
          provide: RefreshTokenService,
          useValue: refreshTokenService,
        },
        {
          provide: JwtService,
          useValue: { sign: jest.fn().mockReturnValue('jwt-token') },
        },
        {
          provide: GoogleTokenVerifier,
          useValue: googleVerifier,
        },
        { provide: FacebookTokenVerifier, useValue: facebookVerifier },
        { provide: AppleTokenVerifier, useValue: appleVerifier },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const map: Record<string, unknown> = {
                'mail.resetTokenExpiryMinutes': 15,
                // The reset flow serves its HTML form from the BACKEND, so the
                // service reads mail.backendUrl + app.apiPrefix. The old mock
                // supplied mail.frontendUrl, which the service never reads.
                'mail.backendUrl': 'http://localhost:1234',
                'app.apiPrefix': 'api/v1',
                admin: {
                  email: 'admin@earthdna.test',
                  password: 'a-long-admin-password',
                  disabled: false,
                },
              };
              return map[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get(JwtService);
  });

  describe('register - ADMIN_EMAIL is reserved (F7)', () => {
    const dto = {
      fullName: 'Mallory',
      email: 'admin@earthdna.test',
      password: 'Password123!',
      country: 'USA',
    } as Parameters<AuthService['register']>[0];

    beforeEach(() => userService.findByEmail.mockResolvedValue(null));

    it.each(['admin@earthdna.test', 'Admin@EarthDNA.test'])(
      'answers %s with the same 409 as a taken email, before creating anything',
      async (email) => {
        const err = await service
          .register({ ...dto, email })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).message).toBe(
          'An account with this email already exists',
        );
        expect(userService.create).not.toHaveBeenCalled();
        expect(refreshTokenService.issue).not.toHaveBeenCalled();
      },
    );

    it('still registers any other address', async () => {
      userService.create.mockResolvedValue(mockUser);
      await expect(
        service.register({ ...dto, email: 'jane@example.com' }),
      ).resolves.toMatchObject({ accessToken: 'jwt-token' });
    });
  });

  describe('forgotPassword', () => {
    const GENERIC =
      'If an account with that email exists, a password reset link has been sent.';

    // T11: an unknown email must answer exactly like a known one, otherwise the
    // endpoint tells anyone which addresses have accounts.
    it('answers an unknown email exactly like a known one (T11)', async () => {
      userService.findByEmail.mockResolvedValue(null);
      const unknown = await service.forgotPassword('unknown@example.com');

      userService.findByEmail.mockResolvedValue(mockUser);
      const known = await service.forgotPassword(mockUser.email);

      expect(unknown).toEqual({ message: GENERIC });
      expect(known).toEqual(unknown);
      expect(userService.setResetToken).toHaveBeenCalledTimes(1);
      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    });

    it('stores hashed token and sends email when user exists', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.forgotPassword(mockUser.email);

      expect(result.message).toBe(GENERIC);
      expect(userService.setResetToken).toHaveBeenCalledWith(
        mockUser.id,
        expect.any(String),
        expect.any(Date),
      );
      // The emailed link points at the backend-hosted reset form, and carries
      // the RAW token — only its SHA-256 hash is handed to setResetToken.
      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        mockUser.email,
        expect.stringMatching(
          /^http:\/\/localhost:1234\/api\/v1\/auth\/reset-password\?token=[a-f0-9]{64}$/,
        ),
      );

      const [, storedToken] = userService.setResetToken.mock.calls[0];
      const [, resetUrl] = mailService.sendPasswordResetEmail.mock.calls[0];
      const rawToken = resetUrl.split('token=')[1];
      expect(storedToken).toBe(
        crypto.createHash('sha256').update(rawToken).digest('hex'),
      );
    });

    it('clears the token and still reports success when mail fails', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);
      mailService.sendPasswordResetEmail.mockRejectedValue(
        new Error('SES MessageRejected'),
      );

      const result = await service.forgotPassword(mockUser.email);

      expect(result.message).toBe(GENERIC);
      expect(userService.clearResetToken).toHaveBeenCalledWith(mockUser.id);
    });
  });

  describe('resetPassword', () => {
    it('updates password when token is valid', async () => {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto
        .createHash('sha256')
        .update(rawToken)
        .digest('hex');

      userService.findByResetToken.mockResolvedValue(mockUser);

      const result = await service.resetPassword(
        rawToken,
        'newPassword1',
        'newPassword1',
      );

      expect(result.message).toBe('Password updated successfully.');
      expect(userService.findByResetToken).toHaveBeenCalledWith(hashedToken);
      expect(userService.updatePassword).toHaveBeenCalledWith(
        mockUser.id,
        expect.any(String),
      );

      const [, hashedPassword] = userService.updatePassword.mock.calls[0];
      expect(await bcrypt.compare('newPassword1', hashedPassword)).toBe(true);
    });

    it('signs out every existing session after a reset', async () => {
      userService.findByResetToken.mockResolvedValue(mockUser);

      await service.resetPassword('raw-token', 'newPassword1', 'newPassword1');

      expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(
        mockUser.id,
      );
    });

    it('does not revoke sessions when the token is invalid', async () => {
      userService.findByResetToken.mockResolvedValue(null);

      await expect(
        service.resetPassword('bad', 'newPassword1', 'newPassword1'),
      ).rejects.toThrow(BadRequestException);
      expect(refreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('throws when token is invalid or expired', async () => {
      userService.findByResetToken.mockResolvedValue(null);

      await expect(
        service.resetPassword('invalid-token', 'newPassword1', 'newPassword1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Phase 2: the regression guard the migration made necessary ─────────────
  describe('login - null-password guard', () => {
    it('2.2 returns 401 (NOT 500) for a Google account with no password', async () => {
      // Before this guard, bcrypt.compare(pw, null) threw
      // "data and hash arguments required" and surfaced as a 500.
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUser,
        password: null,
        authProvider: 'google',
      });

      await expect(
        service.login({ email: mockUser.email, password: 'anything' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('keeps the message generic so Google accounts cannot be enumerated', async () => {
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUser,
        password: null,
        authProvider: 'google',
      });

      await expect(
        service.login({ email: mockUser.email, password: 'anything' }),
      ).rejects.toThrow('Invalid email or password');
    });
  });

  // ── Phase 5: the Google sign-in flow ───────────────────────────────────────
  describe('googleLogin', () => {
    it('6.2 signs in an existing user without creating a duplicate', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.googleLogin({ idToken: 'good' });

      expect(result.user).toEqual(mockUser);
      expect(result.accessToken).toBe('jwt-token');
      expect(userService.createGoogleUser).not.toHaveBeenCalled();
    });

    it('6.1 creates a new user when none exists', async () => {
      const created = {
        ...mockUser,
        password: null,
        country: null,
        authProvider: 'google' as const,
      };
      userService.findByEmail.mockResolvedValue(null);
      userService.createGoogleUser.mockResolvedValue(created);

      const result = await service.googleLogin({ idToken: 'good' });

      expect(userService.createGoogleUser).toHaveBeenCalledWith({
        email: 'jane@example.com',
        fullName: 'Jane Doe',
      });
      expect(result.user).toEqual(created);
    });

    it('links a Google sign-in onto an existing password account by email', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.googleLogin({ idToken: 'good' });

      // Safe only because the verifier refuses unverified emails.
      expect(result.user.id).toBe(mockUser.id);
      expect(userService.createGoogleUser).not.toHaveBeenCalled();
    });

    it('propagates verifier rejection and never touches the database', async () => {
      googleVerifier.verify.mockRejectedValue(
        new UnauthorizedException('Invalid Google token'),
      );

      await expect(service.googleLogin({ idToken: 'bad' })).rejects.toThrow(
        'Invalid Google token',
      );
      expect(userService.findByEmail).not.toHaveBeenCalled();
      expect(userService.createGoogleUser).not.toHaveBeenCalled();
    });

    it('signs the same JWT payload as the password login flow', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);
      await service.googleLogin({ idToken: 'good' });

      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });
    });
  });
  describe('social sign-in never lands in the admin account (F7)', () => {
    const admin = (): UserEntity => ({ ...mockUser, role: 'ADMIN' });
    const isAdminOnly = (e: unknown) =>
      e instanceof ApiError && e.code === 'ADMIN_PASSWORD_LOGIN_ONLY';

    it('Google: refuses to auto-link onto the admin by email', async () => {
      googleVerifier.verify.mockResolvedValue({
        provider: 'google',
        providerUserId: null,
        email: mockUser.email,
        fullName: 'X',
      } as unknown as Awaited<ReturnType<GoogleTokenVerifier['verify']>>);
      userService.findByEmail.mockResolvedValue(admin());
      const err = await service
        .googleLogin({ idToken: 'good' })
        .catch((e: unknown) => e);
      expect(isAdminOnly(err)).toBe(true);
      expect(refreshTokenService.issue).not.toHaveBeenCalled();
    });

    it('Facebook / Apple: refuses the admin account', async () => {
      facebookVerifier.verify.mockResolvedValue(facebookIdentity);
      userService.findByProvider.mockResolvedValue(null);
      userService.findByEmail.mockResolvedValue(admin());
      const err = await service
        .facebookLogin({ accessToken: 'tok' })
        .catch((e: unknown) => e);
      expect(isAdminOnly(err)).toBe(true);
      expect(refreshTokenService.issue).not.toHaveBeenCalled();
    });

    it('password login still works for the admin', async () => {
      userService.findByEmailWithPassword.mockResolvedValue({
        ...admin(),
        password: await bcrypt.hash('pw', 4),
      });
      await service.login({ email: mockUser.email, password: 'pw' });
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'ADMIN' }),
      );
    });
  });

  describe('facebookLogin / appleLogin (shared socialLogin)', () => {
    const created = (over: Partial<UserEntity>): UserEntity => ({
      ...mockUser,
      password: null,
      country: null,
      ...over,
    });

    it('finds the user by (provider, sub) first and never touches email lookup', async () => {
      const fbUser = created({
        authProvider: 'facebook',
        providerUserId: 'fb-123',
      });
      userService.findByProvider.mockResolvedValue(fbUser);

      const result = await service.facebookLogin({ accessToken: 'tok' }, 'ua');

      expect(userService.findByProvider).toHaveBeenCalledWith(
        'facebook',
        'fb-123',
      );
      expect(userService.findByEmail).not.toHaveBeenCalled();
      expect(userService.createSocialUser).not.toHaveBeenCalled();
      expect(result.user).toBe(fbUser);
      expect(refreshTokenService.issue).toHaveBeenCalledWith(fbUser.id, 'ua');
    });

    it('auto-links onto an existing password account by email without rewriting it', async () => {
      userService.findByProvider.mockResolvedValue(null);
      userService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.facebookLogin({ accessToken: 'tok' });

      expect(result.user.id).toBe(mockUser.id);
      expect(userService.createSocialUser).not.toHaveBeenCalled();
      // First provider wins: nothing is written back to the existing row.
      expect(userService.updatePassword).not.toHaveBeenCalled();
    });

    it('creates a new account carrying the provider user id', async () => {
      const fbUser = created({
        authProvider: 'facebook',
        providerUserId: 'fb-123',
      });
      userService.findByProvider.mockResolvedValue(null);
      userService.findByEmail.mockResolvedValue(null);
      userService.createSocialUser.mockResolvedValue(fbUser);

      const result = await service.facebookLogin({ accessToken: 'tok' });

      expect(userService.createSocialUser).toHaveBeenCalledWith({
        provider: 'facebook',
        providerUserId: 'fb-123',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
      });
      expect(result.user).toBe(fbUser);
      expect(result.accessToken).toBe('jwt-token');
    });

    it('rejects a brand-new Facebook identity that has no email with 422, not 500', async () => {
      facebookVerifier.verify.mockResolvedValue({
        ...facebookIdentity,
        email: null,
      });
      userService.findByProvider.mockResolvedValue(null);

      await expect(
        service.facebookLogin({ accessToken: 'tok' }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(userService.findByEmail).not.toHaveBeenCalled();
      expect(userService.createSocialUser).not.toHaveBeenCalled();
    });

    it('still signs in a known no-email Facebook user via the provider key', async () => {
      const fbUser = created({
        authProvider: 'facebook',
        providerUserId: 'fb-123',
      });
      facebookVerifier.verify.mockResolvedValue({
        ...facebookIdentity,
        email: null,
      });
      userService.findByProvider.mockResolvedValue(fbUser);

      await expect(
        service.facebookLogin({ accessToken: 'tok' }),
      ).resolves.toMatchObject({ user: fbUser });
    });

    it('passes the one-time Apple fullName hint through to the verifier', async () => {
      userService.findByProvider.mockResolvedValue(null);
      userService.findByEmail.mockResolvedValue(null);
      userService.createSocialUser.mockResolvedValue(
        created({ authProvider: 'apple', providerUserId: 'apple-001.abc' }),
      );

      await service.appleLogin({
        identityToken: 'tok',
        fullName: 'Kiran Jadhav',
      });

      expect(appleVerifier.verify).toHaveBeenCalledWith('tok', 'Kiran Jadhav');
      expect(userService.createSocialUser).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'apple',
          providerUserId: 'apple-001.abc',
        }),
      );
    });

    it('keeps the stored name for a returning Apple user even when the body has no name', async () => {
      const existing = created({
        authProvider: 'apple',
        providerUserId: 'apple-001.abc',
        fullName: 'Stored Name',
      });
      userService.findByProvider.mockResolvedValue(existing);

      const result = await service.appleLogin({ identityToken: 'tok' });

      expect(result.user.fullName).toBe('Stored Name');
      expect(userService.createSocialUser).not.toHaveBeenCalled();
    });

    it('propagates verifier rejection and never touches the database', async () => {
      appleVerifier.verify.mockRejectedValue(
        new UnauthorizedException('Invalid Apple token'),
      );

      await expect(
        service.appleLogin({ identityToken: 'bad' }),
      ).rejects.toThrow('Invalid Apple token');
      expect(userService.findByProvider).not.toHaveBeenCalled();
      expect(userService.findByEmail).not.toHaveBeenCalled();
    });

    it('signs the same JWT payload as the password login flow', async () => {
      userService.findByProvider.mockResolvedValue(mockUser);
      await service.facebookLogin({ accessToken: 'tok' });

      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: mockUser.id,
        email: mockUser.email,
        role: mockUser.role,
      });
    });
  });
});
