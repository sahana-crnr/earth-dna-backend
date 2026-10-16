import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F7 model integration settings: one row per external model endpoint, edited
 * by the admin through PUT /admin/integrations/{name}.
 *
 * - Both rows are seeded disabled with no URL, so GET lists them from day one
 *   and PUT only ever updates; the name CHECK mirrors INTEGRATION_NAMES in
 *   src/integrations/integration.types.ts.
 * - CHK_integrations_enabled_url makes "enabled with no endpoint" impossible at
 *   the schema level, not only in IntegrationsService.
 * - updatedById is ON DELETE SET NULL: the setting outlives the admin account.
 * - authRef holds a secret's NAME, never the secret (see the entity).
 */
export class CreateIntegrations1792200000001 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "integrations" (
        "name"        character varying(32)    NOT NULL,
        "baseUrl"     text,
        "version"     character varying(64),
        "authRef"     character varying(255),
        "enabled"     boolean                  NOT NULL DEFAULT false,
        "updatedById" uuid,
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_integrations" PRIMARY KEY ("name"),
        CONSTRAINT "CHK_integrations_name"
          CHECK ("name" IN ('shoedna','valuelens')),
        CONSTRAINT "CHK_integrations_enabled_url"
          CHECK (NOT "enabled" OR "baseUrl" IS NOT NULL),
        CONSTRAINT "FK_integrations_updated_by" FOREIGN KEY ("updatedById")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await q.query(
      `INSERT INTO "integrations" ("name") VALUES ('shoedna'), ('valuelens')`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "integrations"`);
  }
}
