import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F1 scan sessions: scans → scan_shoes → scan_photos.
 *
 * Source of truth for columns: aidlc-docs/inception/application-design/data-model.dbml.
 *
 * Notes:
 * - Shoe label ("Shoe 01") and completeness are derived, not stored (F1-D6).
 * - (scanId, position) is a DEFERRABLE unique constraint so removing a middle
 *   shoe can renumber the rest in one transaction without tripping the check
 *   row by row (F1-D7).
 * - scan_shoes.rescanOfShoeId is created without a foreign key: the `shoes`
 *   table arrives with F4/F5, which adds the constraint.
 * - uploadStatus defaults to 'uploaded' because photos are uploaded through the
 *   backend (F1-D1); 'pending' is kept for a possible presigned flow later.
 * - Plain PostgreSQL 16 SQL (dev RDS is 16.4).
 */
export class CreateScanTables1790700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "scan_status" AS ENUM ('draft','processing','review','completed','abandoned')`,
    );
    await queryRunner.query(
      `CREATE TYPE "scan_source" AS ENUM ('camera','album')`,
    );
    await queryRunner.query(
      `CREATE TYPE "scan_shoe_status" AS ENUM ('capturing','complete','analyzing','identified','failed','confirmed','rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "shoe_view" AS ENUM ('top','right','left','sole')`,
    );
    await queryRunner.query(
      `CREATE TYPE "upload_status" AS ENUM ('pending','uploaded')`,
    );

    await queryRunner.query(`
      CREATE TABLE "scans" (
        "id"         uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "userId"     uuid                     NOT NULL,
        "status"     "scan_status"            NOT NULL DEFAULT 'draft',
        "source"     "scan_source"            NOT NULL DEFAULT 'camera',
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scans" PRIMARY KEY ("id"),
        CONSTRAINT "FK_scans_user" FOREIGN KEY ("userId")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_scans_user_status" ON "scans" ("userId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_scans_status_updated" ON "scans" ("status", "updatedAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "scan_shoes" (
        "id"             uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "scanId"         uuid                     NOT NULL,
        "position"       smallint                 NOT NULL,
        "status"         "scan_shoe_status"       NOT NULL DEFAULT 'capturing',
        "rescanOfShoeId" uuid,
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scan_shoes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_scan_shoes_scan" FOREIGN KEY ("scanId")
          REFERENCES "scans" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_scan_shoes_scan_position" UNIQUE ("scanId", "position")
          DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT "CHK_scan_shoes_position" CHECK ("position" > 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "scan_photos" (
        "id"           uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "scanShoeId"   uuid                     NOT NULL,
        "view"         "shoe_view"              NOT NULL,
        "s3Key"        character varying(512)   NOT NULL,
        "contentType"  character varying(50)    NOT NULL DEFAULT 'image/jpeg',
        "bytes"        integer,
        "width"        integer,
        "height"       integer,
        "uploadStatus" "upload_status"          NOT NULL DEFAULT 'uploaded',
        "takenAt"      TIMESTAMP WITH TIME ZONE,
        "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scan_photos" PRIMARY KEY ("id"),
        CONSTRAINT "FK_scan_photos_shoe" FOREIGN KEY ("scanShoeId")
          REFERENCES "scan_shoes" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_scan_photos_shoe_view" UNIQUE ("scanShoeId", "view")
      )
    `);
  }

  /** Drops all F1 scan data. Photos in S3 are not touched by a migration. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "scan_photos"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "scan_shoes"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scans_status_updated"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scans_user_status"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "scans"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "upload_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "shoe_view"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "scan_shoe_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "scan_source"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "scan_status"`);
  }
}
