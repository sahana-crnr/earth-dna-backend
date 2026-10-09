import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F3 match feedback + catalog: catalog_* tables, shoes (My Shoes), shoe_feedback,
 * condition_mappings, and three nullable columns on scan_shoe_results.
 *
 * Source of truth: aidlc-docs/features/F3-match-feedback/{decisions,how-to}.md
 * and inception/application-design/data-model.dbml.
 *
 * Notes:
 * - `shoes` carries the full F4/F5 schema now (F3-D13b) so those features add
 *   no migration for it; F3 only fills identity + placeholder values.
 * - shoes.scanShoeId is UNIQUE: one My Shoes entry per scan shoe, which is what
 *   makes a repeated confirm structurally impossible, not merely checked (F3-D9).
 * - shoe_feedback FKs are ON DELETE SET NULL on both user and scan shoe: the
 *   training row outlives the account and the scan (F3-D14, D15).
 * - catalog_sizes has two partial unique indexes because brandId is nullable:
 *   a plain UNIQUE would let duplicate generic rows through (NULL <> NULL).
 * - scan_shoes.rescanOfShoeId finally gets its FK (deferred since F1).
 * - condition_mappings is seeded with the provisional D7 labels (tracker T18):
 *   editing a label is an UPDATE, never a release.
 * - Reuses the shoe_condition_code enum from F2; creates shoe_gender,
 *   feedback_type, recommended_action, action_taken, resale_bucket, value_source.
 * - Plain PostgreSQL 16 SQL (dev RDS is 16.4).
 */
export class CreateCatalogAndShoes1791800000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ─── enums ───────────────────────────────────────────────────────────────
    await q.query(
      `CREATE TYPE "shoe_gender" AS ENUM ('men','women','unisex','kids')`,
    );
    await q.query(
      `CREATE TYPE "feedback_type" AS ENUM ('confirmed','corrected')`,
    );
    await q.query(
      `CREATE TYPE "recommended_action" AS ENUM ('resell','repair','donate','recycle')`,
    );
    await q.query(
      `CREATE TYPE "action_taken" AS ENUM ('none','resold','repaired','donated','recycled')`,
    );
    await q.query(
      `CREATE TYPE "resale_bucket" AS ENUM ('under_20','from_25_to_50','from_50_to_100','over_100')`,
    );
    await q.query(`CREATE TYPE "value_source" AS ENUM ('static','valuelens')`);

    // ─── F2 columns (F3-D18) ─────────────────────────────────────────────────
    await q.query(`
      ALTER TABLE "scan_shoe_results"
        ADD COLUMN "category"    character varying(100),
        ADD COLUMN "subCategory" character varying(100),
        ADD COLUMN "material"    character varying(200)
    `);

    // ─── catalog ─────────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "catalog_categories" (
        "id"        uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "slug"      character varying(100)   NOT NULL,
        "name"      character varying(120)   NOT NULL,
        "sortOrder" smallint                 NOT NULL DEFAULT 0,
        "isActive"  boolean                  NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_categories" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_catalog_categories_slug" UNIQUE ("slug")
      )
    `);
    await q.query(`
      CREATE TABLE "catalog_subcategories" (
        "id"         uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "categoryId" uuid                     NOT NULL,
        "slug"       character varying(100)   NOT NULL,
        "name"       character varying(120)   NOT NULL,
        "sortOrder"  smallint                 NOT NULL DEFAULT 0,
        "isActive"   boolean                  NOT NULL DEFAULT true,
        "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_subcategories" PRIMARY KEY ("id"),
        CONSTRAINT "FK_catalog_subcategories_category" FOREIGN KEY ("categoryId")
          REFERENCES "catalog_categories" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_catalog_subcategories_category_slug" UNIQUE ("categoryId", "slug")
      )
    `);
    await q.query(`
      CREATE TABLE "catalog_brands" (
        "id"        uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "slug"      character varying(100)   NOT NULL,
        "name"      character varying(120)   NOT NULL,
        "sortOrder" smallint                 NOT NULL DEFAULT 0,
        "isActive"  boolean                  NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_brands" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_catalog_brands_slug" UNIQUE ("slug")
      )
    `);
    await q.query(`
      CREATE TABLE "catalog_brand_subcategories" (
        "brandId"       uuid NOT NULL,
        "subcategoryId" uuid NOT NULL,
        CONSTRAINT "PK_catalog_brand_subcategories" PRIMARY KEY ("brandId", "subcategoryId"),
        CONSTRAINT "FK_catalog_brand_subcategories_brand" FOREIGN KEY ("brandId")
          REFERENCES "catalog_brands" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_catalog_brand_subcategories_subcategory" FOREIGN KEY ("subcategoryId")
          REFERENCES "catalog_subcategories" ("id") ON DELETE CASCADE
      )
    `);
    await q.query(`
      CREATE TABLE "catalog_products" (
        "id"          uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "brandId"     uuid                     NOT NULL,
        "sku"         character varying(40)    NOT NULL,
        "model"       character varying(200),
        "modelCode"   character varying(100),
        "category"    character varying(100),
        "subCategory" character varying(100),
        "silhouette"  character varying(100),
        "gender"      "shoe_gender",
        "colour"      character varying(200),
        "size"        character varying(20),
        "sizeRaw"     character varying(120),
        "msrp"        numeric(10,2),
        "releaseDate" date,
        "title"       character varying(500),
        "source"      character varying(40)    NOT NULL DEFAULT 'import',
        "isActive"    boolean                  NOT NULL DEFAULT true,
        "importedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_catalog_products" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_catalog_products_sku" UNIQUE ("sku"),
        CONSTRAINT "FK_catalog_products_brand" FOREIGN KEY ("brandId")
          REFERENCES "catalog_brands" ("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_catalog_products_brand_model" ON "catalog_products" ("brandId", "model")`,
    );
    await q.query(
      `CREATE INDEX "IDX_catalog_products_brand_size" ON "catalog_products" ("brandId", "size")`,
    );
    // matchProduct and listColours filter on LOWER(model); the plain index
    // above cannot serve that once a brand holds tens of thousands of SKUs.
    await q.query(
      `CREATE INDEX "IDX_catalog_products_brand_lower_model" ON "catalog_products" ("brandId", LOWER("model"))`,
    );
    await q.query(`
      CREATE TABLE "catalog_sizes" (
        "id"        uuid                   NOT NULL DEFAULT uuid_generate_v4(),
        "brandId"   uuid,
        "system"    character varying(10)  NOT NULL DEFAULT 'US',
        "label"     character varying(20)  NOT NULL,
        "sortOrder" smallint               NOT NULL DEFAULT 0,
        CONSTRAINT "PK_catalog_sizes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_catalog_sizes_brand" FOREIGN KEY ("brandId")
          REFERENCES "catalog_brands" ("id") ON DELETE CASCADE
      )
    `);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_catalog_sizes_brand_system_label" ON "catalog_sizes" ("brandId", "system", "label") WHERE "brandId" IS NOT NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_catalog_sizes_generic_system_label" ON "catalog_sizes" ("system", "label") WHERE "brandId" IS NULL`,
    );
    await q.query(`
      CREATE TABLE "condition_mappings" (
        "code"        "shoe_condition_code"  NOT NULL,
        "label"       character varying(40)  NOT NULL,
        "gradeLetter" character(1)           NOT NULL,
        "description" character varying(120) NOT NULL,
        "filterGroup" character varying(20)  NOT NULL,
        "sortOrder"   smallint               NOT NULL DEFAULT 0,
        CONSTRAINT "PK_condition_mappings" PRIMARY KEY ("code")
      )
    `);
    // Provisional D7 labels; C3 and C4 share one until design confirms (T18).
    await q.query(`
      INSERT INTO "condition_mappings" ("code","label","gradeLetter","description","filterGroup","sortOrder") VALUES
        ('C1','Like New',    'A','Minimal signs of use',         'Great',1),
        ('C2','Lightly Worn','B','Minor signs of use',           'Good', 2),
        ('C3','Heavily Worn','C','Visible wear, fully wearable', 'Fair', 3),
        ('C4','Heavily Worn','D','Heavy wear, still wearable',   'Fair', 4),
        ('C5','Not wearable','E','Beyond everyday use',          'Poor', 5)
    `);

    // ─── My Shoes ────────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "shoes" (
        "id"                   uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "userId"               uuid                     NOT NULL,
        "scanShoeId"           uuid,
        "brandId"              uuid,
        "brand"                character varying(120)   NOT NULL,
        "subBrand"             character varying(120),
        "category"             character varying(100),
        "subCategory"          character varying(100),
        "model"                character varying(150),
        "colorway"             character varying(100),
        "sizeId"               uuid,
        "size"                 character varying(20),
        "gender"               "shoe_gender",
        "conditionCode"        "shoe_condition_code",
        "material"             character varying(200),
        "catalogProductId"     uuid,
        "msrp"                 numeric(10,2),
        "recommendedAction"    "recommended_action",
        "actionTaken"          "action_taken"           NOT NULL DEFAULT 'none',
        "actionTakenAt"        TIMESTAMP WITH TIME ZONE,
        "resaleMin"            numeric(10,2),
        "resaleMax"            numeric(10,2),
        "resaleCurrency"       character(3)             NOT NULL DEFAULT 'USD',
        "resaleBucket"         "resale_bucket",
        "demandNote"           character varying(120),
        "recommendationReason" character varying(300),
        "co2eKg"               numeric(8,2),
        "valueSource"          "value_source"           NOT NULL DEFAULT 'static',
        "valueSourceVersion"   character varying(50),
        "valueComputedAt"      TIMESTAMP WITH TIME ZONE,
        "primaryPhotoS3Key"    character varying(512),
        "deletedAt"            TIMESTAMP WITH TIME ZONE,
        "createdAt"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shoes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_shoes_scan_shoe" UNIQUE ("scanShoeId"),
        CONSTRAINT "FK_shoes_user" FOREIGN KEY ("userId")
          REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_shoes_scan_shoe" FOREIGN KEY ("scanShoeId")
          REFERENCES "scan_shoes" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_shoes_brand" FOREIGN KEY ("brandId")
          REFERENCES "catalog_brands" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_shoes_size" FOREIGN KEY ("sizeId")
          REFERENCES "catalog_sizes" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_shoes_catalog_product" FOREIGN KEY ("catalogProductId")
          REFERENCES "catalog_products" ("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_shoes_user_deleted" ON "shoes" ("userId", "deletedAt")`,
    );
    await q.query(
      `CREATE INDEX "IDX_shoes_user_action" ON "shoes" ("userId", "actionTaken")`,
    );
    await q.query(
      `CREATE INDEX "IDX_shoes_user_recommended" ON "shoes" ("userId", "recommendedAction")`,
    );
    await q.query(
      `CREATE INDEX "IDX_shoes_user_bucket" ON "shoes" ("userId", "resaleBucket")`,
    );
    await q.query(`
      ALTER TABLE "scan_shoes"
        ADD CONSTRAINT "FK_scan_shoes_rescan_of_shoe" FOREIGN KEY ("rescanOfShoeId")
          REFERENCES "shoes" ("id") ON DELETE SET NULL
    `);

    // ─── feedback ────────────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE "shoe_feedback" (
        "id"           uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "scanShoeId"   uuid,
        "shoeId"       uuid,
        "userId"       uuid,
        "type"         "feedback_type"          NOT NULL,
        "modelVersion" character varying(64),
        "original"     jsonb                    NOT NULL,
        "answer"       jsonb                    NOT NULL,
        "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shoe_feedback" PRIMARY KEY ("id"),
        CONSTRAINT "FK_shoe_feedback_scan_shoe" FOREIGN KEY ("scanShoeId")
          REFERENCES "scan_shoes" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_shoe_feedback_user" FOREIGN KEY ("userId")
          REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_shoe_feedback_scan_shoe" ON "shoe_feedback" ("scanShoeId")`,
    );
    await q.query(
      `CREATE INDEX "IDX_shoe_feedback_user" ON "shoe_feedback" ("userId")`,
    );
  }

  /** Drops every My Shoes entry, feedback row and catalog row. Scans, photos
   *  and F2 results survive (the three F2 columns are dropped). */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "shoe_feedback"`);
    await q.query(
      `ALTER TABLE "scan_shoes" DROP CONSTRAINT IF EXISTS "FK_scan_shoes_rescan_of_shoe"`,
    );
    await q.query(`DROP TABLE IF EXISTS "shoes"`);
    await q.query(`DROP TABLE IF EXISTS "condition_mappings"`);
    await q.query(`DROP TABLE IF EXISTS "catalog_sizes"`);
    await q.query(`DROP TABLE IF EXISTS "catalog_products"`);
    await q.query(`DROP TABLE IF EXISTS "catalog_brand_subcategories"`);
    await q.query(`DROP TABLE IF EXISTS "catalog_brands"`);
    await q.query(`DROP TABLE IF EXISTS "catalog_subcategories"`);
    await q.query(`DROP TABLE IF EXISTS "catalog_categories"`);
    await q.query(`
      ALTER TABLE "scan_shoe_results"
        DROP COLUMN IF EXISTS "material",
        DROP COLUMN IF EXISTS "subCategory",
        DROP COLUMN IF EXISTS "category"
    `);
    await q.query(`DROP TYPE IF EXISTS "value_source"`);
    await q.query(`DROP TYPE IF EXISTS "resale_bucket"`);
    await q.query(`DROP TYPE IF EXISTS "action_taken"`);
    await q.query(`DROP TYPE IF EXISTS "recommended_action"`);
    await q.query(`DROP TYPE IF EXISTS "feedback_type"`);
    await q.query(`DROP TYPE IF EXISTS "shoe_gender"`);
  }
}
