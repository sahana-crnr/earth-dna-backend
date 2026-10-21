// Refresh-token service. Manages the lifecycle of opaque refresh tokens:
// issuing, rotating (with reuse detection), and revoking. Raw tokens are random
// 32-byte hex strings; only their SHA-256 hash is persisted (same approach as the
// password-reset token in AuthService).
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import * as crypto from 'crypto';
import ms, { type StringValue } from 'ms';
import { RefreshTokenEntity } from './entities/refresh-token.entity';
import { UserEntity } from '../user/entities/user.entity';

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokenRepo: Repository<RefreshTokenEntity>,
    private readonly config: ConfigService,
  ) {}

  /** Generates a raw refresh token, stores its hash, and returns the raw value. */
  async issue(userId: string, userAgent?: string): Promise<string> {
    const { rawToken } = await this.createToken(userId, userAgent);
    return rawToken;
  }

  // Persists a new refresh-token row and returns both the saved entity (for
  // linking the rotation chain) and the raw token (to hand back to the client).
  private async createToken(
    userId: string,
    userAgent?: string,
    manager: EntityManager = this.refreshTokenRepo.manager,
  ): Promise<{ entity: RefreshTokenEntity; rawToken: string }> {
    const repo = manager.getRepository(RefreshTokenEntity);
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hash(rawToken);

    const expiresIn = this.config.get<string>('app.refreshTokenExpiresIn')!;
    const expiresAt = new Date(Date.now() + ms(expiresIn as StringValue));

    const entity = await repo.save(
      repo.create({
        userId,
        tokenHash,
        expiresAt,
        userAgent: userAgent ?? null,
      }),
    );

    return { entity, rawToken };
  }

  /**
   * Validates a refresh token and rotates it: the presented token is revoked and
   * a new one is issued. Presenting a token that was already ROTATED (it has a
   * successor) is treated as reuse (possible theft) and revokes ALL of the
   * user's tokens. A token revoked by logout or a password reset is simply
   * invalid: an old device waking up after a reset must not sign the user out
   * of the session they just started.
   *
   * Runs in one transaction holding the user row lock, the same lock a
   * password reset takes, so a refresh racing a reset either finishes first
   * (and the reset revokes its new token) or sees the token already revoked.
   * Returns the owning userId and the new raw refresh token.
   */
  async rotate(
    rawToken: string,
    userAgent?: string,
  ): Promise<{ userId: string; rawToken: string }> {
    const tokenHash = this.hash(rawToken);
    const record = await this.refreshTokenRepo.findOne({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        replacedByTokenId: true,
      },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.revokedAt) {
      if (record.replacedByTokenId) {
        this.logger.warn(
          `Refresh token reuse detected for user ${record.userId}; revoking all sessions`,
        );
        await this.revokeAllForUser(record.userId);
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const newRawToken = await this.refreshTokenRepo.manager.transaction(
      async (m) => {
        await m
          .getRepository(UserEntity)
          .createQueryBuilder('user')
          .select('user.id')
          .where('user.id = :id', { id: record.userId })
          .setLock('pessimistic_write')
          .getOne();

        // Conditional: loses cleanly to a concurrent rotate, logout or reset.
        const claimed = await m
          .createQueryBuilder()
          .update(RefreshTokenEntity)
          .set({ revokedAt: () => 'now()' })
          .where('id = :id', { id: record.id })
          .andWhere('"revokedAt" IS NULL')
          .execute();
        if (!claimed.affected) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        const { entity, rawToken: raw } = await this.createToken(
          record.userId,
          userAgent,
          m,
        );
        await m
          .getRepository(RefreshTokenEntity)
          .update(record.id, { replacedByTokenId: entity.id });
        return raw;
      },
    );

    return { userId: record.userId, rawToken: newRawToken };
  }

  /** Revokes a single session identified by its raw refresh token (logout). */
  async revoke(rawToken: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    await this.refreshTokenRepo
      .createQueryBuilder()
      .update(RefreshTokenEntity)
      .set({ revokedAt: new Date() })
      .where('tokenHash = :tokenHash', { tokenHash })
      .andWhere('revokedAt IS NULL')
      .execute();
  }

  /**
   * Revokes every active refresh token for a user (logout-all, reuse response,
   * password reset). Pass `manager` to run inside the caller's transaction.
   */
  async revokeAllForUser(
    userId: string,
    manager: EntityManager = this.refreshTokenRepo.manager,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(RefreshTokenEntity)
      .set({ revokedAt: new Date() })
      .where('userId = :userId', { userId })
      .andWhere('revokedAt IS NULL')
      .execute();
  }

  private hash(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }
}
