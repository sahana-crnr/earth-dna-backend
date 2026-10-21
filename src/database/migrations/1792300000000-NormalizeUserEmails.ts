import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Forgot-password fix (PR 17): emails are case-insensitive from now on.
 *
 * Before this, register stored the email exactly as typed, so a phone that
 * auto-capitalised "Jane@gmail.com" made a different row from "jane@gmail.com".
 * This migration:
 *   1. refuses to run while two rows differ only by case or whitespace (those
 *      are usually the same person and must be merged by hand, never guessed);
 *   2. trims and lowercases every stored email;
 *   3. adds a UNIQUE index on LOWER(email), so case variants cannot come back
 *      and the LOWER() lookups in UserService use an index, not a seq scan;
 *   4. adds users.passwordChangedAt: access JWTs issued before a password
 *      reset are rejected by JwtAuthGuard.
 *
 * Check before deploying (empty result = safe):
 *   SELECT LOWER(TRIM(email)), COUNT(*) FROM users GROUP BY 1 HAVING COUNT(*) > 1;
 */
export class NormalizeUserEmails1792300000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    const dupes = (await q.query(
      `SELECT LOWER(TRIM("email")) AS "email", COUNT(*) AS "n"
         FROM "users" GROUP BY 1 HAVING COUNT(*) > 1`,
    )) as { email: string; n: string }[];
    if (dupes.length > 0) {
      throw new Error(
        `NormalizeUserEmails: ${dupes.length} email(s) exist in more than one ` +
          `letter case; merge or rename these accounts first: ` +
          dupes.map((d) => `${d.email} (${d.n})`).join(', '),
      );
    }

    await q.query(
      `UPDATE "users" SET "email" = LOWER(TRIM("email"))
        WHERE "email" <> LOWER(TRIM("email"))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_email_lower" ON "users" (LOWER("email"))`,
    );
    await q.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  /** The original letter case of emails is not restored (it is not kept). */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "passwordChangedAt"`,
    );
    await q.query(`DROP INDEX IF EXISTS "UQ_users_email_lower"`);
  }
}
