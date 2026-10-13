import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Unit F3.1 (2026-10-12): two product decisions applied to the F3 schema.
 *
 * 1. Carbon footprint is out of scope (decided 2026-10-09): `shoes.co2eKg` is
 *    dropped. No screen, summary or endpoint returns CO2e any more.
 * 2. The designer's grading table now has four grades (A+, A, B, C) instead
 *    of the five provisional letters seeded by F3. ShoeDNA still emits five
 *    codes, so C3 and C4 share grade B until ML/design settle the code count
 *    (tracker T18). Labels are data: a later rename is an UPDATE, not a release.
 *
 * Plain PostgreSQL 16 SQL (dev RDS is 16.4). `down` restores the column
 * (nullable, values lost) and the five-letter rows.
 */
export class DropCo2eAndFourGrades1792000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "shoes" DROP COLUMN IF EXISTS "co2eKg"`);

    // "A+" needs two characters; the column was character(1).
    await q.query(
      `ALTER TABLE "condition_mappings" ALTER COLUMN "gradeLetter" TYPE character varying(2)`,
    );
    await q.query(`
      UPDATE "condition_mappings" AS c SET
        "label"       = v.label,
        "gradeLetter" = v.grade,
        "description" = v.description,
        "filterGroup" = v.filter_group,
        "sortOrder"   = v.sort_order
      FROM (VALUES
        ('C1'::"shoe_condition_code", 'Like New',     'A+', 'Little to no visible wear',            'Great', 1),
        ('C2'::"shoe_condition_code", 'Lightly Worn', 'A',  'Minor signs of wear, fully functional', 'Good',  2),
        ('C3'::"shoe_condition_code", 'Heavily Worn', 'B',  'Visible wear, still functional',        'Fair',  3),
        ('C4'::"shoe_condition_code", 'Heavily Worn', 'B',  'Visible wear, still functional',        'Fair',  4),
        ('C5'::"shoe_condition_code", 'Not wearable', 'C',  'Significant wear or damage',            'Poor',  5)
      ) AS v(code, label, grade, description, filter_group, sort_order)
      WHERE c."code" = v.code
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      UPDATE "condition_mappings" AS c SET
        "label"       = v.label,
        "gradeLetter" = v.grade,
        "description" = v.description,
        "filterGroup" = v.filter_group,
        "sortOrder"   = v.sort_order
      FROM (VALUES
        ('C1'::"shoe_condition_code", 'Like New',     'A', 'Minimal signs of use',         'Great', 1),
        ('C2'::"shoe_condition_code", 'Lightly Worn', 'B', 'Minor signs of use',           'Good',  2),
        ('C3'::"shoe_condition_code", 'Heavily Worn', 'C', 'Visible wear, fully wearable', 'Fair',  3),
        ('C4'::"shoe_condition_code", 'Heavily Worn', 'D', 'Heavy wear, still wearable',   'Fair',  4),
        ('C5'::"shoe_condition_code", 'Not wearable', 'E', 'Beyond everyday use',          'Poor',  5)
      ) AS v(code, label, grade, description, filter_group, sort_order)
      WHERE c."code" = v.code
    `);
    await q.query(
      `ALTER TABLE "condition_mappings" ALTER COLUMN "gradeLetter" TYPE character(1)`,
    );

    await q.query(
      `ALTER TABLE "shoes" ADD COLUMN IF NOT EXISTS "co2eKg" numeric(8,2)`,
    );
  }
}
