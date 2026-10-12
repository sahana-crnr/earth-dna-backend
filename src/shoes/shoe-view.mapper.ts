// ShoeEntity → MyShoeView, shared by the F3 review response (via
// ScanResultsBuilder) and the F4 list, so one entry has exactly one shape.
// Lives in src/shoes so the dependency runs scan → shoes and never back.
// Thumbnail signing degrades to `null`: a missing bucket or a signing failure
// never fails a review or a list page.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScanConfig } from '../config/scan.config';
import { conditionLabelFor } from '../scan/result-rules';
import { PhotoStorage } from '../storage/photo-storage';
import { ShoeEntity } from './entities/shoe.entity';
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
