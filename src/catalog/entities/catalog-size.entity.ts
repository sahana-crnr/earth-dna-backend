// "catalog_sizes": the Size dropdown (E15). Per brand (brandId set) because
// ranges differ by brand (F3-D13); the generic US list has brandId null and is
// the fallback when a brand has no sized products. Uniqueness is enforced by
// the migration with two indexes (one for the generic rows, one per brand).
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CatalogBrandEntity } from './catalog-brand.entity';

@Entity('catalog_sizes')
@Index('UQ_catalog_sizes_brand_system_label', ['brandId', 'system', 'label'], {
  unique: true,
  where: '"brandId" IS NOT NULL',
})
@Index('UQ_catalog_sizes_generic_system_label', ['system', 'label'], {
  unique: true,
  where: '"brandId" IS NULL',
})
export class CatalogSizeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  brandId: string | null;

  @ManyToOne(() => CatalogBrandEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'brandId',
    foreignKeyConstraintName: 'FK_catalog_sizes_brand',
  })
  brand?: CatalogBrandEntity;

  @Column({ type: 'varchar', length: 10, default: 'US' })
  system: string;

  @Column({ type: 'varchar', length: 20 })
  label: string;

  @Column({ type: 'smallint', default: 0 })
  sortOrder: number;
}
