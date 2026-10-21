// User service. Handles all database operations for the users table —
// finding by email, finding by id, finding with password for auth, and creating records.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Raw, Repository } from 'typeorm';
import { UserEntity, SocialProvider } from './entities/user.entity';
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

  // Case-insensitive: accounts registered before emails were normalised may
  // be stored mixed-case. LOWER() rather than ILIKE, since ILIKE treats the
  // "_" common in emails as a wildcard.
  findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: {
        email: Raw((column) => `LOWER(${column}) = LOWER(:email)`, { email }),
      },
    });
  }

  // Explicitly selects the password column (select: false by default).
  // Only use this method when you need to verify a password (i.e. login).
  findByEmailWithPassword(email: string): Promise<UserEntity | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password')
      .where('LOWER(user.email) = LOWER(:email)', { email })
      .getOne();
  }

  create(dto: CreateUserDto): Promise<UserEntity> {
    const user = this.userRepo.create(dto);
    return this.userRepo.save(user);
  }

  /** Finds the account a social provider's stable user ID (`sub`) is bound to. */
  findByProvider(
    provider: SocialProvider,
    providerUserId: string,
  ): Promise<UserEntity | null> {
    return this.userRepo.findOne({
      where: { authProvider: provider, providerUserId },
    });
  }

  /**
   * Creates a user from a verified Google identity.
   *
   * Kept as a named entry point so the Google flow and its tests are untouched;
   * it is a thin alias over createSocialUser with no provider user ID (Google
   * accounts are keyed on verified email only).
   */
  createGoogleUser(params: {
    email: string;
    fullName: string;
  }): Promise<UserEntity> {
    return this.createSocialUser({
      provider: 'google',
      providerUserId: null,
      email: params.email,
      fullName: params.fullName,
    });
  }

  /**
   * Creates a user from a verified social identity (Google, Facebook, Apple).
   *
   * No password and no country: the provider already proved who they are, and
   * no provider token carries a country. Both columns are nullable as of the
   * AddGoogleAuthSupport migration.
   *
   * Concurrency: two simultaneous first-time sign-ins for the same identity both
   * see the lookups return null and both try to insert. The unique constraints
   * (email, and the partial (authProvider, providerUserId) index) let exactly one
   * win. Rather than surfacing that as a 500, the loser catches PostgreSQL
   * unique_violation (23505) and re-reads the row the winner just wrote. The
   * database stays the source of truth; we just handle losing.
   */
  async createSocialUser(params: {
    provider: SocialProvider;
    providerUserId: string | null;
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
      authProvider: params.provider,
      providerUserId: params.providerUserId,
    });

    try {
      return await this.userRepo.save(user);
    } catch (err) {
      if (!UserService.isUniqueViolation(err)) throw err;

      // Either constraint may have fired; check the provider key first, since
      // that is the one the sign-in flow itself looks up first.
      const byProvider = params.providerUserId
        ? await this.findByProvider(params.provider, params.providerUserId)
        : null;
      if (byProvider) return byProvider;

      const byEmail = await this.findByEmail(params.email);
      if (byEmail) return byEmail;

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
