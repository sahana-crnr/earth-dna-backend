// User service. Handles all database operations for the users table —
// finding by email, finding by id, finding with password for auth, and creating records.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Raw, Repository } from 'typeorm';
import { UserEntity, SocialProvider } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { normalizeEmail } from '../common/transforms/string.transforms';

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

  // Case-insensitive, served by the UQ_users_email_lower index. Stored emails
  // are already normalised (migration NormalizeUserEmails + create()); this
  // keeps a raw caller argument working too. LOWER() rather than ILIKE, since
  // ILIKE treats the "_" common in emails as a wildcard.
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

  // create() and createSocialUser() are the only places a user row is born
  // (the admin bootstrap reads ADMIN_EMAIL already normalised), so every
  // stored email is in canonical form whatever the caller passed.
  create(dto: CreateUserDto): Promise<UserEntity> {
    const user = this.userRepo.create({
      ...dto,
      email: normalizeEmail(dto.email),
    });
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
      email: normalizeEmail(params.email),
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

  /**
   * Consumes a reset token and sets the new password in ONE conditional
   * UPDATE, so a token can be used exactly once even under concurrent POSTs.
   * Also stamps passwordChangedAt (JwtAuthGuard rejects older access tokens).
   * The UPDATE row-locks the user until `manager`'s transaction ends, which is
   * what RefreshTokenService.rotate() waits on. Returns the user id, or null
   * when the token is unknown, already used or expired.
   */
  async consumeResetToken(
    manager: EntityManager,
    hashedToken: string,
    hashedPassword: string,
  ): Promise<string | null> {
    const result = await manager
      .createQueryBuilder()
      .update(UserEntity)
      .set({
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpiry: null,
        passwordChangedAt: () => 'now()',
      })
      .where('"resetPasswordToken" = :hashedToken', { hashedToken })
      .andWhere('"resetPasswordExpiry" > now()')
      .returning(['id'])
      .execute();
    const rows = result.raw as { id: string }[];
    return rows[0]?.id ?? null;
  }

  /** null = password never reset (or no such user). */
  async getPasswordChangedAt(userId: string): Promise<Date | null> {
    const row = await this.userRepo.findOne({
      where: { id: userId },
      select: { id: true, passwordChangedAt: true },
    });
    return row?.passwordChangedAt ?? null;
  }
}
