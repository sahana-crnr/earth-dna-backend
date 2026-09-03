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

  /**
   * Creates a user from a verified Google identity.
   *
   * No password and no country: Google already proved who they are, and a Google
   * ID token carries no country. Both columns are nullable as of the
   * AddGoogleAuthSupport migration.
   *
   * Concurrency: two simultaneous first-time sign-ins for the same email both see
   * findByEmail() return null and both try to insert. The unique constraint on
   * email lets exactly one win. Rather than surfacing that as a 500, the loser
   * catches PostgreSQL unique_violation (23505) and re-reads the row the winner
   * just wrote. The database stays the source of truth; we just handle losing.
   */
  async createGoogleUser(params: {
    email: string;
    fullName: string;
  }): Promise<UserEntity> {
    const user = this.userRepo.create({
      email: params.email,
      fullName: params.fullName,
      password: null,
      country: null,
      countryCode: null,
      zipCode: null,
      authProvider: 'google',
    });

    try {
      return await this.userRepo.save(user);
    } catch (err) {
      if (!UserService.isUniqueViolation(err)) throw err;

      const existing = await this.findByEmail(params.email);
      if (existing) return existing;

      // The constraint fired but the row is not there - genuinely unexpected.
      throw err;
    }
  }

  /** PostgreSQL unique_violation. */
  private static isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === '23505'
    );
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
