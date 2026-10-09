// "scan_shoes" table: one shoe inside a scan session. Label and completeness
// are derived from `position` and the photos, never stored (F1-D6).
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { SCAN_SHOE_STATUSES, type ScanShoeStatus } from '../scan.types';
import { ScanEntity } from './scan.entity';
import { ScanPhotoEntity } from './scan-photo.entity';
import { ShoeEntity } from '../../shoes/entities/shoe.entity';

@Entity('scan_shoes')
@Unique('UQ_scan_shoes_scan_position', ['scanId', 'position'], {
  deferrable: 'INITIALLY DEFERRED',
})
@Check('CHK_scan_shoes_position', '"position" > 0')
export class ScanShoeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  scanId: string;

  @ManyToOne(() => ScanEntity, (scan) => scan.shoes, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'scanId',
    foreignKeyConstraintName: 'FK_scan_shoes_scan',
  })
  scan?: ScanEntity;

  /** 1-based; contiguous after every removal. */
  @Column({ type: 'smallint' })
  position: number;

  @Column({
    type: 'enum',
    enum: SCAN_SHOE_STATUSES,
    enumName: 'scan_shoe_status',
    default: 'capturing',
  })
  status: ScanShoeStatus;

  /** Set when created by "Rescan shoe" (F5). FK to shoes added by the F3
   *  migration, now that the table exists. */
  @Column({ type: 'uuid', nullable: true })
  rescanOfShoeId: string | null;

  @ManyToOne(() => ShoeEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'rescanOfShoeId',
    foreignKeyConstraintName: 'FK_scan_shoes_rescan_of_shoe',
  })
  rescanOf?: ShoeEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => ScanPhotoEntity, (photo) => photo.shoe)
  photos?: ScanPhotoEntity[];
}
