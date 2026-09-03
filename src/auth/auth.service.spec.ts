import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { RefreshTokenService } from './refresh-token.service';
import { UserEntity } from '../user/entities/user.entity';
import { GoogleTokenVerifier } from './google/google-token-verifier';

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
    >
  >;
  let mailService: jest.Mocked<Pick<MailService, 'sendPasswordResetEmail'>>;
  let googleVerifier: jest.Mocked<Pick<GoogleTokenVerifier, 'verify'>>;
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
    createdAt: new Date(),
    updatedAt: new Date(),
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
    };

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

  describe('forgotPassword', () => {
    // NOTE: this test documents CURRENT behaviour, which changed on develop in
    // commit 247e70b. It is NOT an endorsement of it.
    //
    // forgotPassword now throws BadRequestException('Email not found') for an
    // unknown address, while a known address returns 200. That difference lets
    // anyone enumerate which emails have accounts. The original code returned an
    // identical message either way, with the comment "Always return the same
    // message to prevent user enumeration" - and auth.controller.ts:309 still
    // claims that guarantee, which is no longer true.
    //
    // Tracked as T11. Change this test if the behaviour is reverted.
    it('throws for an unknown email (see T11 - enumeration risk)', async () => {
      userService.findByEmail.mockResolvedValue(null);

      await expect(
        service.forgotPassword('unknown@example.com'),
      ).rejects.toThrow('Email not found');

      expect(userService.setResetToken).not.toHaveBeenCalled();
      expect(mailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('stores hashed token and sends email when user exists', async () => {
      userService.findByEmail.mockResolvedValue(mockUser);

      const result = await service.forgotPassword(mockUser.email);

      expect(result.message).toContain('Password reset link has been sent');
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

      expect(result.message).toContain('Password reset link has been sent');
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
      });
    });
  });
});
