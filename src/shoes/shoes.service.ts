// F5 My Shoes service (features/F5-shoe-profile/how-to.md §4). Every owner
// operation resolves the shoe through findOwnedShoe (404 for anyone else or a
// removed entry) and, when it writes, holds a row lock on the shoe so two
// edits, uploads or share creations serialise. Photo bytes go to S3 before the
// row exists and are removed again when the transaction fails, same as F1.
//
// Also hosts the two hooks the F3 review transaction calls: attachScanPhotos
// (first review) and replaceScanPhotos (review of a rescan, F5-D22).
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { CatalogService } from '../catalog/catalog.service';
import { ApiError } from '../common/errors/api-error';
import type { ScanConfig } from '../config/scan.config';
import type { ShoesConfig } from '../config/shoes.config';
import { ScanEntity } from '../scan/entities/scan.entity';
import { ScanPhotoEntity } from '../scan/entities/scan-photo.entity';
import { ScanShoeEntity } from '../scan/entities/scan-shoe.entity';
import { ShoeFeedbackEntity } from '../scan/entities/shoe-feedback.entity';
import { notFound } from '../scan/scan-access';
import { CONTENT_TYPE, FILE_EXT } from '../scan/scan-rules';
import { SHOE_VIEWS, type ScanStatus, type ShoeView } from '../scan/scan.types';
import {
  PhotoStorage,
  StorageNotConfiguredError,
  StorageUnavailableError,
} from '../storage/photo-storage';
import {
  validateUploadedPhoto,
  type UploadedPhoto,
} from '../storage/photo-upload.rules';
import type { ConditionFeedbackDto } from './dto/condition-feedback.dto';
import type { UpdateShoeDto } from './dto/update-shoe.dto';
import { ShoeEntity } from './entities/shoe.entity';
import { ShoePhotoEntity } from './entities/shoe-photo.entity';
import { ShoeShareEntity } from './entities/shoe-share.entity';
import {
  applyEdit,
  canDeletePhoto,
  conditionViewFor,
  materialsFor,
  nextPrimary,
  nextSortOrder,
  type EditInput,
  type EditableShoe,
} from './shoe-profile-rules';
import type {
  ConditionFeedbackView,
  RescanView,
  ShareLinkView,
  ShoePhotoView,
  ShoeProfileView,
} from './shoe-profile.view';
import { isValidToken, makeToken, randomPart, shareUrl } from './share-rules';
import type { PublicShareView } from './share.view';
import { findOwnedShoe } from './shoes-access';
import {
  SHOE_VALUE_PROVIDER,
  type ShoeValueProvider,
} from './value/shoe-value.provider';

/** Scan states that count as "a rescan is still open" (F5-D21). */
const OPEN_RESCAN: readonly ScanStatus[] = ['draft', 'processing', 'review'];
const PG_UNIQUE_VIOLATION = '23505';
const SHARE_TOKEN_ATTEMPTS = 5;

@Injectable()
export class ShoesService {
  private readonly logger = new Logger(ShoesService.name);
  private readonly cfg: ShoesConfig;
  private readonly scanCfg: ScanConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: PhotoStorage,
    private readonly catalog: CatalogService,
    @Inject(SHOE_VALUE_PROVIDER) private readonly values: ShoeValueProvider,
    config: ConfigService,
  ) {
    this.cfg = config.get<ShoesConfig>('shoes')!;
    this.scanCfg = config.get<ScanConfig>('scan')!;
  }

  /** Base of share links: SHARE_BASE_URL, else the API base of the request. */
  shareBase(requestApiBase: string): string {
    return this.cfg.shareBaseUrl ?? requestApiBase;
  }

  // ─── E21 profile ─────────────────────────────────────────────────────────
  async getProfile(
    userId: string,
    shoeId: string,
    shareBase: string,
  ): Promise<ShoeProfileView> {
    const m = this.dataSource.manager;
    const shoe = await findOwnedShoe(m, userId, shoeId);
    return this.buildProfile(m, shoe, shareBase);
  }

  // ─── E22 edit ────────────────────────────────────────────────────────────
  async update(
    userId: string,
    shoeId: string,
    dto: UpdateShoeDto,
    shareBase: string,
  ): Promise<ShoeProfileView> {
    if (Object.values(dto).every((v) => v === undefined)) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'EMPTY_UPDATE',
        'Send at least one field to change',
      );
    }
    return this.dataSource.transaction(async (m) => {
      const shoe = await findOwnedShoe(m, userId, shoeId, true);

      // ─── resolve ids against the catalog / this shoe ───────────────────
      const input: EditInput = {};
      if (dto.brandId !== undefined) {
        const row = await this.catalog.brandById(m, dto.brandId);
        if (!row) {
          throw new ApiError(
            HttpStatus.BAD_REQUEST,
            'UNKNOWN_BRAND',
            'Unknown or inactive brand id',
          );
        }
        input.brandId = row.id;
        input.brand = row.name;
      }
      const brandForSize = input.brandId ?? shoe.brandId;
      if (dto.sizeId !== undefined) {
        if (dto.sizeId === null) {
          input.sizeId = null;
          input.size = null;
        } else {
          const row = await this.catalog.sizeById(m, dto.sizeId, brandForSize);
          if (!row) {
            throw new ApiError(
              HttpStatus.BAD_REQUEST,
              'UNKNOWN_SIZE',
              'Unknown size id, or the size does not belong to the brand',
            );
          }
          input.sizeId = row.id;
          input.size = row.label;
        }
      }
      if (dto.shoeTypeId !== undefined) {
        if (dto.shoeTypeId === null) {
          input.shoeTypeId = null;
          input.shoeType = null;
        } else {
          const row = await this.catalog.shoeTypeById(m, dto.shoeTypeId);
          if (!row) {
            throw new ApiError(
              HttpStatus.BAD_REQUEST,
              'UNKNOWN_SHOE_TYPE',
              'Unknown or inactive shoe type id',
            );
          }
          input.shoeTypeId = row.id;
          input.shoeType = row.name;
        }
      }
      if (dto.primaryPhotoId !== undefined) {
        const owned = await m.findOne(ShoePhotoEntity, {
          where: { id: dto.primaryPhotoId, shoeId: shoe.id },
          select: { id: true },
        });
        if (!owned) {
          throw new ApiError(
            HttpStatus.BAD_REQUEST,
            'UNKNOWN_PHOTO',
            'primaryPhotoId is not a photo of this shoe',
          );
        }
        input.primaryPhotoId = owned.id;
      }
      if (dto.model !== undefined) input.model = dto.model;
      if (dto.color !== undefined) input.color = dto.color;
      if (dto.gender !== undefined) input.gender = dto.gender;
      if (dto.actionTaken !== undefined) input.actionTaken = dto.actionTaken;

      // ─── overlay + side effects (F5-D7) ────────────────────────────────
      const edit = applyEdit(editable(shoe), input, new Date());
      if (edit.changed.size > 0) {
        const patch: Partial<ShoeEntity> = { ...edit.next };
        if (edit.rematch) {
          const product = await this.catalog.matchProduct(
            m,
            edit.next.brandId,
            edit.next.model,
            edit.next.colorway,
            edit.next.size,
          );
          patch.catalogProductId = product?.id ?? null;
          patch.msrp = product?.msrp ?? null;
        }
        if (edit.revalue && shoe.valueSource === 'static') {
          const v = await this.values.valueFor({
            shoeId: shoe.id,
            brand: edit.next.brand,
            model: edit.next.model,
            conditionCode: shoe.conditionCode,
          });
          Object.assign(patch, {
            recommendedAction: v.recommendedAction,
            resaleMin: v.resaleMin,
            resaleMax: v.resaleMax,
            resaleBucket: v.resaleBucket,
            demandNote: v.demandNote,
            recommendationReason: v.recommendationReason,
            valueSource: v.source,
            valueSourceVersion: v.version,
            valueComputedAt: new Date(),
          });
        }
        await m.update(ShoeEntity, { id: shoe.id }, patch);
        this.logger.log(
          `shoe ${shoe.id} edited: ${[...edit.changed].join(', ')}`,
        );
      }
      const fresh = await findOwnedShoe(m, userId, shoeId);
      return this.buildProfile(m, fresh, shareBase);
    });
  }

  // ─── E23 remove (F5-D10) ─────────────────────────────────────────────────
  async remove(userId: string, shoeId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const shoe = await findOwnedShoe(m, userId, shoeId, true);
      const now = new Date();
      await m.update(ShoeEntity, { id: shoe.id }, { deletedAt: now });
      await m.update(
        ShoeShareEntity,
        { shoeId: shoe.id, revokedAt: IsNull() },
        { revokedAt: now },
      );
      await this.hideScanIfOrphaned(m, shoe.scanShoeId, now);
      this.logger.log(`shoe ${shoe.id} removed`);
    });
  }

  // ─── E27 upload photo (F5-D17/D18) ───────────────────────────────────────
  async uploadPhoto(
    userId: string,
    shoeId: string,
    file: UploadedPhoto | undefined,
    shareBase: string,
  ): Promise<ShoeProfileView> {
    this.requireStorage();
    const type = validateUploadedPhoto(file, {
      photoMaxBytes: this.scanCfg.photoMaxBytes,
      allowedTypes: this.scanCfg.photoAllowedTypes,
    });
    // Cheap pre-checks without a lock, so a bad request never touches S3.
    const m0 = this.dataSource.manager;
    const shoe = await findOwnedShoe(m0, userId, shoeId);
    this.assertPhotoRoom(
      await m0.count(ShoePhotoEntity, { where: { shoeId } }),
    );

    const photoId = randomUUID();
    const key = `${this.cfg.uploadPrefix}/${userId}/${shoe.id}/${photoId}.${FILE_EXT[type]}`;
    await this.putOrThrow(key, file!.buffer, CONTENT_TYPE[type]);
    try {
      return await this.dataSource.transaction(async (m) => {
        const locked = await findOwnedShoe(m, userId, shoeId, true);
        const photos = await m.find(ShoePhotoEntity, {
          where: { shoeId: locked.id },
        });
        this.assertPhotoRoom(photos.length);
        await m.insert(ShoePhotoEntity, {
          id: photoId,
          shoeId: locked.id,
          source: 'upload',
          scanPhotoId: null,
          view: null,
          s3Key: key,
          contentType: CONTENT_TYPE[type],
          sizeBytes: file!.size,
          sortOrder: nextSortOrder(photos),
        });
        if (!locked.primaryPhotoId) {
          await m.update(
            ShoeEntity,
            { id: locked.id },
            { primaryPhotoId: photoId },
          );
        }
        const fresh = await findOwnedShoe(m, userId, shoeId);
        return this.buildProfile(m, fresh, shareBase);
      });
    } catch (err) {
      await this.safeDelete(key);
      throw err;
    }
  }

  // ─── E28 delete photo ────────────────────────────────────────────────────
  async deletePhoto(
    userId: string,
    shoeId: string,
    photoId: string,
    shareBase: string,
  ): Promise<ShoeProfileView> {
    const { view, removeKey } = await this.dataSource.transaction(async (m) => {
      const shoe = await findOwnedShoe(m, userId, shoeId, true);
      const photos = await m.find(ShoePhotoEntity, {
        where: { shoeId: shoe.id },
      });
      const target = photos.find((p) => p.id === photoId);
      if (!target) throw notFound('PHOTO_NOT_FOUND', 'Photo not found');
      if (!canDeletePhoto(photos.length)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'LAST_PHOTO',
          'A shoe keeps at least one photo',
        );
      }
      await m.delete(ShoePhotoEntity, { id: target.id });
      if (shoe.primaryPhotoId === target.id) {
        await m.update(
          ShoeEntity,
          { id: shoe.id },
          { primaryPhotoId: nextPrimary(photos, target.id) },
        );
      }
      const fresh = await findOwnedShoe(m, userId, shoeId);
      return {
        view: await this.buildProfile(m, fresh, shareBase),
        removeKey: target.source === 'upload' ? target.s3Key : null,
      };
    });
    if (removeKey) await this.safeDelete(removeKey);
    return view;
  }

  // ─── E24 / E25 share (F5-D11, D14) ───────────────────────────────────────
  async createShare(
    userId: string,
    shoeId: string,
    shareBase: string,
  ): Promise<{ created: boolean; link: ShareLinkView }> {
    return this.dataSource.transaction(async (m) => {
      const shoe = await findOwnedShoe(m, userId, shoeId, true);
      const active = await m.findOne(ShoeShareEntity, {
        where: { shoeId: shoe.id, revokedAt: IsNull() },
      });
      if (active)
        return { created: false, link: this.linkView(active, shareBase) };
      for (let attempt = 0; attempt < SHARE_TOKEN_ATTEMPTS; attempt += 1) {
        const token = makeToken(
          shoe.model,
          shoe.brand,
          randomPart(this.cfg.shareTokenRandomChars),
        );
        try {
          // Nested transaction = savepoint on Postgres: a token collision rolls
          // back only the insert, never the outer transaction.
          const share = await m.transaction((inner) =>
            inner.save(
              inner.create(ShoeShareEntity, { shoeId: shoe.id, token }),
            ),
          );
          this.logger.log(`shoe ${shoe.id} share created`);
          return { created: true, link: this.linkView(share, shareBase) };
        } catch (err) {
          if ((err as { code?: string }).code !== PG_UNIQUE_VIOLATION)
            throw err;
        }
      }
      throw new ApiError(
        HttpStatus.CONFLICT,
        'SHARE_TOKEN_EXHAUSTED',
        'Could not allocate a share link, try again',
      );
    });
  }

  async revokeShare(userId: string, shoeId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const shoe = await findOwnedShoe(m, userId, shoeId, true);
      const r = await m.update(
        ShoeShareEntity,
        { shoeId: shoe.id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      if (r.affected) this.logger.log(`shoe ${shoe.id} share revoked`);
    });
  }

  // ─── E26 public view (F5-D12) ────────────────────────────────────────────
  async publicView(token: string): Promise<PublicShareView | null> {
    if (!isValidToken(token)) return null;
    const m = this.dataSource.manager;
    const share = await m.findOne(ShoeShareEntity, { where: { token } });
    if (!share || share.revokedAt) return null;
    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) return null;
    const shoe = await m.findOne(ShoeEntity, {
      where: { id: share.shoeId, deletedAt: IsNull() },
    });
    if (!shoe) return null;
    const [primary, mappings] = await Promise.all([
      shoe.primaryPhotoId
        ? m.findOne(ShoePhotoEntity, { where: { id: shoe.primaryPhotoId } })
        : null,
      this.catalog.conditionMappings(m),
    ]);
    const condition = conditionViewFor(shoe.conditionCode, mappings);
    // Fire-and-forget: a counter must never slow or fail the page.
    m.increment(ShoeShareEntity, { id: share.id }, 'viewCount', 1).catch(
      (err) => this.logger.warn(`viewCount ${share.id}: ${String(err)}`),
    );
    return {
      brand: shoe.brand,
      model: shoe.model,
      shoeType: shoe.shoeType,
      color: shoe.colorway,
      condition: { grade: condition.grade, label: condition.label },
      value: {
        min: shoe.resaleMin,
        max: shoe.resaleMax,
        currency: shoe.resaleCurrency,
      },
      recommendedAction: shoe.recommendedAction,
      photoUrl: primary ? await this.signOrNull(primary.s3Key) : null,
      sharedAt: new Date(share.createdAt).toISOString(),
    };
  }

  // ─── E29 rescan (F5-D21) ─────────────────────────────────────────────────
  async rescan(userId: string, shoeId: string): Promise<RescanView> {
    this.requireStorage();
    const view = await this.dataSource.transaction(async (m) => {
      const shoe = await findOwnedShoe(m, userId, shoeId, true);
      const open = await this.openRescan(m, shoe.id);
      if (open) return { ...open, created: false };
      if (this.scanCfg.maxOpenDrafts > 0) {
        // Same guard as ScanService.createDraft (E1), kept in step with it.
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `scan-draft:${userId}`,
        ]);
        const openDrafts = await m.count(ScanEntity, {
          where: { userId, status: 'draft' },
        });
        if (openDrafts >= this.scanCfg.maxOpenDrafts) {
          throw new ApiError(
            HttpStatus.CONFLICT,
            'DRAFT_LIMIT_REACHED',
            `You can have at most ${this.scanCfg.maxOpenDrafts} open scans`,
          );
        }
      }
      const scan = await m.save(
        m.create(ScanEntity, { userId, status: 'draft', source: 'camera' }),
      );
      const scanShoe = await m.save(
        m.create(ScanShoeEntity, {
          scanId: scan.id,
          position: 1,
          status: 'capturing',
          rescanOfShoeId: shoe.id,
        }),
      );
      return {
        scanId: scan.id,
        shoeId: scanShoe.id,
        status: scan.status,
        created: true,
      };
    });
    if (view.created) this.logger.log(`shoe ${shoeId} rescan ${view.scanId}`);
    return view;
  }

  // ─── E30 condition feedback (F5-D19) ─────────────────────────────────────
  async suggestCondition(
    userId: string,
    shoeId: string,
    dto: ConditionFeedbackDto,
  ): Promise<ConditionFeedbackView> {
    const m = this.dataSource.manager;
    const shoe = await findOwnedShoe(m, userId, shoeId);
    const row = await m.save(
      m.create(ShoeFeedbackEntity, {
        scanShoeId: shoe.scanShoeId,
        shoeId: shoe.id,
        userId,
        type: 'condition_suggested',
        modelVersion: null,
        original: { conditionCode: shoe.conditionCode },
        answer: {
          suggestedConditionCode: dto.suggestedConditionCode,
          reason: dto.reason,
        },
      }),
    );
    this.logger.log(`shoe ${shoe.id} condition suggested`);
    return {
      suggestedConditionCode: dto.suggestedConditionCode,
      reason: dto.reason,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }

  /**
   * F5-D10: once no live My Shoes entry points at any shoe of the session
   * that `scanShoeId` belongs to, the session leaves the GET /scans lists.
   * Called on remove and when a rescan review moves the entry to a new scan.
   */
  async hideScanIfOrphaned(
    m: EntityManager,
    scanShoeId: string | null,
    now = new Date(),
  ): Promise<void> {
    if (!scanShoeId) return;
    const scanShoe = await m.findOne(ScanShoeEntity, {
      where: { id: scanShoeId },
      select: { id: true, scanId: true },
    });
    if (!scanShoe) return;
    const n = await m
      .getRepository(ShoeEntity)
      .createQueryBuilder('s')
      .innerJoin(ScanShoeEntity, 'ss', 'ss.id = s."scanShoeId"')
      .where('ss."scanId" = :scanId AND s."deletedAt" IS NULL', {
        scanId: scanShoe.scanId,
      })
      .getCount();
    if (n === 0) {
      await m.update(ScanEntity, { id: scanShoe.scanId }, { hiddenAt: now });
    }
  }

  // ─── hooks for the F3 review transaction ─────────────────────────────────

  /** First review: one `scan` row per captured view (keys only); the
   *  configured view (else the first captured) becomes the primary photo. */
  async attachScanPhotos(
    m: EntityManager,
    shoeId: string,
    scanShoeId: string,
    preferred: ShoeView,
  ): Promise<void> {
    const existing = await m.find(ShoePhotoEntity, { where: { shoeId } });
    const start = nextSortOrder(existing);
    const inserted = await this.insertScanRows(m, shoeId, scanShoeId, start);
    const primary = pickPrimary(inserted, preferred);
    if (primary) {
      await m.update(ShoeEntity, { id: shoeId }, { primaryPhotoId: primary });
    }
  }

  /** Rescan review (F5-D22): old `scan` rows go (S3 objects stay with the old
   *  scan), uploads stay, the new views come in; primary follows when it was a
   *  scan photo. */
  async replaceScanPhotos(
    m: EntityManager,
    shoeId: string,
    scanShoeId: string,
    preferred: ShoeView,
  ): Promise<void> {
    const existing = await m.find(ShoePhotoEntity, { where: { shoeId } });
    const oldScan = existing.filter((p) => p.source === 'scan');
    if (oldScan.length) {
      await m.delete(ShoePhotoEntity, { id: In(oldScan.map((p) => p.id)) });
    }
    const uploads = existing.filter((p) => p.source === 'upload');
    const inserted = await this.insertScanRows(m, shoeId, scanShoeId, 0);
    // Uploads move behind the new views so the strip reads scans first.
    for (const [i, u] of uploads.entries()) {
      await m.update(
        ShoePhotoEntity,
        { id: u.id },
        { sortOrder: inserted.length + i },
      );
    }
    const shoe = await m.findOne(ShoeEntity, {
      where: { id: shoeId },
      select: { id: true, primaryPhotoId: true },
    });
    const primaryWasScan =
      !shoe?.primaryPhotoId ||
      oldScan.some((p) => p.id === shoe.primaryPhotoId);
    if (primaryWasScan) {
      const primary =
        pickPrimary(inserted, preferred) ?? uploads[0]?.id ?? null;
      await m.update(ShoeEntity, { id: shoeId }, { primaryPhotoId: primary });
    }
  }

  // ─── profile builder (shared by every owner response) ────────────────────
  async buildProfile(
    m: EntityManager,
    shoe: ShoeEntity,
    shareBase: string,
  ): Promise<ShoeProfileView> {
    const [photos, share, mappings, feedback, rescan] = await Promise.all([
      m.find(ShoePhotoEntity, {
        where: { shoeId: shoe.id },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      }),
      m.findOne(ShoeShareEntity, {
        where: { shoeId: shoe.id, revokedAt: IsNull() },
      }),
      this.catalog.conditionMappings(m),
      m.findOne(ShoeFeedbackEntity, {
        where: { shoeId: shoe.id, type: 'condition_suggested' },
        order: { createdAt: 'DESC' },
      }),
      this.openRescan(m, shoe.id),
    ]);
    const scanShoe = shoe.scanShoeId
      ? await m.findOne(ScanShoeEntity, {
          where: { id: shoe.scanShoeId },
          select: { id: true, scanId: true },
        })
      : null;
    const photoViews: ShoePhotoView[] = await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        source: p.source,
        view: p.view,
        url: await this.signOrNull(p.s3Key),
        isPrimary: p.id === shoe.primaryPhotoId,
        sortOrder: p.sortOrder,
        createdAt: new Date(p.createdAt).toISOString(),
      })),
    );
    const shoeTypeSlug = shoe.shoeTypeId
      ? ((
          (await m.findOne(this.catalog.shoeTypeEntity(), {
            where: { id: shoe.shoeTypeId },
            select: { id: true, slug: true },
          })) as { slug: string } | null
        )?.slug ?? null)
      : null;
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      id: shoe.id,
      brand: { id: shoe.brandId, name: shoe.brand },
      subBrand: shoe.subBrand,
      model: shoe.model,
      shoeType: { id: shoe.shoeTypeId, name: shoe.shoeType },
      category: shoe.category,
      subCategory: shoe.subCategory,
      color: shoe.colorway,
      size: { id: shoe.sizeId, label: shoe.size },
      gender: shoe.gender,
      condition: conditionViewFor(shoe.conditionCode, mappings),
      conditionFeedback: feedback
        ? {
            suggestedConditionCode: str(feedback.answer.suggestedConditionCode),
            reason: str(feedback.answer.reason),
            createdAt: new Date(feedback.createdAt).toISOString(),
          }
        : null,
      material: shoe.material,
      value: {
        min: shoe.resaleMin,
        max: shoe.resaleMax,
        currency: shoe.resaleCurrency,
        demandNote: shoe.demandNote,
        source: shoe.valueSource,
        version: shoe.valueSourceVersion,
        computedAt: iso(shoe.valueComputedAt),
      },
      recommendation: {
        action: shoe.recommendedAction,
        reason: shoe.recommendationReason,
      },
      materials: materialsFor(shoeTypeSlug),
      circularSort: { status: 'pending' },
      photos: photoViews,
      actionTaken: shoe.actionTaken,
      actionTakenAt: iso(shoe.actionTakenAt),
      share: {
        active: !!share,
        url: share ? shareUrl(shareBase, share.token) : null,
        createdAt: share ? new Date(share.createdAt).toISOString() : null,
      },
      scan: {
        scanId: scanShoe?.scanId ?? null,
        scanShoeId: shoe.scanShoeId,
      },
      rescan,
      createdAt: new Date(shoe.createdAt).toISOString(),
      updatedAt: new Date(shoe.updatedAt).toISOString(),
    };
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private async openRescan(
    m: EntityManager,
    shoeId: string,
  ): Promise<{ scanId: string; shoeId: string; status: ScanStatus } | null> {
    const row = await m
      .getRepository(ScanShoeEntity)
      .createQueryBuilder('ss')
      .innerJoin('ss.scan', 'scan')
      .select(['ss.id', 'ss.scanId'])
      .addSelect('scan.status', 'scanStatus')
      .where('ss."rescanOfShoeId" = :shoeId', { shoeId })
      .andWhere('scan.status IN (:...open)', { open: OPEN_RESCAN })
      .orderBy('ss."createdAt"', 'DESC')
      .getRawOne<{
        ss_id: string;
        ss_scanId: string;
        scanStatus: ScanStatus;
      }>();
    return row
      ? { scanId: row.ss_scanId, shoeId: row.ss_id, status: row.scanStatus }
      : null;
  }

  private async insertScanRows(
    m: EntityManager,
    shoeId: string,
    scanShoeId: string,
    startOrder: number,
  ): Promise<{ id: string; view: ShoeView | null }[]> {
    const photos = await m.find(ScanPhotoEntity, { where: { scanShoeId } });
    const ordered = [...photos].sort(
      (a, b) => SHOE_VIEWS.indexOf(a.view) - SHOE_VIEWS.indexOf(b.view),
    );
    const out: { id: string; view: ShoeView | null }[] = [];
    for (const [i, p] of ordered.entries()) {
      const id = randomUUID();
      await m.insert(ShoePhotoEntity, {
        id,
        shoeId,
        source: 'scan',
        scanPhotoId: p.id,
        view: p.view,
        s3Key: p.s3Key,
        contentType: p.contentType,
        sizeBytes: p.bytes ?? null,
        sortOrder: startOrder + i,
      });
      out.push({ id, view: p.view });
    }
    return out;
  }

  private linkView(share: ShoeShareEntity, base: string): ShareLinkView {
    return {
      url: shareUrl(base, share.token),
      token: share.token,
      createdAt: new Date(share.createdAt).toISOString(),
    };
  }

  private assertPhotoRoom(count: number): void {
    if (count >= this.cfg.maxPhotos) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'PHOTO_LIMIT_REACHED',
        `A shoe can hold at most ${this.cfg.maxPhotos} photos`,
      );
    }
  }

  private requireStorage(): void {
    if (!this.storage.isConfigured()) {
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'STORAGE_NOT_CONFIGURED',
        'Photo storage is not available',
      );
    }
  }

  private async putOrThrow(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    try {
      await this.storage.put(key, body, contentType);
    } catch (err) {
      if (err instanceof StorageNotConfiguredError) this.requireStorage();
      this.logger.error(
        `put ${key} failed: ${err instanceof StorageUnavailableError ? err.message : String(err)}`,
      );
      throw new ApiError(
        HttpStatus.BAD_GATEWAY,
        'STORAGE_UNAVAILABLE',
        'Photo storage failed, try again',
      );
    }
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.warn(`could not delete ${key}: ${String(err)}`);
    }
  }

  /** A signing failure never fails a profile read. */
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

/** jsonb values are unknown; only strings are shown back. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function editable(s: ShoeEntity): EditableShoe {
  return {
    brandId: s.brandId,
    brand: s.brand,
    model: s.model,
    colorway: s.colorway,
    sizeId: s.sizeId,
    size: s.size,
    shoeTypeId: s.shoeTypeId,
    shoeType: s.shoeType,
    gender: s.gender,
    actionTaken: s.actionTaken,
    actionTakenAt: s.actionTakenAt,
    primaryPhotoId: s.primaryPhotoId,
  };
}

function pickPrimary(
  rows: readonly { id: string; view: ShoeView | null }[],
  preferred: ShoeView,
): string | null {
  return (
    rows.find((r) => r.view === preferred)?.id ??
    rows.find((r) => r.view !== null)?.id ??
    rows[0]?.id ??
    null
  );
}
