import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F2 identification results: scan_shoes -> scan_shoe_results.
 *
 * Source of truth for the feature: EarthDNA-SHOES-Backend-API-Plan-2026-09-25.docx §4.
 *
 * Notes:
 * - UNIQUE(scanShoeId) is the upsert contract made structural: one result per
 *   shoe, so a retried submit can never leave two rows behind (F2-D1).
 * - The condition LABEL is derived in result-rules.ts, not stored: the scale is
 *   still provisional (plan §8, open point 7) and must stay migration-free.
 * - `source` has no default on purpose — every write states who produced the
 *   result, and the submit route hardcodes 'device' server-side (F2-D3).
 * - `candidates`/`raw` are jsonb because the ShoeDNA output contract is open
 *   (plan §8, open point 1); size is capped in the service, not here.
 * - CHK_..._identified keeps an 'identified' row from existing without the two
 *   fields the Review Matches screen cannot render without.
 * - No index beyond the unique one: reads are always "the results of one scan",
 *   which goes through scan_shoes.
 * - Plain PostgreSQL 16 SQL (dev RDS is 16.4).
 */
export class CreateScanShoeResults1791600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "identification_source" AS ENUM ('device','server')`,
    );
    await queryRunner.query(
      `CREATE TYPE "identification_outcome" AS ENUM ('identified','failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "shoe_condition_code" AS ENUM ('C1','C2','C3','C4','C5')`,
    );

    await queryRunner.query(`
      CREATE TABLE "scan_shoe_results" (
        "id"            uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "scanShoeId"    uuid                     NOT NULL,
        "source"        "identification_source"  NOT NULL,
        "outcome"       "identification_outcome" NOT NULL DEFAULT 'identified',
        "modelVersion"  character varying(64)    NOT NULL,
        "brand"         character varying(120),
        "subBrand"      character varying(120),
        "model"         character varying(160),
        "colorway"      character varying(120),
        "confidence"    numeric(5,4),
        "conditionCode" "shoe_condition_code",
        "candidates"    jsonb                    NOT NULL DEFAULT '[]'::jsonb,
        "raw"           jsonb,
        "submittedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_scan_shoe_results" PRIMARY KEY ("id"),
        CONSTRAINT "FK_scan_shoe_results_shoe" FOREIGN KEY ("scanShoeId")
          REFERENCES "scan_shoes" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_scan_shoe_results_shoe" UNIQUE ("scanShoeId"),
        CONSTRAINT "CHK_scan_shoe_results_confidence"
          CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)),
        CONSTRAINT "CHK_scan_shoe_results_identified"
          CHECK ("outcome" <> 'identified' OR ("brand" IS NOT NULL AND "confidence" IS NOT NULL))
      )
    `);
  }

  /** Drops every stored identification. Scan sessions and photos are untouched. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "scan_shoe_results"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "shoe_condition_code"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "identification_outcome"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "identification_source"`);
  }
}
