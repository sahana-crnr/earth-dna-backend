// F3 catalog: seeded lookup tables behind the review form dropdowns. Exports
// CatalogService so ScanModule can resolve brand / size ids inside the review
// transaction.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { CatalogController } from './catalog.controller';
import { CatalogMuteGuard } from './catalog-mute.guard';
import { CatalogService } from './catalog.service';
import { CatalogBrandEntity } from './entities/catalog-brand.entity';
import { CatalogBrandSubcategoryEntity } from './entities/catalog-brand-subcategory.entity';
import { CatalogCategoryEntity } from './entities/catalog-category.entity';
import { CatalogProductEntity } from './entities/catalog-product.entity';
import { CatalogShoeTypeEntity } from './entities/catalog-shoe-type.entity';
import { CatalogSizeEntity } from './entities/catalog-size.entity';
import { CatalogSubcategoryEntity } from './entities/catalog-subcategory.entity';
import { ConditionMappingEntity } from './entities/condition-mapping.entity';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      CatalogCategoryEntity,
      CatalogShoeTypeEntity,
      CatalogSubcategoryEntity,
      CatalogBrandEntity,
      CatalogBrandSubcategoryEntity,
      CatalogProductEntity,
      CatalogSizeEntity,
      ConditionMappingEntity,
    ]),
  ],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogMuteGuard],
  exports: [CatalogService],
})
export class CatalogModule {}
