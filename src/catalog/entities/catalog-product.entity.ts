// "catalog_products": one retail product (SKU) per row. Feeds the model and
// colour lists (E17, E18), the per-brand size list, and the silent product
// match on review that stores catalogProductId + msrp on `shoes` (F3-D7) for
// ValueLens later. `size` is the normalised US label; `sizeRaw` keeps what the
// source said. `source` names the import, not the vendor.
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GENDERS, type Gender } from '../../scan/scan.types';
import { CatalogBrandEntity } from './catalog-brand.entity';

@Entity('catalog_products')
@Index('IDX_catalog_products_brand_model', ['brandId', 'model'])
@Index('IDX_catalog_products_brand_size', ['brandId', 'size'])
export class CatalogProductEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  brandId: string;

  @ManyToOne(() => CatalogBrandEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'brandId',
    foreignKeyConstraintName: 'FK_catalog_products_brand',
  })
  brand?: CatalogBrandEntity;

  /** Retail identifier from the source (unique). */
  @Column({ type: 'varchar', length: 40, unique: true })
  sku: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  model: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  modelCode: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  subCategory: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  silhouette: string | null;

  @Column({
    type: 'enum',
    enum: GENDERS,
    enumName: 'shoe_gender',
    nullable: true,
  })
  gender: Gender | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  colour: string | null;

  /** Normalised US size label ("7.5"); null when the source value was unusable. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  size: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  sizeRaw: string | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: {
      to: (v: number | null) => v,
      from: (v: string | null) => (v === null ? null : Number(v)),
    },
  })
  msrp: number | null;

  @Column({ type: 'date', nullable: true })
  releaseDate: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  title: string | null;

  @Column({ type: 'varchar', length: 40, default: 'import' })
  source: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  importedAt: Date;
}
