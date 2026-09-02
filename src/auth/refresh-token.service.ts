// Refresh-token service. Manages the lifecycle of opaque refresh tokens:
// issuing, rotating (with reuse detection), and revoking. Raw tokens are random
// 32-byte hex strings; only their SHA-256 hash is persisted (same approach as the
// password-reset token in AuthService).
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import ms, { type StringValue } from 'ms';
import { RefreshTokenEntity } from './entities/refresh-token.entity';

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
  ): Promise<{ entity: RefreshTokenEntity; rawToken: string }> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hash(rawToken);

    const expiresIn = this.config.get<string>('app.refreshTokenExpiresIn')!;
    const expiresAt = new Date(Date.now() + ms(expiresIn as StringValue));

    const entity = await this.refreshTokenRepo.save(
      this.refreshTokenRepo.create({
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
   * a new one is issued. If an already-revoked token is presented, this is treated
   * as reuse (possible theft) and ALL of the user's active tokens are revoked.
   * Returns the owning userId and the new raw refresh token.
   */
  async rotate(
    rawToken: string,
    userAgent?: string,
  ): Promise<{ userId: string; rawToken: string }> {
    const tokenHash = this.hash(rawToken);
    const record = await this.refreshTokenRepo.findOne({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, revokedAt: true },
    });

    if (!record) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Reuse detection: a token that was already rotated/revoked is being presented.
    if (record.revokedAt) {
      this.logger.warn(
        `Refresh token reuse detected for user ${record.userId}; revoking all sessions`,
      );
      await this.revokeAllForUser(record.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Issue the replacement first so we can link the rotation chain.
    const { entity: newRecord, rawToken: newRawToken } = await this.createToken(
      record.userId,
      userAgent,
    );

    await this.refreshTokenRepo.update(record.id, {
      revokedAt: new Date(),
      replacedByTokenId: newRecord.id,
    });

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

  /** Revokes every active refresh token for a user (logout-all / reuse response). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.refreshTokenRepo
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
