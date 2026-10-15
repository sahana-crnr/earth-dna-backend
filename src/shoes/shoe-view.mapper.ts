// ShoeEntity → MyShoeView, shared by the F3 review response (via
// ScanResultsBuilder) and the F4 list, so one entry has exactly one shape.
// The thumbnail is the primary shoe_photos row (F5); callers batch-load the
// keys with `primaryKeysFor` so a list page costs one extra query, not N.
// Lives in src/shoes so the dependency runs scan → shoes and never back.
// Thumbnail signing degrades to `null`: a missing bucket or a signing failure
// never fails a review or a list page.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScanConfig } from '../config/scan.config';
import { conditionLabelFor } from '../scan/result-rules';
import { PhotoStorage } from '../storage/photo-storage';
import { signOrNull } from '../storage/photo-storage.ops';
import { ConditionMappingEntity } from '../catalog/entities/condition-mapping.entity';
import type { ConditionCode } from '../scan/scan.types';
import { EntityManager, In } from 'typeorm';
import { ShoeEntity } from './entities/shoe.entity';
import { ShoePhotoEntity } from './entities/shoe-photo.entity';
import type { MyShoeView } from './shoes.view';

@Injectable()
export class ShoeViewMapper {
  private readonly logger = new Logger(ShoeViewMapper.name);
  private readonly cfg: ScanConfig;

  constructor(
    private readonly storage: PhotoStorage,
    config: ConfigService,
  ) {
    this.cfg = config.get<ScanConfig>('scan')!;
  }

  /** @param primaryKey s3Key of the shoe's primary shoe_photos row (F5-D17),
   *  resolved by the caller in one batch; null → no thumbnail. */
  /**
   * Condition labels for a page of cards, one query (PR 15 review: cards and
   * the profile read the same `condition_mappings` rows, so a label rename is
   * an UPDATE, not a release). Falls back to the F2 constants when the table
   * is empty.
   */
  async conditionLabels(
    m: EntityManager,
  ): Promise<ReadonlyMap<ConditionCode, string>> {
    const rows = await m.find(ConditionMappingEntity);
    return new Map(rows.map((r) => [r.code, r.label]));
  }

  /** @param labels from `conditionLabels(m)`, shared across the page. */
  async toMyShoeView(
    e: ShoeEntity,
    primaryKey: string | null,
    labels: ReadonlyMap<ConditionCode, string> = new Map(),
  ): Promise<MyShoeView> {
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
      shoeType: { id: e.shoeTypeId, name: e.shoeType },
      condition: {
        code: e.conditionCode,
        label:
          (e.conditionCode ? labels.get(e.conditionCode) : undefined) ??
          conditionLabelFor(e.conditionCode),
      },
      material: e.material,
      recommendedAction: e.recommendedAction,
      resale: {
        min: e.resaleMin,
        max: e.resaleMax,
        currency: e.resaleCurrency,
      },
      valueSource: e.valueSource,
      thumbnailUrl: primaryKey ? await this.signOrNull(primaryKey) : null,
      primaryPhotoId: e.primaryPhotoId,
      createdAt: new Date(e.createdAt).toISOString(),
    };
  }

  /** primaryPhotoId → s3Key for a page of entries, one query. */
  async primaryKeysFor(
    m: EntityManager,
    entries: readonly ShoeEntity[],
  ): Promise<Map<string, string>> {
    const ids = entries
      .map((e) => e.primaryPhotoId)
      .filter((id): id is string => id !== null);
    if (ids.length === 0) return new Map();
    const rows = await m.find(ShoePhotoEntity, {
      where: { id: In(ids) },
      select: { id: true, s3Key: true },
    });
    return new Map(rows.map((r) => [r.id, r.s3Key]));
  }

  private signOrNull(key: string): Promise<string | null> {
    return signOrNull(
      this.storage,
      this.logger,
      key,
      this.cfg.photoUrlTtlSeconds,
    );
  }
}
