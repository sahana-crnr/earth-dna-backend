import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds Google Sign-In support to the users table.
 *
 * - password / country become nullable: a user created from a verified Google
 *   identity has neither. Google supplies no country, and no password is needed
 *   because Google already proved who they are.
 * - countryCode is added: the Flutter app reads user['countryCode'] on login and
 *   profile, but no such column ever existed, so it was always absent.
 * - authProvider records how the account was created, so /login can reject a
 *   password attempt on a Google-only account with a clean 401 instead of
 *   crashing inside bcrypt.
 *
 * All four operations are metadata-only in PostgreSQL - DROP NOT NULL, adding a
 * nullable column, and adding a column with a constant default on PG 11+ - so
 * none of them rewrites the table.
 */
export class AddGoogleAuthSupport1788240000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "country" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "countryCode" character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "authProvider" character varying(20) NOT NULL DEFAULT 'local'`,
    );
  }

  /**
   * WARNING: this down migration is lossy by nature.
   *
   * Re-applying NOT NULL requires every row to have a value, but Google-created
   * users genuinely have no password and no country. The backfills below invent
   * data so the constraint can be restored - '!' is not a valid bcrypt hash, so
   * those accounts can never authenticate by password afterwards.
   *
   * The backfills MUST run before the ALTER statements or the migration fails on
   * any Google-created row.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "users" SET "password" = '!' WHERE "password" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "country" = 'Unknown' WHERE "country" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "country" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "countryCode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "authProvider"`,
    );
  }
}
