import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersTable1780045191895
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"                  uuid                     NOT NULL DEFAULT uuid_generate_v4(),
        "fullName"            character varying(255)   NOT NULL,
        "email"               character varying(255)   NOT NULL,
        "password"            character varying(255)   NOT NULL,
        "resetPasswordToken"  character varying(64),
        "resetPasswordExpiry" TIMESTAMP WITH TIME ZONE,
        "country"             character varying(100)   NOT NULL,
        "zipCode"             character varying(20),
        "createdAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
