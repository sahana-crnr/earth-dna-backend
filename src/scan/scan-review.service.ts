// F3 review service: E12 confirm and E13 reject share one transaction-scoped
// path (how-to.md §4). Everything happens under a row lock on the caller's scan
// (findOwnedScan with lock), so two shoes reviewed at the same moment cannot
// both miss the "last one flips the scan to completed" step, and a retried
// request serialises behind the first and gets ALREADY_REVIEWED rather than a
// second entry. The unique index on shoes.scanShoeId is the structural backstop.
//
// Order inside the transaction: assert scan + shoe state → resolve catalog ids
// → overlay body on prediction → require a brand → silent product match →
// insert shoes → insert shoe_feedback → set shoe status → maybe complete the
// scan → touchScan → build the results view from the same manager (F3-D11).
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service';
import { ApiError } from '../common/errors/api-error';
import type { ScanConfig } from '../config/scan.config';
import { ShoeEntity } from '../shoes/entities/shoe.entity';
import type { ShoeDetailsDto } from './dto/shoe-details.dto';
import { ScanEntity } from './entities/scan.entity';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import { ShoeFeedbackEntity } from './entities/shoe-feedback.entity';
import {
  isCompleted,
  missingFields,
  overlayDetails,
  placeholderFor,
  thumbnailKeyFor,
  type ReviewMode,
} from './review-rules';
import { findOwnedScan, notFound, touchScan } from './scan-access';
import { ScanResultsBuilder } from './scan-results.builder';
import type { ScanResultsView } from './scan-result.view';
import type { ScanStatus } from './scan.types';

/** Scan states in which a shoe may be reviewed. `processing` is allowed so a
 *  slow sibling shoe never blocks reviewing one that already has a result;
 *  `completed` is allowed in so the shoe check can answer ALREADY_REVIEWED. */
const REVIEWABLE: readonly ScanStatus[] = ['review', 'processing', 'completed'];

@Injectable()
export class ScanReviewService {
  private readonly logger = new Logger(ScanReviewService.name);
  private readonly cfg: ScanConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: CatalogService,
    private readonly builder: ScanResultsBuilder,
    config: ConfigService,
  ) {
    this.cfg = config.get<ScanConfig>('scan')!;
  }

  confirm(userId: string, scanId: string, shoeId: string, dto: ShoeDetailsDto) {
    return this.review('confirm', userId, scanId, shoeId, dto);
  }

  reject(userId: string, scanId: string, shoeId: string, dto: ShoeDetailsDto) {
    return this.review('reject', userId, scanId, shoeId, dto);
  }

  private async review(
    mode: ReviewMode,
    userId: string,
    scanId: string,
    shoeId: string,
    dto: ShoeDetailsDto,
  ): Promise<ScanResultsView> {
    return this.dataSource.transaction(async (m) => {
      const scan = await findOwnedScan(m, userId, scanId, true);
      if (!REVIEWABLE.includes(scan.status)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'NOT_IN_REVIEW',
          scan.status === 'draft'
            ? 'Scan is still a draft; finish it and submit results first'
            : `Scan is ${scan.status}; it cannot be reviewed`,
        );
      }
      const shoe = await m.findOne(ScanShoeEntity, {
        where: { id: shoeId, scanId: scan.id },
      });
      if (!shoe) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
      if (shoe.status === 'confirmed' || shoe.status === 'rejected') {
        const existing = await m.findOne(ShoeEntity, {
          where: { scanShoeId: shoe.id },
          select: { id: true },
        });
        throw new ApiError(
          HttpStatus.CONFLICT,
          'ALREADY_REVIEWED',
          `Shoe is already ${shoe.status}`,
          { review: shoe.status, myShoeId: existing?.id ?? null },
        );
      }
      const result = await m.findOne(ScanShoeResultEntity, {
        where: { scanShoeId: shoe.id },
      });
      if (!result) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'NO_RESULT',
          'Shoe has no identification result yet; submit one first',
        );
      }

      // ─── resolve catalog ids ───────────────────────────────────────────
      const brandRow = dto.brandId
        ? await this.catalog.brandById(m, dto.brandId)
        : null;
      if (dto.brandId && !brandRow) {
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'UNKNOWN_BRAND',
          'Unknown or inactive brand id',
        );
      }
      const sizeRow = dto.sizeId
        ? await this.catalog.sizeById(m, dto.sizeId)
        : null;
      if (dto.sizeId && !sizeRow) {
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'UNKNOWN_SIZE',
          'Unknown size id',
        );
      }

      // ─── overlay body on prediction ────────────────────────────────────
      const answer = {
        brand: brandRow?.name,
        model: dto.model,
        color: dto.color,
        size: sizeRow?.label,
        gender: dto.gender ?? null,
      };
      const missing = missingFields(mode, answer);
      if (missing.length > 0) {
        // The DTO already enforces this for reject; kept as the service-level
        // invariant so a direct caller cannot bypass it.
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'FIELDS_REQUIRED',
          'Reject needs the full answer',
          { missing },
        );
      }
      const identity = overlayDetails(
        {
          brand: result.brand,
          subBrand: result.subBrand,
          category: result.category,
          subCategory: result.subCategory,
          conditionCode: result.conditionCode,
          material: result.material,
        },
        answer,
      );
      if (!identity.brand) {
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'BRAND_REQUIRED',
          'The prediction has no brand; send brandId',
        );
      }
      // Brand id: the body's, else the predicted brand matched to the catalog.
      const resolvedBrand =
        brandRow ?? (await this.catalog.brandByName(m, identity.brand));

      // ─── silent product match (F3-D7) ──────────────────────────────────
      const product = await this.catalog.matchProduct(
        m,
        resolvedBrand?.id ?? null,
        identity.model,
        identity.color,
        identity.size,
      );

      // ─── My Shoes entry ────────────────────────────────────────────────
      const photos = await m.find(ScanPhotoEntity, {
        where: { scanShoeId: shoe.id },
        select: { view: true, s3Key: true },
      });
      const entry = m.create(ShoeEntity, {
        userId,
        scanShoeId: shoe.id,
        brandId: resolvedBrand?.id ?? null,
        brand: resolvedBrand?.name ?? identity.brand,
        subBrand: identity.subBrand,
        category: identity.category,
        subCategory: identity.subCategory,
        model: identity.model,
        colorway: identity.color,
        sizeId: sizeRow?.id ?? null,
        size: identity.size,
        gender: identity.gender,
        conditionCode: identity.conditionCode,
        material: identity.material,
        catalogProductId: product?.id ?? null,
        msrp: product?.msrp ?? null,
        primaryPhotoS3Key: thumbnailKeyFor(photos, this.cfg.thumbnailView),
        ...(this.cfg.valuePlaceholder ? placeholderValues(shoe.id) : {}),
      });
      const saved = await m.save(entry);

      // ─── training feedback (F3-D14) ────────────────────────────────────
      // save() rather than insert(): jsonb columns do not fit TypeORM's
      // QueryDeepPartialEntity (same reason as the F2 result upsert).
      await m.save(
        m.create(ShoeFeedbackEntity, {
          scanShoeId: shoe.id,
          shoeId: saved.id,
          userId,
          type: mode === 'confirm' ? 'confirmed' : 'corrected',
          modelVersion: result.modelVersion,
          original: {
            brand: result.brand,
            subBrand: result.subBrand,
            model: result.model,
            colorway: result.colorway,
            category: result.category,
            subCategory: result.subCategory,
            material: result.material,
            confidence: result.confidence,
            conditionCode: result.conditionCode,
            candidates: result.candidates ?? [],
            outcome: result.outcome,
            source: result.source,
          },
          answer: {
            brandId: resolvedBrand?.id ?? null,
            brand: saved.brand,
            model: saved.model,
            color: saved.colorway,
            sizeId: saved.sizeId,
            size: saved.size,
            gender: saved.gender,
            catalogProductId: saved.catalogProductId,
          },
        }),
      );

      // ─── status ────────────────────────────────────────────────────────
      await m.update(
        ScanShoeEntity,
        { id: shoe.id },
        { status: mode === 'confirm' ? 'confirmed' : 'rejected' },
      );
      const all = await m.find(ScanShoeEntity, {
        where: { scanId: scan.id },
        select: { id: true, status: true },
      });
      if (isCompleted(all) && scan.status !== 'completed') {
        await m.update(ScanEntity, { id: scan.id }, { status: 'completed' });
        scan.status = 'completed';
        this.logger.log(
          `scan ${scan.id} completed (${all.length} shoe(s) reviewed)`,
        );
      }
      await touchScan(m, scan.id);
      this.logger.log(
        `scan ${scan.id} shoe ${shoe.id} ${mode === 'confirm' ? 'confirmed' : 'rejected'} → my shoe ${saved.id}`,
      );
      return this.builder.build(m, scan, false);
    });
  }

  /** Account-deletion hook (F3-D15): keep the training rows, drop the identity.
   *  The FK already does this on a hard user delete; this is for soft flows. */
  async anonymiseForUser(userId: string, m?: EntityManager): Promise<number> {
    const mgr = m ?? this.dataSource.manager;
    const r = await mgr.update(
      ShoeFeedbackEntity,
      { userId },
      { userId: null },
    );
    return r.affected ?? 0;
  }
}

function placeholderValues(shoeId: string) {
  const p = placeholderFor(shoeId);
  return {
    recommendedAction: p.recommendedAction,
    resaleMin: p.resaleMin,
    resaleMax: p.resaleMax,
    resaleBucket: p.resaleBucket,
    demandNote: p.demandNote,
    recommendationReason: p.recommendationReason,
    co2eKg: p.co2eKg,
    valueSource: 'static' as const,
    valueComputedAt: new Date(),
  };
}
