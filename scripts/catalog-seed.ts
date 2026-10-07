// Catalog seed (F3-D12, D13): reads the footwear taxonomy and the product
// export from the product database (CATALOG_SOURCE_DB_*, read only) and
// upserts them into this backend's catalog tables. Re-runnable: rows missing
// from the source are deactivated, never deleted; ids never change.
//
//   npm run catalog:seed            # taxonomy + products + sizes
//   npm run catalog:seed -- --dry   # read + plan, write nothing
//
// The API never opens the source connection; only this script does.
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import {
  DataSource,
  EntityManager,
  IsNull,
  type DeepPartial,
  type FindOptionsWhere,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { parseSource } from '../src/config/catalog.config';
import {
  genericUsSizes,
  importProducts,
  importTaxonomy,
  sizesByBrand,
  type ProductRow,
  type TaxonomyRow,
} from '../src/catalog/catalog-rules';
import { CatalogBrandEntity } from '../src/catalog/entities/catalog-brand.entity';
import { CatalogBrandSubcategoryEntity } from '../src/catalog/entities/catalog-brand-subcategory.entity';
import { CatalogCategoryEntity } from '../src/catalog/entities/catalog-category.entity';
import { CatalogProductEntity } from '../src/catalog/entities/catalog-product.entity';
import { CatalogSizeEntity } from '../src/catalog/entities/catalog-size.entity';
import { CatalogSubcategoryEntity } from '../src/catalog/entities/catalog-subcategory.entity';
import { AppDataSource } from '../src/database/data-source';

loadEnv();

const DRY = process.argv.includes('--dry');
const PAGE = 1000;
const SOURCE_TAG = 'import';

/** Source column names → the generic row shapes the rules understand. The
 *  mapping lives here only, so a different export touches one place. */
const TAXONOMY_SQL = (schema: string) =>
  `SELECT category, subcategory, brand FROM "${schema}"."tracker" WHERE brand IS NOT NULL AND brand <> ''`;
const PRODUCTS_SQL = (schema: string) =>
  `SELECT sku_id AS sku, brand_s3 AS brand, model, model_code AS "modelCode",
          category, sub_category AS "subCategory", silhouette, gender,
          colour_raw AS colour, size, msrp_original AS msrp,
          listed_date::text AS "releaseDate", title
     FROM "${schema}"."products"
    WHERE sku_id IS NOT NULL AND brand_s3 IS NOT NULL AND brand_s3 <> ''
    ORDER BY sku_id
    LIMIT $1 OFFSET $2`;

async function main(): Promise<void> {
  const src = parseSource(process.env);
  if (!src) {
    throw new Error(
      'CATALOG_SOURCE_DB_HOST / PORT / USERNAME / PASSWORD / NAME / SCHEMA must all be set',
    );
  }
  const source = new DataSource({
    type: 'postgres',
    host: src.host,
    port: src.port,
    username: src.username,
    password: src.password,
    database: src.database,
    ssl: src.ssl ? { rejectUnauthorized: false } : false,
    logging: false,
  });
  await source.initialize();
  // The CLI data source logs every query; 21k upserts would drown the summary.
  AppDataSource.setOptions({ logging: false });
  await AppDataSource.initialize();

  try {
    // ─── taxonomy ──────────────────────────────────────────────────────────
    const taxonomyRows: TaxonomyRow[] = await source.query(
      TAXONOMY_SQL(src.schema),
    );
    const plan = importTaxonomy(taxonomyRows);
    console.log(
      `taxonomy: ${taxonomyRows.length} rows → ${plan.categories.length} categories, ${plan.subcategories.length} sub-categories, ${plan.brands.length} brands, ${plan.links.length} links, ${plan.skipped} skipped`,
    );

    // ─── products (paged) ──────────────────────────────────────────────────
    const productRows: ProductRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page: ProductRow[] = await source.query(PRODUCTS_SQL(src.schema), [
        PAGE,
        offset,
      ]);
      productRows.push(...page);
      if (page.length < PAGE) break;
    }
    const { products, skipped: productsSkipped } = importProducts(productRows);
    // Brands seen only in products still get a catalog row, so every product
    // can be attached; they carry no taxonomy links.
    const brandSlugs = new Set(plan.brands.map((b) => b.slug));
    const extraBrands = [...new Set(products.map((p) => p.brandSlug))]
      .filter((s) => !brandSlugs.has(s))
      .sort();
    const perBrandSizes = sizesByBrand(products);
    console.log(
      `products: ${productRows.length} rows → ${products.length} upserts, ${productsSkipped} skipped, ${extraBrands.length} brands not in taxonomy, ${perBrandSizes.size} brands with sizes`,
    );
    if (DRY) {
      console.log('dry run — nothing written');
      return;
    }

    await AppDataSource.transaction(async (m) => {
      const now = new Date();
      // categories
      const catIds = new Map<string, string>();
      for (const [i, c] of plan.categories.entries()) {
        const row = await upsertBySlug(m, CatalogCategoryEntity, c.slug, {
          name: c.name,
          sortOrder: i,
          isActive: true,
        });
        catIds.set(c.slug, row.id);
      }
      await deactivateMissing(m, CatalogCategoryEntity, [...catIds.keys()]);

      // sub-categories
      const subIds = new Map<string, string>();
      for (const [i, s] of plan.subcategories.entries()) {
        const categoryId = catIds.get(s.categorySlug)!;
        let row = await m.findOne(CatalogSubcategoryEntity, {
          where: { categoryId, slug: s.slug },
        });
        if (row) {
          await m.update(
            CatalogSubcategoryEntity,
            { id: row.id },
            { name: s.name, sortOrder: i, isActive: true },
          );
        } else {
          row = await m.save(
            m.create(CatalogSubcategoryEntity, {
              categoryId,
              slug: s.slug,
              name: s.name,
              sortOrder: i,
              isActive: true,
            }),
          );
        }
        subIds.set(`${s.categorySlug}/${s.slug}`, row.id);
      }
      if (subIds.size > 0) {
        await m
          .createQueryBuilder()
          .update(CatalogSubcategoryEntity)
          .set({ isActive: false })
          .where('id NOT IN (:...ids)', { ids: [...subIds.values()] })
          .execute();
      }

      // brands (taxonomy first, then product-only brands)
      const brandIds = new Map<string, string>();
      const allBrands = [
        ...plan.brands,
        ...extraBrands.map((slug) => ({ slug, name: titleFromSlug(slug) })),
      ];
      for (const [i, b] of allBrands.entries()) {
        const row = await upsertBySlug(m, CatalogBrandEntity, b.slug, {
          name: b.name,
          sortOrder: i,
          isActive: true,
        });
        brandIds.set(b.slug, row.id);
      }
      await deactivateMissing(m, CatalogBrandEntity, [...brandIds.keys()]);

      // links: rebuild (cheap, no ids to preserve)
      await m.clear(CatalogBrandSubcategoryEntity);
      const links = plan.links
        .map((l) => ({
          brandId: brandIds.get(l.brandSlug)!,
          subcategoryId: subIds.get(`${l.categorySlug}/${l.subcategorySlug}`)!,
        }))
        .filter((l) => l.brandId && l.subcategoryId);
      for (let i = 0; i < links.length; i += PAGE) {
        await m.insert(CatalogBrandSubcategoryEntity, links.slice(i, i + PAGE));
      }

      // products: upsert by sku in pages, deactivate the rest
      const skus = new Set<string>();
      for (let i = 0; i < products.length; i += PAGE) {
        const slice = products.slice(i, i + PAGE).map((p) => ({
          sku: p.sku,
          brandId: brandIds.get(p.brandSlug)!,
          model: p.model,
          modelCode: p.modelCode,
          category: p.category,
          subCategory: p.subCategory,
          silhouette: p.silhouette,
          gender: p.gender,
          colour: p.colour,
          size: p.size,
          sizeRaw: p.sizeRaw,
          msrp: p.msrp,
          releaseDate: p.releaseDate,
          title: p.title,
          source: SOURCE_TAG,
          isActive: true,
          importedAt: now,
        }));
        await m
          .createQueryBuilder()
          .insert()
          .into(CatalogProductEntity)
          .values(slice)
          .orUpdate(
            [
              'brandId',
              'model',
              'modelCode',
              'category',
              'subCategory',
              'silhouette',
              'gender',
              'colour',
              'size',
              'sizeRaw',
              'msrp',
              'releaseDate',
              'title',
              'source',
              'isActive',
              'importedAt',
            ],
            ['sku'],
          )
          .execute();
        slice.forEach((p) => skus.add(p.sku));
      }
      await m
        .createQueryBuilder()
        .update(CatalogProductEntity)
        .set({ isActive: false })
        .where('"importedAt" < :now', { now })
        .execute();

      // sizes: per brand from products; generic list always present
      let sizeRows = 0;
      for (const [slug, labels] of perBrandSizes) {
        const brandId = brandIds.get(slug);
        if (!brandId) continue;
        await m.delete(CatalogSizeEntity, { brandId, system: 'US' });
        await m.insert(
          CatalogSizeEntity,
          labels.map((label, i) => ({
            brandId,
            system: 'US',
            label,
            sortOrder: i,
          })),
        );
        sizeRows += labels.length;
      }
      // Generic list: insert whatever label is missing (never delete — a
      // `shoes.sizeId` may point at one of these rows).
      const generic = genericUsSizes();
      const have = new Set(
        (
          await m.find(CatalogSizeEntity, {
            where: { brandId: IsNull(), system: 'US' },
            select: { label: true },
          })
        ).map((r) => r.label),
      );
      const missingGeneric = generic
        .map((label, i) => ({
          brandId: null,
          system: 'US',
          label,
          sortOrder: i,
        }))
        .filter((r) => !have.has(r.label));
      if (missingGeneric.length > 0)
        await m.insert(CatalogSizeEntity, missingGeneric);
      console.log(
        `written: ${catIds.size} categories, ${subIds.size} sub-categories, ${brandIds.size} brands, ${links.length} links, ${skus.size} products, ${sizeRows} brand sizes, generic sizes +${missingGeneric.length}`,
      );
    });
  } finally {
    await source.destroy();
    await AppDataSource.destroy();
  }
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function upsertBySlug<T extends { id: string; slug: string }>(
  m: EntityManager,
  entity: new () => T,
  slug: string,
  values: QueryDeepPartialEntity<T>,
): Promise<T> {
  const where = { slug } as FindOptionsWhere<T>;
  const existing = await m.findOne(entity, { where });
  if (existing) {
    await m.update(entity, { id: existing.id }, values);
    return existing;
  }
  return m.save(m.create(entity, { slug, ...values } as DeepPartial<T>));
}

async function deactivateMissing<T extends { slug: string; isActive: boolean }>(
  m: EntityManager,
  entity: new () => T,
  keepSlugs: string[],
): Promise<void> {
  const qb = m
    .createQueryBuilder()
    .update(entity)
    .set({ isActive: false } as unknown as QueryDeepPartialEntity<T>);
  if (keepSlugs.length > 0)
    qb.where('slug NOT IN (:...slugs)', { slugs: keepSlugs });
  await qb.execute();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
