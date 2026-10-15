// "catalog_categories": top level of the footwear taxonomy (F3-D17). Seeded by
// scripts/catalog-seed.ts; rows that vanish from the source are deactivated,
// never deleted, so a `shoes` row can always show what it was saved with.
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { CatalogShoeTypeEntity } from './catalog-shoe-type.entity';
import { CatalogSubcategoryEntity } from './catalog-subcategory.entity';

@Entity('catalog_categories')
@Unique('UQ_catalog_categories_slug', ['slug'])
@Index('IDX_catalog_categories_shoe_type', ['shoeTypeId'])
export class CatalogCategoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'smallint', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /** Figma display type this product-DB category maps onto (F5-D20); filled
   *  by the seed from keyword rules, null when nothing matches. */
  @Column({ type: 'uuid', nullable: true })
  shoeTypeId: string | null;

  @ManyToOne(() => CatalogShoeTypeEntity, (t) => t.categories, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'shoeTypeId',
    foreignKeyConstraintName: 'FK_catalog_categories_shoe_type',
  })
  shoeType?: CatalogShoeTypeEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => CatalogSubcategoryEntity, (s) => s.category)
  subcategories?: CatalogSubcategoryEntity[];
}
