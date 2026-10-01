// "scans" table: one capture session owned by one user (F1).
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  SCAN_SOURCES,
  SCAN_STATUSES,
  type ScanSource,
  type ScanStatus,
} from '../scan.types';
import { ScanShoeEntity } from './scan-shoe.entity';
import { UserEntity } from '../../user/entities/user.entity';

@Entity('scans')
@Index('IDX_scans_user_status', ['userId', 'status'])
@Index('IDX_scans_status_updated', ['status', 'updatedAt'])
export class ScanEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_scans_user' })
  user?: UserEntity;

  @Column({
    type: 'enum',
    enum: SCAN_STATUSES,
    enumName: 'scan_status',
    default: 'draft',
  })
  status: ScanStatus;

  @Column({
    type: 'enum',
    enum: SCAN_SOURCES,
    enumName: 'scan_source',
    default: 'camera',
  })
  source: ScanSource;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => ScanShoeEntity, (shoe) => shoe.scan)
  shoes?: ScanShoeEntity[];
}
