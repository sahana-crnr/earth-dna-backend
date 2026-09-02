import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRefreshTokensTable1785997681440 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id"                uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "userId"            uuid                     NOT NULL,
        "tokenHash"         character varying(64)    NOT NULL,
        "expiresAt"         TIMESTAMP WITH TIME ZONE NOT NULL,
        "revokedAt"         TIMESTAMP WITH TIME ZONE,
        "replacedByTokenId" uuid,
        "userAgent"         character varying(255),
        "createdAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("userId")
          REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_refresh_tokens_userId" ON "refresh_tokens" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_refresh_tokens_userId"`);
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
  }
}
