// "shoe_photos": every photo of a My Shoes entry (F5-D17). On review the four
// captured scan views are copied in as `scan` rows pointing at the same S3
// objects; the Edit screen adds `upload` rows under shoes/{userId}/{shoeId}/.
// Deleting a `scan` row never touches S3 (the scan still owns the object);
// deleting an `upload` row removes it.
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  SHOE_PHOTO_SOURCES,
  SHOE_VIEWS,
  type ShoePhotoSource,
  type ShoeView,
} from '../../scan/scan.types';
import { ScanPhotoEntity } from '../../scan/entities/scan-photo.entity';
import { ShoeEntity } from './shoe.entity';

@Entity('shoe_photos')
@Index('IDX_shoe_photos_shoe_order', ['shoeId', 'sortOrder'])
@Index('UQ_shoe_photos_scan_photo', ['shoeId', 'scanPhotoId'], {
  unique: true,
  where: '"scanPhotoId" IS NOT NULL',
})
export class ShoePhotoEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  shoeId: string;

  @ManyToOne(() => ShoeEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'shoeId',
    foreignKeyConstraintName: 'FK_shoe_photos_shoe',
  })
  shoe?: ShoeEntity;

  @Column({
    type: 'enum',
    enum: SHOE_PHOTO_SOURCES,
    enumName: 'shoe_photo_source',
  })
  source: ShoePhotoSource;

  /** The scan photo this row mirrors; null for uploads and after a purge. */
  @Column({ type: 'uuid', nullable: true })
  scanPhotoId: string | null;

  @ManyToOne(() => ScanPhotoEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'scanPhotoId',
    foreignKeyConstraintName: 'FK_shoe_photos_scan_photo',
  })
  scanPhoto?: ScanPhotoEntity;

  /** Captured view for `scan` rows (Figma "Your Scans" labels); null for uploads. */
  @Column({
    type: 'enum',
    enum: SHOE_VIEWS,
    enumName: 'shoe_view',
    nullable: true,
  })
  view: ShoeView | null;

  @Column({ type: 'varchar', length: 512 })
  s3Key: string;

  @Column({ type: 'varchar', length: 50, default: 'image/jpeg' })
  contentType: string;

  @Column({ type: 'integer', nullable: true })
  sizeBytes: number | null;

  @Column({ type: 'smallint', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
