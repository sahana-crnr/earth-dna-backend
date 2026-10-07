// "catalog_brand_subcategories": which brands sit in which sub-category,
// straight from the taxonomy rows. Composite key, no surrogate id.
import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { CatalogBrandEntity } from './catalog-brand.entity';
import { CatalogSubcategoryEntity } from './catalog-subcategory.entity';

@Entity('catalog_brand_subcategories')
export class CatalogBrandSubcategoryEntity {
  @PrimaryColumn({ type: 'uuid' })
  brandId: string;

  @PrimaryColumn({ type: 'uuid' })
  subcategoryId: string;

  @ManyToOne(() => CatalogBrandEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'brandId',
    foreignKeyConstraintName: 'FK_catalog_brand_subcategories_brand',
  })
  brand?: CatalogBrandEntity;

  @ManyToOne(() => CatalogSubcategoryEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'subcategoryId',
    foreignKeyConstraintName: 'FK_catalog_brand_subcategories_subcategory',
  })
  subcategory?: CatalogSubcategoryEntity;
}
