// "catalog_shoe_types": the six display types of the Figma Shoe Type dropdown
// (Edit shoe details, Find Your Shoe). Seeded by the F5 migration, never by the
// product-DB seed; product-DB categories are mapped onto one of them through
// catalog_categories.shoeTypeId (F5-D20).
import {
  Column,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CatalogCategoryEntity } from './catalog-category.entity';

@Entity('catalog_shoe_types')
@Index('UQ_catalog_shoe_types_slug', ['slug'], { unique: true })
export class CatalogShoeTypeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 60 })
  slug: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'smallint', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @OneToMany(() => CatalogCategoryEntity, (c) => c.shoeType)
  categories?: CatalogCategoryEntity[];
}
