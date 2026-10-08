// Builds the results view (E11, and the response of E12 / E13) from entities
// inside whatever EntityManager the caller holds — a plain read for F2, the
// review transaction for F3 — so a committed review is never reported from a
// second, possibly stale, read. One builder, one shape (F3-D11).
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager, In } from 'typeorm';
import { slugify } from '../catalog/catalog-rules';
import { CatalogService } from '../catalog/catalog.service';
import type { ScanConfig } from '../config/scan.config';
import { PhotoStorage } from '../storage/photo-storage';
import { ShoeEntity } from '../shoes/entities/shoe.entity';
import { ScanEntity } from './entities/scan.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import {
  conditionLabelFor,
  matchPercent,
  resultStatusFor,
} from './result-rules';
import { isUnknownBrand, reviewStateFor, reviewedCount } from './review-rules';
import { labelFor } from './scan-rules';
import type {
  MyShoeView,
  ScanResultsView,
  ShoeResultEntryView,
  ShoeResultView,
} from './scan-result.view';

@Injectable()
export class ScanResultsBuilder {
  private readonly logger = new Logger(ScanResultsBuilder.name);
  private readonly cfg: ScanConfig;

  constructor(
    private readonly catalog: CatalogService,
    private readonly storage: PhotoStorage,
    config: ConfigService,
  ) {
    this.cfg = config.get<ScanConfig>('scan')!;
  }

  async build(
    m: EntityManager,
    scan: ScanEntity,
    includeRaw = false,
  ): Promise<ScanResultsView> {
    const shoes = await m.find(ScanShoeEntity, {
      where: { scanId: scan.id },
      order: { position: 'ASC' },
    });
    const ids = shoes.map((s) => s.id);
    const [results, entries] = ids.length
      ? await Promise.all([
          m.find(ScanShoeResultEntity, { where: { scanShoeId: In(ids) } }),
          m.find(ShoeEntity, { where: { scanShoeId: In(ids) } }),
        ])
      : [[], []];
    const resultByShoe = new Map(results.map((r) => [r.scanShoeId, r]));
    const entryByShoe = new Map(entries.map((e) => [e.scanShoeId, e]));
    const brands = await this.catalog.brandsByNames(
      m,
      results.map((r) => r.brand),
    );

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
          myShoe: entry ? await this.toMyShoeView(entry) : null,
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

  async toMyShoeView(e: ShoeEntity): Promise<MyShoeView> {
    return {
      id: e.id,
      brand: { id: e.brandId, name: e.brand },
      subBrand: e.subBrand,
      category: e.category,
      subCategory: e.subCategory,
      model: e.model,
      color: e.colorway,
      size: { id: e.sizeId, label: e.size },
      gender: e.gender,
      condition: {
        code: e.conditionCode,
        label: conditionLabelFor(e.conditionCode),
      },
      material: e.material,
      recommendedAction: e.recommendedAction,
      resale: {
        min: e.resaleMin,
        max: e.resaleMax,
        currency: e.resaleCurrency,
      },
      co2eKg: e.co2eKg,
      valueSource: e.valueSource,
      thumbnailUrl: e.primaryPhotoS3Key
        ? await this.signOrNull(e.primaryPhotoS3Key)
        : null,
      createdAt: new Date(e.createdAt).toISOString(),
    };
  }

  /** A signing failure (or no bucket configured) never fails a review. */
  private async signOrNull(key: string): Promise<string | null> {
    if (!this.storage.isConfigured()) return null;
    try {
      return await this.storage.signedGetUrl(key, this.cfg.photoUrlTtlSeconds);
    } catch (err) {
      this.logger.warn(`could not sign ${key}: ${String(err)}`);
      return null;
    }
  }
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
    ...(includeRaw ? { raw: row.raw } : {}),
    submittedAt: new Date(row.submittedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
