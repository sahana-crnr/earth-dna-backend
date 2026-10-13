// Builds the results view (E11, and the response of E12 / E13) from entities
// inside whatever EntityManager the caller holds — a plain read for F2, the
// review transaction for F3 — so a committed review is never reported from a
// second, possibly stale, read. One builder, one shape (F3-D11).
import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { slugify } from '../catalog/catalog-rules';
import { CatalogService } from '../catalog/catalog.service';
import { ShoeEntity } from '../shoes/entities/shoe.entity';
import { ShoeViewMapper } from '../shoes/shoe-view.mapper';
import { ScanEntity } from './entities/scan.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import { CatalogBrandEntity } from '../catalog/entities/catalog-brand.entity';
import type { FindOptionsSelect } from 'typeorm';
import {
  conditionLabelFor,
  matchPercent,
  resultStatusFor,
} from './result-rules';
import { isUnknownBrand, reviewStateFor, reviewedCount } from './review-rules';
import { labelFor } from './scan-rules';
import type {
  ScanResultsView,
  ShoeResultEntryView,
  ShoeResultView,
} from './scan-result.view';

@Injectable()
export class ScanResultsBuilder {
  constructor(
    private readonly catalog: CatalogService,
    private readonly shoeViews: ShoeViewMapper,
  ) {}

  /**
   * @param preloadedShoes the session's shoes when the caller already holds
   *   them (the review transaction), ordered by position; else they are read.
   */
  async build(
    m: EntityManager,
    scan: ScanEntity,
    includeRaw = false,
    preloadedShoes?: ScanShoeEntity[],
  ): Promise<ScanResultsView> {
    const shoes =
      preloadedShoes ??
      (await m.find(ScanShoeEntity, {
        where: { scanId: scan.id },
        order: { position: 'ASC' },
      }));
    const ids = shoes.map((s) => s.id);
    const [results, entries] = ids.length
      ? await Promise.all([
          // E11 is polled every ~2 s: leave the large `raw` jsonb out of the
          // read unless the caller asked for it (PR 13 review).
          m.find(ScanShoeResultEntity, {
            where: { scanShoeId: In(ids) },
            select: resultColumns(includeRaw),
          }),
          m.find(ShoeEntity, { where: { scanShoeId: In(ids) } }),
        ])
      : [[], []];
    const resultByShoe = new Map(results.map((r) => [r.scanShoeId, r]));
    const entryByShoe = new Map(entries.map((e) => [e.scanShoeId, e]));
    // The brand prefill is only needed for shoes still waiting for a review;
    // once every shoe is reviewed (or nothing is identified) skip the query.
    const needsSuggestion = shoes.some(
      (s) =>
        reviewStateFor(s.status) === null &&
        resultByShoe.get(s.id)?.brand != null,
    );
    const brands = needsSuggestion
      ? await this.catalog.brandsByNames(
          m,
          shoes
            .filter((s) => reviewStateFor(s.status) === null)
            .map((s) => resultByShoe.get(s.id)?.brand ?? null),
        )
      : new Map<string, CatalogBrandEntity>();

    // Thumbnail signing is the only async step per shoe; run them together.
    const views: ShoeResultEntryView[] = await Promise.all(
      shoes.map(async (s) => {
        const row = resultByShoe.get(s.id) ?? null;
        const entry = entryByShoe.get(s.id) ?? null;
        const predicted = row && !isUnknownBrand(row.brand) ? row.brand : null;
        const suggestedBrand = predicted
          ? (brands.get(slugify(predicted)) ?? null)
          : null;
        return {
          shoeId: s.id,
          position: s.position,
          label: labelFor(s.position),
          status: resultStatusFor(row?.outcome ?? null),
          result: row ? toResultView(row, includeRaw) : null,
          review: reviewStateFor(s.status),
          myShoeId: entry?.id ?? null,
          myShoe: entry ? await this.shoeViews.toMyShoeView(entry) : null,
          suggested: {
            brandId: suggestedBrand?.id ?? null,
            brand: suggestedBrand?.name ?? predicted,
          },
        };
      }),
    );
    return {
      scanId: scan.id,
      status: scan.status,
      allResolved: shoes.length > 0 && views.every((e) => e.result !== null),
      reviewed: reviewedCount(shoes),
      shoes: views,
    };
  }
}

/** Every result column except `raw`, which is added only on request. */
function resultColumns(
  includeRaw: boolean,
): FindOptionsSelect<ScanShoeResultEntity> {
  return {
    id: true,
    scanShoeId: true,
    source: true,
    outcome: true,
    modelVersion: true,
    brand: true,
    subBrand: true,
    model: true,
    colorway: true,
    category: true,
    subCategory: true,
    material: true,
    confidence: true,
    conditionCode: true,
    candidates: true,
    submittedAt: true,
    createdAt: true,
    updatedAt: true,
    ...(includeRaw ? { raw: true } : {}),
  };
}

/** Entity → response. The label and matchPercent are derived, never stored.
 *  `raw` is spread in only when asked for, so the key is absent rather than
 *  null when it was simply not requested. */
export function toResultView(
  row: ScanShoeResultEntity,
  includeRaw: boolean,
): ShoeResultView {
  return {
    source: row.source,
    outcome: row.outcome,
    modelVersion: row.modelVersion,
    brand: row.brand,
    subBrand: row.subBrand,
    model: row.model,
    colorway: row.colorway,
    category: row.category,
    subCategory: row.subCategory,
    material: row.material,
    confidence: row.confidence,
    matchPercent: matchPercent(row.confidence),
    condition: {
      code: row.conditionCode,
      label: conditionLabelFor(row.conditionCode),
    },
    candidates: row.candidates ?? [],
    ...(includeRaw ? { raw: row.raw ?? null } : {}),
    submittedAt: new Date(row.submittedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
