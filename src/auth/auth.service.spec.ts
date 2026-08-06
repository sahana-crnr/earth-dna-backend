import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { MailService } from '../mail/mail.service';
import { RefreshTokenService } from './refresh-token.service';
import { UserEntity } from '../user/entities/user.entity';

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
    >
  >;
  let mailService: jest.Mocked<Pick<MailService, 'sendPasswordResetEmail'>>;
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
    zipCode: null,
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
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const map: Record<string, unknown> = {
                'mail.resetTokenExpiryMinutes': 15,
                'mail.backendUrl': 'http://localhost:3000',
                'app.apiPrefix': 'api/v1',
              };
              return map[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('forgotPassword', () => {
    it('throws when user does not exist', async () => {
      userService.findByEmail.mockResolvedValue(null);

      await expect(
        service.forgotPassword('unknown@example.com'),
      ).rejects.toThrow(BadRequestException);

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
          /^http:\/\/localhost:3000\/api\/v1\/auth\/reset-password\?token=[a-f0-9]{64}$/,
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
});
