// "catalog_subcategories": second level of the taxonomy, unique per category.
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
import { CatalogCategoryEntity } from './catalog-category.entity';

@Entity('catalog_subcategories')
@Unique('UQ_catalog_subcategories_category_slug', ['categoryId', 'slug'])
export class CatalogSubcategoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  categoryId: string;

  @ManyToOne(() => CatalogCategoryEntity, (c) => c.subcategories, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'categoryId',
    foreignKeyConstraintName: 'FK_catalog_subcategories_category',
  })
  category?: CatalogCategoryEntity;

  @Column({ type: 'varchar', length: 100 })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'smallint', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
