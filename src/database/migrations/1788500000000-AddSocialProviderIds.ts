import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds provider-issued user IDs for Facebook and Apple sign-in.
 *
 * Both providers ask us to key accounts on their stable `sub` claim rather than
 * on email: a Facebook account may carry no email at all, and an Apple account
 * may present a private-relay address the user can later disable. Email stays
 * unique and stays the auto-link key; `providerUserId` is simply looked up first.
 *
 * The unique index is partial (`WHERE "providerUserId" IS NOT NULL`) so every
 * local and Google account - which have no provider ID - can coexist without
 * tripping it. It is scoped by authProvider because Facebook and Apple IDs are
 * separate namespaces and could, in theory, collide as strings.
 *
 * Adding a nullable column and creating an index are both non-rewriting
 * operations in PostgreSQL; the index build on a small table is instantaneous.
 */
export class AddSocialProviderIds1788500000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "providerUserId" character varying(255)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_provider_user_id"
         ON "users" ("authProvider", "providerUserId")
         WHERE "providerUserId" IS NOT NULL`,
    );
  }

  /**
   * Non-lossy for local/Google users. Facebook/Apple users lose their provider
   * ID and fall back to email-only lookup - they keep their account, but a
   * Facebook user who never shared an email would no longer be reachable.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_provider_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "providerUserId"`,
    );
  }
}
