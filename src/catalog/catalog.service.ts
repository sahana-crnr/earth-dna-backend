// F3 catalog lookups (E14–E19). Plain repository reads over the seeded tables;
// every list filters isActive and is capped by CATALOG_LIST_MAX so a runaway
// import can never turn a dropdown into a megabyte. Resolution helpers for the
// review service live here too, so "what is a valid brand id" has one answer.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, ILike, In, IsNull, Repository } from 'typeorm';
import type { CatalogConfig } from '../config/catalog.config';
import { GENDERS } from '../scan/scan.types';
import { CatalogBrandEntity } from './entities/catalog-brand.entity';
import { CatalogCategoryEntity } from './entities/catalog-category.entity';
import { CatalogProductEntity } from './entities/catalog-product.entity';
import { CatalogSizeEntity } from './entities/catalog-size.entity';
import { sizeSortKey, slugify } from './catalog-rules';
import type {
  BrandItemView,
  CategoryItemView,
  ColourItemView,
  ListView,
  ModelItemView,
  OptionsView,
  SizeItemView,
} from './catalog.view';

/** Escapes LIKE wildcards in user text so `%` cannot widen a prefix search. */
const likePrefix = (q: string) => `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

@Injectable()
export class CatalogService {
  private readonly cfg: CatalogConfig;

  constructor(
    @InjectRepository(CatalogBrandEntity)
    private readonly brands: Repository<CatalogBrandEntity>,
    @InjectRepository(CatalogCategoryEntity)
    private readonly categories: Repository<CatalogCategoryEntity>,
    @InjectRepository(CatalogSizeEntity)
    private readonly sizes: Repository<CatalogSizeEntity>,
    @InjectRepository(CatalogProductEntity)
    private readonly products: Repository<CatalogProductEntity>,
    config: ConfigService,
  ) {
    this.cfg = config.get<CatalogConfig>('catalog')!;
  }

  // ─── E14 brands ──────────────────────────────────────────────────────────
  async listBrands(q?: string): Promise<ListView<BrandItemView>> {
    const where = q
      ? { isActive: true, name: ILike(likePrefix(q)) }
      : { isActive: true };
    const rows = await this.brands.find({
      where,
      order: { name: 'ASC', id: 'ASC' },
      take: this.cfg.listMax,
    });
    return { items: rows.map(brandView) };
  }

  // ─── E15 sizes ───────────────────────────────────────────────────────────
  /** Per-brand list when the brand has sized products, else the generic list. */
  async listSizes(brandId?: string): Promise<ListView<SizeItemView>> {
    let rows: CatalogSizeEntity[] = [];
    if (brandId) {
      rows = await this.sizes.find({
        where: { brandId, system: 'US' },
        take: this.cfg.listMax,
      });
    }
    if (rows.length === 0) {
      rows = await this.sizes.find({
        where: { brandId: IsNull(), system: 'US' },
        take: this.cfg.listMax,
      });
    }
    rows.sort(
      (a, b) =>
        sizeSortKey(a.label) - sizeSortKey(b.label) ||
        a.label.localeCompare(b.label),
    );
    return {
      items: rows.map((s) => ({ id: s.id, label: s.label, system: s.system })),
      generic: rows.length > 0 && rows[0].brandId === null,
    };
  }

  // ─── E16 categories (nested) ─────────────────────────────────────────────
  async listCategories(): Promise<ListView<CategoryItemView>> {
    const rows = await this.categories.find({
      where: { isActive: true },
      relations: { subcategories: true },
      order: { name: 'ASC', id: 'ASC' },
      take: this.cfg.listMax,
    });
    return {
      items: rows.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        subcategories: (c.subcategories ?? [])
          .filter((s) => s.isActive)
          .sort(
            (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
          )
          .map((s) => ({ id: s.id, name: s.name, slug: s.slug })),
      })),
    };
  }

  // ─── E17 models ──────────────────────────────────────────────────────────
  async listModels(
    brandId: string,
    q?: string,
  ): Promise<ListView<ModelItemView>> {
    const qb = this.products
      .createQueryBuilder('p')
      .select('p.model', 'model')
      .addSelect('MIN(p."modelCode")', 'modelCode')
      .where(
        'p."brandId" = :brandId AND p."isActive" = true AND p.model IS NOT NULL',
        {
          brandId,
        },
      )
      .groupBy('p.model')
      .orderBy('p.model', 'ASC')
      .limit(this.cfg.listMax);
    if (q) qb.andWhere('p.model ILIKE :q', { q: likePrefix(q) });
    const rows = await qb.getRawMany<{
      model: string;
      modelCode: string | null;
    }>();
    return {
      items: rows.map((r) => ({ model: r.model, modelCode: r.modelCode })),
    };
  }

  // ─── E18 colours ─────────────────────────────────────────────────────────
  async listColours(
    brandId: string,
    model?: string,
  ): Promise<ListView<ColourItemView>> {
    const qb = this.products
      .createQueryBuilder('p')
      .select('p.colour', 'colour')
      .where(
        'p."brandId" = :brandId AND p."isActive" = true AND p.colour IS NOT NULL',
        {
          brandId,
        },
      )
      .groupBy('p.colour')
      .orderBy('p.colour', 'ASC')
      .limit(this.cfg.listMax);
    if (model) qb.andWhere('LOWER(p.model) = LOWER(:model)', { model });
    const rows = await qb.getRawMany<{ colour: string }>();
    return { items: rows.map((r) => ({ colour: r.colour })) };
  }

  // ─── E19 options ─────────────────────────────────────────────────────────
  options(): OptionsView {
    return { genders: [...GENDERS] };
  }

  // ─── resolution for the review service (transaction-scoped) ─────────────
  async brandById(
    m: EntityManager,
    id: string,
  ): Promise<CatalogBrandEntity | null> {
    return m.findOne(CatalogBrandEntity, { where: { id, isActive: true } });
  }

  /** ShoeDNA brand text → catalog row by slug; null when not in the catalog. */
  async brandByName(
    m: EntityManager,
    name: string | null,
  ): Promise<CatalogBrandEntity | null> {
    const slug = slugify(name ?? '');
    if (!slug) return null;
    return m.findOne(CatalogBrandEntity, { where: { slug, isActive: true } });
  }

  async brandsByNames(
    m: EntityManager,
    names: readonly (string | null)[],
  ): Promise<Map<string, CatalogBrandEntity>> {
    const slugs = [
      ...new Set(names.map((n) => slugify(n ?? '')).filter(Boolean)),
    ];
    if (slugs.length === 0) return new Map();
    const rows = await m.find(CatalogBrandEntity, {
      where: { slug: In(slugs), isActive: true },
    });
    return new Map(rows.map((r) => [r.slug, r]));
  }

  /**
   * A size id is valid only when it belongs to the chosen brand or is a
   * generic (brandId null) row — a client cannot pair any size with any brand
   * (PR 13 review). Pass `brandId` null to accept generic sizes only.
   */
  async sizeById(
    m: EntityManager,
    id: string,
    brandId: string | null,
  ): Promise<CatalogSizeEntity | null> {
    const size = await m.findOne(CatalogSizeEntity, { where: { id } });
    if (!size) return null;
    if (size.brandId !== null && size.brandId !== brandId) return null;
    return size;
  }

  /**
   * Silent product match (F3-D7): brand + model (case-insensitive), and at
   * least one of colour or size must agree — msrp only breaks ties, it never
   * qualifies a candidate on its own (PR 13 review). Never an error — null on
   * a miss. Candidates come back in sku order so ties are deterministic.
   */
  async matchProduct(
    m: EntityManager,
    brandId: string | null,
    model: string | null,
    colour: string | null,
    size: string | null,
  ): Promise<CatalogProductEntity | null> {
    if (!brandId || !model) return null;
    const candidates = await m
      .getRepository(CatalogProductEntity)
      .createQueryBuilder('p')
      .where('p."brandId" = :brandId AND p."isActive" = true', { brandId })
      .andWhere('LOWER(p.model) = LOWER(:model)', { model: model.trim() })
      .orderBy('p.sku', 'ASC')
      .limit(200)
      .getMany();
    if (candidates.length === 0) return null;
    const c = (colour ?? '').trim().toLowerCase();
    const s = (size ?? '').trim();
    let best: CatalogProductEntity | null = null;
    let bestScore = -1;
    for (const p of candidates) {
      let score = 0;
      if (c && p.colour && p.colour.toLowerCase().includes(c)) score += 2;
      if (s && p.size === s) score += 1;
      if (score === 0) continue; // no colour / size evidence → not this SKU
      if (p.msrp !== null) score += 0.5;
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    return best;
  }
}

export function brandView(b: CatalogBrandEntity): BrandItemView {
  return { id: b.id, name: b.name, slug: b.slug };
}
