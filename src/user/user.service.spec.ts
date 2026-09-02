import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserService } from './user.service';
import { UserEntity } from './entities/user.entity';

describe('UserService', () => {
  let service: UserService;
  let userRepo: jest.Mocked<Pick<Repository<UserEntity>, 'findOne'>>;

  beforeEach(async () => {
    userRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getRepositoryToken(UserEntity),
          useValue: userRepo,
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findById', () => {
    it('throws when the user does not exist', async () => {
      userRepo.findOne.mockResolvedValue(null);

      await expect(service.findById('missing-uuid')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
