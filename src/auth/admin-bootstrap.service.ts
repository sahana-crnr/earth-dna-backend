// Syncs the single F7 admin from env (ADMIN_EMAIL / ADMIN_PASSWORD) into the
// users table on every boot. Env is the source of truth:
//   - the ADMIN_EMAIL account is created (local, bcrypt hash) or promoted;
//   - its hash is rewritten only when it no longer matches ADMIN_PASSWORD, so
//     an ordinary boot writes nothing; a rewrite also revokes its sessions;
//   - every OTHER admin row is demoted, so changing ADMIN_EMAIL moves the role
//     rather than adding a second admin;
//   - unset or weak credentials mean no admin at all (fail closed).
//
// An ADMIN_EMAIL that already belongs to a social (Google/Facebook/Apple)
// account is refused, not taken over: promoting it would hand admin to whoever
// controls that provider identity, and giving it a password would add a login
// the owner never set.
//
// ECS starts every task at once, so the whole sync runs in one transaction
// under an advisory lock; later tasks wait, re-read, and find nothing to do.
// A failure is logged, never thrown - the admin is optional and must not stop
// the app serving USER routes.
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserEntity } from '../user/entities/user.entity';
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  type AdminConfig,
} from '../config/admin.config';
import { BCRYPT_SALT_ROUNDS } from './auth.service';
import { RefreshTokenService } from './refresh-token.service';

// Any fixed 32-bit integer, distinct from the migration lock (727301).
const ADMIN_BOOTSTRAP_LOCK_KEY = 727302;

export type AdminSyncOutcome =
  | 'created'
  | 'promoted'
  | 'updated'
  | 'unchanged'
  | 'disabled'
  | 'refused';

@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      this.logger.error(
        'Admin bootstrap failed; admin access unchanged',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async sync(): Promise<AdminSyncOutcome> {
    const { email, password } = this.config.get<AdminConfig>('admin') ?? {
      email: null,
      password: null,
    };
    const usable =
      !!email && !!password && password.length >= ADMIN_PASSWORD_MIN_LENGTH;

    const { outcome, adminId } = await this.dataSource.transaction<{
      outcome: AdminSyncOutcome;
      adminId: string | null;
    }>(async (m) => {
      await m.query('SELECT pg_advisory_xact_lock($1)', [
        ADMIN_BOOTSTRAP_LOCK_KEY,
      ]);
      const repo = m.getRepository(UserEntity);

      if (!usable) {
        const demoted = await this.demoteAdminsExcept(repo, null);
        this.logger.warn(
          `No admin configured (ADMIN_EMAIL unset or ADMIN_PASSWORD shorter than ${ADMIN_PASSWORD_MIN_LENGTH} chars)` +
            (demoted ? `; demoted ${demoted} existing admin(s)` : ''),
        );
        return { outcome: 'disabled', adminId: null };
      }

      const existing = await repo.findOne({
        where: { email },
        select: { id: true, role: true, authProvider: true, password: true },
      });

      if (existing && existing.authProvider !== 'local') {
        await this.demoteAdminsExcept(repo, null);
        this.logger.error(
          `ADMIN_EMAIL belongs to a ${existing.authProvider} account; refusing to promote it. No admin is active.`,
        );
        return { outcome: 'refused', adminId: null };
      }

      let outcome: AdminSyncOutcome;
      let adminId: string;

      if (!existing) {
        const created = await repo.save(
          repo.create({
            fullName: 'Admin',
            email,
            password: await bcrypt.hash(password, BCRYPT_SALT_ROUNDS),
            country: null,
            countryCode: null,
            zipCode: null,
            authProvider: 'local',
            providerUserId: null,
            role: 'ADMIN',
          }),
        );
        adminId = created.id;
        outcome = 'created';
      } else {
        adminId = existing.id;
        const patch: Partial<UserEntity> = {};
        if (existing.role !== 'ADMIN') patch.role = 'ADMIN';
        if (
          !existing.password ||
          !(await bcrypt.compare(password, existing.password))
        ) {
          patch.password = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
        }
        if (Object.keys(patch).length > 0) {
          await repo.update(adminId, patch);
        }
        outcome =
          patch.role !== undefined
            ? 'promoted'
            : patch.password !== undefined
              ? 'updated'
              : 'unchanged';
      }

      const demoted = await this.demoteAdminsExcept(repo, adminId);
      if (outcome !== 'unchanged' || demoted) {
        this.logger.log(
          `Admin ${outcome}: ${email}` +
            (demoted ? `; demoted ${demoted} other admin(s)` : ''),
        );
      }
      return { outcome, adminId };
    });

    // A rotated ADMIN_PASSWORD signs the admin out everywhere, after commit so
    // the transaction holds no lock across the extra write.
    if (outcome === 'updated' && adminId) {
      await this.refreshTokens.revokeAllForUser(adminId);
    }
    return outcome;
  }

  private async demoteAdminsExcept(
    repo: Repository<UserEntity>,
    keepId: string | null,
  ): Promise<number> {
    const res = await repo.update(
      keepId ? { role: 'ADMIN', id: Not(keepId) } : { role: 'ADMIN' },
      { role: 'USER' },
    );
    return res.affected ?? 0;
  }
}
