import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F7: account roles. Every existing and future account is USER; the single
 * ADMIN is granted at boot by AdminBootstrapService from ADMIN_EMAIL, never by
 * this migration (credentials stay out of the schema history).
 *
 * varchar + CHECK rather than a Postgres enum, so adding a role later is a
 * constraint swap, not an ALTER TYPE. The values mirror USER_ROLES in
 * src/user/user-roles.ts.
 *
 * ADD COLUMN with a constant DEFAULT is metadata-only in PostgreSQL 11+: no
 * table rewrite.
 */
export class AddUserRole1792200000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" character varying(20) NOT NULL DEFAULT 'USER'`,
    );
    await q.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_role" CHECK ("role" IN ('USER','ADMIN'))`,
    );
  }

  /** Lossy only for the admin flag, which the next boot re-derives from env. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_role"`,
    );
    await q.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "role"`);
  }
}
