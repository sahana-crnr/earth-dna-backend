// "scan_photos" table: one photo per (shoe, view). The DB holds only the S3 key;
// the bytes live in the SHOE_PHOTOS_BUCKET bucket.
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import {
  SHOE_VIEWS,
  UPLOAD_STATUSES,
  type ShoeView,
  type UploadStatus,
} from '../scan.types';
import { ScanShoeEntity } from './scan-shoe.entity';

@Entity('scan_photos')
@Unique('UQ_scan_photos_shoe_view', ['scanShoeId', 'view'])
export class ScanPhotoEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  scanShoeId: string;

  @ManyToOne(() => ScanShoeEntity, (shoe) => shoe.photos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'scanShoeId',
    foreignKeyConstraintName: 'FK_scan_photos_shoe',
  })
  shoe?: ScanShoeEntity;

  @Column({ type: 'enum', enum: SHOE_VIEWS, enumName: 'shoe_view' })
  view: ShoeView;

  @Column({ type: 'varchar', length: 512 })
  s3Key: string;

  @Column({ type: 'varchar', length: 50, default: 'image/jpeg' })
  contentType: string;

  @Column({ type: 'integer', nullable: true })
  bytes: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({
    type: 'enum',
    enum: UPLOAD_STATUSES,
    enumName: 'upload_status',
    default: 'uploaded',
  })
  uploadStatus: UploadStatus;

  @Column({ type: 'timestamptz', nullable: true })
  takenAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
