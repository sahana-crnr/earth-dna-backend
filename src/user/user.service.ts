// User service. Handles all database operations for the users table —
// finding by email, finding by id, finding with password for auth, and creating records.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { UserEntity } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async findById(id: string): Promise<UserEntity> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  // Explicitly selects the password column (select: false by default).
  // Only use this method when you need to verify a password (i.e. login).
  findByEmailWithPassword(email: string): Promise<UserEntity | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('user.email = :email', { email })
      .getOne();
  }

  create(dto: CreateUserDto): Promise<UserEntity> {
    const user = this.userRepo.create(dto);
    return this.userRepo.save(user);
  }

  setResetToken(
    userId: string,
    hashedToken: string,
    expiry: Date,
  ): Promise<void> {
    return this.userRepo
      .update(userId, {
        resetPasswordToken: hashedToken,
        resetPasswordExpiry: expiry,
      })
      .then(() => undefined);
  }

  clearResetToken(userId: string): Promise<void> {
    return this.userRepo
      .update(userId, {
        resetPasswordToken: null,
        resetPasswordExpiry: null,
      })
      .then(() => undefined);
  }

  findByResetToken(hashedToken: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: {
        resetPasswordToken: hashedToken,
        resetPasswordExpiry: MoreThan(new Date()),
      },
    });
  }

  async updatePassword(userId: string, hashedPassword: string): Promise<void> {
    await this.userRepo.update(userId, {
      password: hashedPassword,
      resetPasswordToken: null,
      resetPasswordExpiry: null,
    });
  }
}
