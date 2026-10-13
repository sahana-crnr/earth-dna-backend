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
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service';
import { ApiError } from '../common/errors/api-error';
import type { ScanConfig } from '../config/scan.config';
import { ShoeEntity } from '../shoes/entities/shoe.entity';
import { ShoesService } from '../shoes/shoes.service';
import {
  SHOE_VALUE_PROVIDER,
  type ShoeValueProvider,
} from '../shoes/value/shoe-value.provider';
import type { ShoeDetailsDto } from './dto/shoe-details.dto';
import { ScanEntity } from './entities/scan.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import { ShoeFeedbackEntity } from './entities/shoe-feedback.entity';
import {
  brandCorrected,
  isCompleted,
  missingFields,
  overlayDetails,
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
    private readonly shoes: ShoesService,
    @Inject(SHOE_VALUE_PROVIDER) private readonly values: ShoeValueProvider,
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
      // Brand is settled before the size so the size can be checked against it.
      const predictedBrandRow =
        brandRow ?? (await this.catalog.brandByName(m, result.brand));
      const sizeRow = dto.sizeId
        ? await this.catalog.sizeById(
            m,
            dto.sizeId,
            predictedBrandRow?.id ?? null,
          )
        : null;
      if (dto.sizeId && !sizeRow) {
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'UNKNOWN_SIZE',
          'Unknown size id, or the size does not belong to the chosen brand',
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
          model: result.model,
          colorway: result.colorway,
          subBrand: result.subBrand,
          category: result.category,
          subCategory: result.subCategory,
          conditionCode: result.conditionCode,
          material: result.material,
        },
        answer,
      );
      if (!identity.brand) {
        // Covers both a failed result and ShoeDNA's "Unknown" sentinel.
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'BRAND_REQUIRED',
          'The prediction has no usable brand; send brandId',
        );
      }
      // Feedback semantics: did the user correct the brand? A confirm that
      // overrides the brand is a correction for training, whatever the route.
      const corrected =
        mode === 'reject' ||
        brandCorrected(result.brand, brandRow?.name ?? null);
      // Brand id: the body's, else the predicted brand matched to the catalog.
      const resolvedBrand = brandRow ?? predictedBrandRow;

      // ─── silent product match (F3-D7) ──────────────────────────────────
      const product = await this.catalog.matchProduct(
        m,
        resolvedBrand?.id ?? null,
        identity.model,
        identity.color,
        identity.size,
      );

      // ─── shoe type (F5-D20) ────────────────────────────────────────────
      const shoeType = await this.catalog.shoeTypeForCategory(
        m,
        identity.category,
      );
      const valueFields = this.cfg.valuePlaceholder
        ? await this.valueFields(shoe.id, identity)
        : {};

      // ─── rescan: update the existing entry in place (F5-D22) ───────────
      const rescanOf = shoe.rescanOfShoeId
        ? await m.findOne(ShoeEntity, {
            where: { id: shoe.rescanOfShoeId, userId, deletedAt: IsNull() },
            lock: { mode: 'pessimistic_write' },
          })
        : null;
      if (rescanOf) {
        const view = await this.completeRescan(m, {
          userId,
          mode,
          scan,
          shoe,
          result,
          existing: rescanOf,
          identity,
          resolvedBrandId: resolvedBrand?.id ?? null,
          resolvedBrandName: resolvedBrand?.name ?? identity.brand,
          sizeId: sizeRow?.id ?? null,
          productId: product?.id ?? null,
          msrp: product?.msrp ?? null,
          shoeTypeId: shoeType?.id ?? null,
          shoeTypeName: shoeType?.name ?? null,
          valueFields,
        });
        return view;
      }

      // ─── My Shoes entry ────────────────────────────────────────────────
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
        shoeTypeId: shoeType?.id ?? null,
        shoeType: shoeType?.name ?? null,
        ...valueFields,
      });
      const saved = await m.save(entry);
      // shoe_photos rows for the captured views + primary (F5-D17)
      await this.shoes.attachScanPhotos(
        m,
        saved.id,
        shoe.id,
        this.cfg.thumbnailView,
      );

      // ─── training feedback (F3-D14) ────────────────────────────────────
      // save() rather than insert(): jsonb columns do not fit TypeORM's
      // QueryDeepPartialEntity (same reason as the F2 result upsert).
      await m.save(
        m.create(ShoeFeedbackEntity, {
          scanShoeId: shoe.id,
          shoeId: saved.id,
          userId,
          type: corrected ? 'corrected' : 'confirmed',
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
      // One read of the session's shoes serves both the completion check and
      // the response view (PR 13 review: no second scan_shoes query).
      const all = await m.find(ScanShoeEntity, {
        where: { scanId: scan.id },
        order: { position: 'ASC' },
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
      return this.builder.build(m, scan, false, all);
    });
  }
  /** Value fields for a new (or re-valued) entry via the provider (F5-D15). */
  private async valueFields(
    shoeId: string,
    identity: {
      brand: string | null;
      model: string | null;
      conditionCode: ShoeEntity['conditionCode'];
    },
  ): Promise<Partial<ShoeEntity>> {
    const v = await this.values.valueFor({
      shoeId,
      brand: identity.brand,
      model: identity.model,
      conditionCode: identity.conditionCode,
    });
    return {
      recommendedAction: v.recommendedAction,
      resaleMin: v.resaleMin,
      resaleMax: v.resaleMax,
      resaleBucket: v.resaleBucket,
      demandNote: v.demandNote,
      recommendationReason: v.recommendationReason,
      valueSource: v.source,
      valueSourceVersion: v.version,
      valueComputedAt: new Date(),
    };
  }

  /**
   * F5-D22: the review of a rescan shoe overwrites the existing My Shoes
   * entry — identity from the new answer, condition from the new result, new
   * scan photos, value via the provider while static — and records a
   * `rescanned` feedback row holding the previous entry. The old scan session
   * stays; share links keep working.
   */
  private async completeRescan(
    m: EntityManager,
    r: RescanInput,
  ): Promise<ScanResultsView> {
    const e = r.existing;
    const previous = {
      scanShoeId: e.scanShoeId,
      brandId: e.brandId,
      brand: e.brand,
      subBrand: e.subBrand,
      category: e.category,
      subCategory: e.subCategory,
      model: e.model,
      colorway: e.colorway,
      sizeId: e.sizeId,
      size: e.size,
      gender: e.gender,
      conditionCode: e.conditionCode,
      material: e.material,
      shoeTypeId: e.shoeTypeId,
      catalogProductId: e.catalogProductId,
      msrp: e.msrp,
    };
    const patch: Partial<ShoeEntity> = {
      scanShoeId: r.shoe.id,
      brandId: r.resolvedBrandId,
      brand: r.resolvedBrandName ?? e.brand,
      subBrand: r.identity.subBrand,
      category: r.identity.category,
      subCategory: r.identity.subCategory,
      model: r.identity.model,
      colorway: r.identity.color,
      sizeId: r.sizeId,
      size: r.identity.size,
      gender: r.identity.gender,
      conditionCode: r.identity.conditionCode,
      material: r.identity.material,
      shoeTypeId: r.shoeTypeId,
      shoeType: r.shoeTypeName,
      catalogProductId: r.productId,
      msrp: r.msrp,
      ...(e.valueSource === 'static' ? r.valueFields : {}),
    };
    await m.update(ShoeEntity, { id: e.id }, patch);
    await this.shoes.replaceScanPhotos(
      m,
      e.id,
      r.shoe.id,
      this.cfg.thumbnailView,
    );
    // The previous session no longer backs a live entry: hide it from lists.
    await this.shoes.hideScanIfOrphaned(m, previous.scanShoeId);
    await m.save(
      m.create(ShoeFeedbackEntity, {
        scanShoeId: r.shoe.id,
        shoeId: e.id,
        userId: r.userId,
        type: 'rescanned',
        modelVersion: r.result.modelVersion,
        original: {
          previous,
          prediction: {
            brand: r.result.brand,
            subBrand: r.result.subBrand,
            model: r.result.model,
            colorway: r.result.colorway,
            category: r.result.category,
            subCategory: r.result.subCategory,
            material: r.result.material,
            confidence: r.result.confidence,
            conditionCode: r.result.conditionCode,
            outcome: r.result.outcome,
            source: r.result.source,
          },
        },
        answer: {
          mode: r.mode,
          brandId: r.resolvedBrandId,
          brand: patch.brand,
          model: patch.model,
          color: patch.colorway,
          sizeId: patch.sizeId,
          size: patch.size,
          gender: patch.gender,
          conditionCode: patch.conditionCode,
          catalogProductId: patch.catalogProductId,
        },
      }),
    );
    await m.update(
      ScanShoeEntity,
      { id: r.shoe.id },
      { status: r.mode === 'confirm' ? 'confirmed' : 'rejected' },
    );
    const all = await m.find(ScanShoeEntity, {
      where: { scanId: r.scan.id },
      order: { position: 'ASC' },
    });
    if (isCompleted(all) && r.scan.status !== 'completed') {
      await m.update(ScanEntity, { id: r.scan.id }, { status: 'completed' });
      r.scan.status = 'completed';
    }
    await touchScan(m, r.scan.id);
    this.logger.log(
      `scan ${r.scan.id} shoe ${r.shoe.id} ${r.mode === 'confirm' ? 'confirmed' : 'rejected'} → rescan of my shoe ${e.id} applied`,
    );
    return this.builder.build(m, r.scan, false, all);
  }
}

interface RescanInput {
  userId: string;
  mode: ReviewMode;
  scan: ScanEntity;
  shoe: ScanShoeEntity;
  result: ScanShoeResultEntity;
  existing: ShoeEntity;
  identity: ReturnType<typeof overlayDetails>;
  resolvedBrandId: string | null;
  resolvedBrandName: string | null;
  sizeId: string | null;
  productId: string | null;
  msrp: number | null;
  shoeTypeId: string | null;
  shoeTypeName: string | null;
  valueFields: Partial<ShoeEntity>;
}
