// "integrations" — one row per external model endpoint (F7): ShoeDNA and
// ValueLens. Keyed by name, seeded by the CreateIntegrations migration, so the
// set of integrations is a schema fact and PUT never creates rows.
//
// `authRef` is a REFERENCE to a credential (e.g. a Secrets Manager secret
// name), never the credential itself: the admin API returns it verbatim, so a
// real key stored here would be readable by anyone holding an admin token.
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from '../../user/entities/user.entity';
import type { IntegrationName } from '../integration.types';

@Entity('integrations')
export class IntegrationEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  name: IntegrationName;

  @Column({ type: 'text', nullable: true })
  baseUrl: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  version: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  authRef: string | null;

  /** CHECK: cannot be true while baseUrl is null. */
  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  /** Last admin to change the row; SET NULL so the audit outlives the account. */
  @Column({ type: 'uuid', nullable: true })
  updatedById: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'updatedById',
    foreignKeyConstraintName: 'FK_integrations_updated_by',
  })
  updatedBy?: UserEntity | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
