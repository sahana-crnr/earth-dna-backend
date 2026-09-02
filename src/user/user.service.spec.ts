import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserService } from './user.service';
import { UserEntity } from './entities/user.entity';

describe('UserService', () => {
  let service: UserService;
  let repo: jest.Mocked<
    Pick<Repository<UserEntity>, 'create' | 'save' | 'findOne'>
  >;

  beforeEach(async () => {
    repo = {
      create: jest.fn((dto) => dto as UserEntity),
      save: jest.fn(),
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(UserEntity), useValue: repo },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createGoogleUser', () => {
    it('creates a passwordless account tagged as google', async () => {
      repo.save.mockResolvedValue({ id: 'new-id' } as UserEntity);

      await service.createGoogleUser({
        email: 'jane@example.com',
        fullName: 'Jane Doe',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'jane@example.com',
          fullName: 'Jane Doe',
          password: null,
          country: null,
          authProvider: 'google',
        }),
      );
    });

    it('recovers from the concurrent-create race instead of throwing a 500', async () => {
      // Two simultaneous first-time sign-ins: both see findByEmail() return null,
      // both insert, and the unique constraint on email fails the loser.
      const winner = {
        id: 'winner-id',
        email: 'jane@example.com',
      } as UserEntity;
      repo.save.mockRejectedValue(
        Object.assign(new Error('duplicate'), {
          code: '23505',
        }),
      );
      repo.findOne.mockResolvedValue(winner);

      await expect(
        service.createGoogleUser({
          email: 'jane@example.com',
          fullName: 'Jane Doe',
        }),
      ).resolves.toBe(winner);
    });

    it('rethrows any error that is not a unique violation', async () => {
      repo.save.mockRejectedValue(
        Object.assign(new Error('connection lost'), { code: '08006' }),
      );

      await expect(
        service.createGoogleUser({
          email: 'jane@example.com',
          fullName: 'Jane Doe',
        }),
      ).rejects.toThrow('connection lost');
    });
  });
});
