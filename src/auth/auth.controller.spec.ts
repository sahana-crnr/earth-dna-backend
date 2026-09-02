import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<
    Pick<AuthService, 'login' | 'register' | 'googleLogin' | 'getProfile'>
  >;

  beforeEach(async () => {
    authService = {
      login: jest.fn(),
      register: jest.fn(),
      googleLogin: jest.fn(),
      getProfile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /auth/google', () => {
    it('delegates to AuthService.googleLogin with the idToken', async () => {
      const response = {
        accessToken: 'jwt-token',
        user: { email: 'jane@example.com' },
      };
      authService.googleLogin.mockResolvedValue(response as never);

      await expect(
        controller.googleLogin({ idToken: 'a-google-id-token' }),
      ).resolves.toBe(response);

      expect(authService.googleLogin).toHaveBeenCalledWith({
        idToken: 'a-google-id-token',
      });
    });

    it('propagates errors so the global filter renders them', async () => {
      authService.googleLogin.mockRejectedValue(
        new Error('Invalid Google token'),
      );

      await expect(controller.googleLogin({ idToken: 'bad' })).rejects.toThrow(
        'Invalid Google token',
      );
    });
  });
});
