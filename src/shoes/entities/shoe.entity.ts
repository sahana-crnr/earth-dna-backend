// "shoes" — the My Shoes entry, created by an F3 review (confirm or reject)
// and read by F4 (list), F5 (profile) and F6 (home stats). The full F4/F5
// schema is created now (F3-D13b) so later features add no migration for it;
// F3 fills identity + placeholders and leaves the action / share columns alone.
//
// Identity is stored as id + text on purpose: `brandId` / `sizeId` keep the
// dropdown round-trip, `brand` / `size` keep the display value even if the
// catalog row is later deactivated.
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import {
  ACTION_TAKEN,
  CONDITION_CODES,
  GENDERS,
  RECOMMENDED_ACTIONS,
  RESALE_BUCKETS,
  VALUE_SOURCES,
  type ActionTaken,
  type ConditionCode,
  type Gender,
  type RecommendedAction,
  type ResaleBucket,
  type ValueSource,
} from '../../scan/scan.types';
import { UserEntity } from '../../user/entities/user.entity';
import { ScanShoeEntity } from '../../scan/entities/scan-shoe.entity';
import { CatalogBrandEntity } from '../../catalog/entities/catalog-brand.entity';
import { CatalogSizeEntity } from '../../catalog/entities/catalog-size.entity';
import { CatalogProductEntity } from '../../catalog/entities/catalog-product.entity';

const money = {
  to: (v: number | null) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

@Entity('shoes')
@Unique('UQ_shoes_scan_shoe', ['scanShoeId'])
@Index('IDX_shoes_user_deleted', ['userId', 'deletedAt'])
@Index('IDX_shoes_user_action', ['userId', 'actionTaken'])
@Index('IDX_shoes_user_recommended', ['userId', 'recommendedAction'])
@Index('IDX_shoes_user_bucket', ['userId', 'resaleBucket'])
export class ShoeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_shoes_user' })
  user?: UserEntity;

  /** Origin scan shoe; one entry per scan shoe (F3-D9). Null only after the
   *  scan was purged (abandon job / account flow). */
  @Column({ type: 'uuid', nullable: true })
  scanShoeId: string | null;

  @OneToOne(() => ScanShoeEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'scanShoeId',
    foreignKeyConstraintName: 'FK_shoes_scan_shoe',
  })
  scanShoe?: ScanShoeEntity;

  // ─── identity (F3) ───────────────────────────────────────────────────────
  @Column({ type: 'uuid', nullable: true })
  brandId: string | null;

  @ManyToOne(() => CatalogBrandEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'brandId', foreignKeyConstraintName: 'FK_shoes_brand' })
  brandRef?: CatalogBrandEntity;

  @Column({ type: 'varchar', length: 120 })
  brand: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  subBrand: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  subCategory: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  model: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  colorway: string | null;

  @Column({ type: 'uuid', nullable: true })
  sizeId: string | null;

  @ManyToOne(() => CatalogSizeEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'sizeId', foreignKeyConstraintName: 'FK_shoes_size' })
  sizeRef?: CatalogSizeEntity;

  @Column({ type: 'varchar', length: 20, nullable: true })
  size: string | null;

  @Column({
    type: 'enum',
    enum: GENDERS,
    enumName: 'shoe_gender',
    nullable: true,
  })
  gender: Gender | null;

  @Column({
    type: 'enum',
    enum: CONDITION_CODES,
    enumName: 'shoe_condition_code',
    nullable: true,
  })
  conditionCode: ConditionCode | null;

  /** From ShoeDNA once the model returns it; null today (F3-D5). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  material: string | null;

  /** Silent catalog match on review (F3-D7); null on a miss. */
  @Column({ type: 'uuid', nullable: true })
  catalogProductId: string | null;

  @ManyToOne(() => CatalogProductEntity, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'catalogProductId',
    foreignKeyConstraintName: 'FK_shoes_catalog_product',
  })
  catalogProduct?: CatalogProductEntity;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: money,
  })
  msrp: number | null;

  // ─── value + recommendation (placeholder now, ValueLens later) ───────────
  @Column({
    type: 'enum',
    enum: RECOMMENDED_ACTIONS,
    enumName: 'recommended_action',
    nullable: true,
  })
  recommendedAction: RecommendedAction | null;

  @Column({
    type: 'enum',
    enum: ACTION_TAKEN,
    enumName: 'action_taken',
    default: 'none',
  })
  actionTaken: ActionTaken;

  @Column({ type: 'timestamptz', nullable: true })
  actionTakenAt: Date | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: money,
  })
  resaleMin: number | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: money,
  })
  resaleMax: number | null;

  @Column({ type: 'char', length: 3, default: 'USD' })
  resaleCurrency: string;

  @Column({
    type: 'enum',
    enum: RESALE_BUCKETS,
    enumName: 'resale_bucket',
    nullable: true,
  })
  resaleBucket: ResaleBucket | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  demandNote: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  recommendationReason: string | null;

  @Column({
    type: 'numeric',
    precision: 8,
    scale: 2,
    nullable: true,
    transformer: money,
  })
  co2eKg: number | null;

  @Column({
    type: 'enum',
    enum: VALUE_SOURCES,
    enumName: 'value_source',
    default: 'static',
  })
  valueSource: ValueSource;

  @Column({ type: 'varchar', length: 50, nullable: true })
  valueSourceVersion: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  valueComputedAt: Date | null;

  /** Copy of the chosen scan photo key for the card thumbnail (F3-D3). */
  @Column({ type: 'varchar', length: 512, nullable: true })
  primaryPhotoS3Key: string | null;

  /** "Remove Shoe" (F5) is a soft delete; feedback rows survive. */
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
