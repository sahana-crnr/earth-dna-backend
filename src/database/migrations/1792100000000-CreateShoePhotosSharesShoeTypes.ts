import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F5 shoe profile + manage: shoe_photos, shoe_shares, catalog_shoe_types,
 * shoe type on categories and shoes, primary photo FK, scans.hiddenAt, and two
 * new feedback types.
 *
 * Source of truth: aidlc-docs/features/F5-shoe-profile/{decisions,how-to}.md.
 *
 * Notes:
 * - shoe_photos mirrors the captured scan views (keys only, same S3 objects)
 *   and holds Edit-screen uploads (F5-D17). Existing entries are backfilled
 *   from scan_photos here, and shoes.primaryPhotoId is derived from the old
 *   primaryPhotoS3Key before that column is dropped.
 * - shoe_shares: one active link per shoe (partial unique on revokedAt IS NULL).
 * - catalog_shoe_types: six fixed display types seeded here (F5-D20); the
 *   product-DB categories are mapped onto them by `npm run catalog:seed`.
 * - ALTER TYPE … ADD VALUE cannot run inside a transaction block on older
 *   Postgres; on 16 it can, but the new values are not usable in the same
 *   transaction. Nothing here inserts those values, so that is fine.
 * - Plain PostgreSQL 16 SQL (dev RDS is 16.4).
 */
export class CreateShoePhotosSharesShoeTypes1792100000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ─── enums ───────────────────────────────────────────────────────────────
    await q.query(`CREATE TYPE "shoe_photo_source" AS ENUM ('scan','upload')`);
    await q.query(
      `ALTER TYPE "feedback_type" ADD VALUE IF NOT EXISTS 'condition_suggested'`,
    );
    await q.query(
      `ALTER TYPE "feedback_type" ADD VALUE IF NOT EXISTS 'rescanned'`,
    );

    // ─── catalog_shoe_types ──────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "catalog_shoe_types" (
        "id"        uuid                  NOT NULL DEFAULT uuid_generate_v4(),
        "slug"      character varying(60) NOT NULL,
        "name"      character varying(80) NOT NULL,
        "sortOrder" smallint              NOT NULL DEFAULT 0,
        "isActive"  boolean               NOT NULL DEFAULT true,
        CONSTRAINT "PK_catalog_shoe_types" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_catalog_shoe_types_slug" ON "catalog_shoe_types" ("slug")`,
    );
    await q.query(`
      INSERT INTO "catalog_shoe_types" ("slug","name","sortOrder") VALUES
        ('athletic-shoes','Athletic Shoes',1),
        ('casual-shoes',  'Casual Shoes',  2),
        ('dress-shoes',   'Dress Shoes',   3),
        ('boots',         'Boots',         4),
        ('sandals',       'Sandals',       5),
        ('slippers',      'Slippers',      6)
    `);
    await q.query(
      `ALTER TABLE "catalog_categories" ADD COLUMN "shoeTypeId" uuid`,
    );
    await q.query(`
      ALTER TABLE "catalog_categories"
        ADD CONSTRAINT "FK_catalog_categories_shoe_type"
        FOREIGN KEY ("shoeTypeId") REFERENCES "catalog_shoe_types" ("id") ON DELETE SET NULL
    `);
    await q.query(
      `CREATE INDEX "IDX_catalog_categories_shoe_type" ON "catalog_categories" ("shoeTypeId")`,
    );

    // ─── shoes: shoe type ────────────────────────────────────────────────────
    await q.query(`ALTER TABLE "shoes" ADD COLUMN "shoeTypeId" uuid`);
    await q.query(
      `ALTER TABLE "shoes" ADD COLUMN "shoeType" character varying(60)`,
    );
    await q.query(`
      ALTER TABLE "shoes"
        ADD CONSTRAINT "FK_shoes_shoe_type"
        FOREIGN KEY ("shoeTypeId") REFERENCES "catalog_shoe_types" ("id") ON DELETE SET NULL
    `);

    // ─── shoe_photos ─────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "shoe_photos" (
        "id"          uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "shoeId"      uuid                     NOT NULL,
        "source"      "shoe_photo_source"      NOT NULL,
        "scanPhotoId" uuid,
        "view"        "shoe_view",
        "s3Key"       character varying(512)   NOT NULL,
        "contentType" character varying(50)    NOT NULL DEFAULT 'image/jpeg',
        "sizeBytes"   integer,
        "sortOrder"   smallint                 NOT NULL DEFAULT 0,
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shoe_photos" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shoe_photos_shoe" FOREIGN KEY ("shoeId")
          REFERENCES "shoes" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_shoe_photos_scan_photo" FOREIGN KEY ("scanPhotoId")
          REFERENCES "scan_photos" ("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_shoe_photos_shoe_order" ON "shoe_photos" ("shoeId","sortOrder")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_shoe_photos_scan_photo" ON "shoe_photos" ("shoeId","scanPhotoId") WHERE "scanPhotoId" IS NOT NULL`,
    );

    // Backfill: every existing entry gets one row per captured scan view, in
    // the F1 view order (top, right, left, sole).
    await q.query(`
      INSERT INTO "shoe_photos" ("shoeId","source","scanPhotoId","view","s3Key","contentType","sizeBytes","sortOrder")
      SELECT s."id", 'scan', p."id", p."view", p."s3Key", p."contentType", p."bytes",
             CASE p."view" WHEN 'top' THEN 0 WHEN 'right' THEN 1 WHEN 'left' THEN 2 ELSE 3 END
      FROM "shoes" s
      JOIN "scan_photos" p ON p."scanShoeId" = s."scanShoeId"
      WHERE s."scanShoeId" IS NOT NULL
    `);

    // ─── shoes: primary photo FK replaces the copied key ─────────────────────
    await q.query(`ALTER TABLE "shoes" ADD COLUMN "primaryPhotoId" uuid`);
    await q.query(`
      ALTER TABLE "shoes"
        ADD CONSTRAINT "FK_shoes_primary_photo"
        FOREIGN KEY ("primaryPhotoId") REFERENCES "shoe_photos" ("id") ON DELETE SET NULL
    `);
    await q.query(`
      UPDATE "shoes" s SET "primaryPhotoId" = p."id"
      FROM "shoe_photos" p
      WHERE p."shoeId" = s."id" AND p."s3Key" = s."primaryPhotoS3Key"
    `);
    // Entries whose thumbnail key matched nothing: first photo by sortOrder.
    await q.query(`
      UPDATE "shoes" s SET "primaryPhotoId" = f."id"
      FROM (
        SELECT DISTINCT ON ("shoeId") "id", "shoeId" FROM "shoe_photos"
        ORDER BY "shoeId", "sortOrder" ASC, "createdAt" ASC
      ) f
      WHERE f."shoeId" = s."id" AND s."primaryPhotoId" IS NULL
    `);
    await q.query(`ALTER TABLE "shoes" DROP COLUMN "primaryPhotoS3Key"`);

    // ─── shoe_shares ─────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "shoe_shares" (
        "id"        uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "shoeId"    uuid                     NOT NULL,
        "token"     character varying(64)    NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "viewCount" integer                  NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shoe_shares" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shoe_shares_shoe" FOREIGN KEY ("shoeId")
          REFERENCES "shoes" ("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_shoe_shares_token" ON "shoe_shares" ("token")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_shoe_shares_active" ON "shoe_shares" ("shoeId") WHERE "revokedAt" IS NULL`,
    );

    // ─── scans.hiddenAt (F5-D10) ─────────────────────────────────────────────
    await q.query(
      `ALTER TABLE "scans" ADD COLUMN "hiddenAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  /** Restores primaryPhotoS3Key from the primary row, then drops everything
   *  F5 added. The two feedback_type values stay (Postgres cannot drop enum
   *  values); no row uses them after the tables are gone. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "scans" DROP COLUMN IF EXISTS "hiddenAt"`);
    await q.query(`DROP TABLE IF EXISTS "shoe_shares"`);

    await q.query(
      `ALTER TABLE "shoes" ADD COLUMN "primaryPhotoS3Key" character varying(512)`,
    );
    await q.query(`
      UPDATE "shoes" s SET "primaryPhotoS3Key" = p."s3Key"
      FROM "shoe_photos" p WHERE p."id" = s."primaryPhotoId"
    `);
    await q.query(
      `ALTER TABLE "shoes" DROP CONSTRAINT IF EXISTS "FK_shoes_primary_photo"`,
    );
    await q.query(`ALTER TABLE "shoes" DROP COLUMN IF EXISTS "primaryPhotoId"`);
    await q.query(`DROP TABLE IF EXISTS "shoe_photos"`);

    await q.query(
      `ALTER TABLE "shoes" DROP CONSTRAINT IF EXISTS "FK_shoes_shoe_type"`,
    );
    await q.query(`ALTER TABLE "shoes" DROP COLUMN IF EXISTS "shoeType"`);
    await q.query(`ALTER TABLE "shoes" DROP COLUMN IF EXISTS "shoeTypeId"`);
    await q.query(
      `ALTER TABLE "catalog_categories" DROP CONSTRAINT IF EXISTS "FK_catalog_categories_shoe_type"`,
    );
    await q.query(
      `ALTER TABLE "catalog_categories" DROP COLUMN IF EXISTS "shoeTypeId"`,
    );
    await q.query(`DROP TABLE IF EXISTS "catalog_shoe_types"`);
    await q.query(`DROP TYPE IF EXISTS "shoe_photo_source"`);
  }
}
