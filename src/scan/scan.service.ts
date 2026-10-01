// F1 scan-session service. Every query is scoped by the caller's user id
// (foreign ids behave exactly like missing ones → 404). Writes that depend on
// session state lock the scan row (SELECT … FOR UPDATE) so concurrent taps from
// the same user cannot race positions, finish twice or edit after finish.
//
// Storage ordering:
//   upload → S3 put first, then the DB row; a failed DB step deletes the new
//            object again (compensation).
//   delete → DB row first, then the S3 object after commit (best effort,
//            behind SCAN_DELETE_OBJECTS_ON_REMOVE). A failed S3 delete is only
//            logged; the abandoned-scan lifecycle rule is the backstop.
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import type { PhotoType, ScanConfig } from '../config/scan.config';
import {
  PhotoStorage,
  StorageNotConfiguredError,
  StorageUnavailableError,
} from '../storage/photo-storage';
import { ScanEntity } from './entities/scan.entity';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import {
  CONTENT_TYPE,
  checkPhoto,
  computeShoeState,
  decideAlbumShoes,
  incompleteShoes,
  labelFor,
  orderByPosition,
  renumber,
  scanPhotoKey,
  sniffImageType,
  type AlbumFileInfo,
  type AlbumManifestShoe,
} from './scan-rules';
import type { ScanStatus, ShoeView } from './scan.types';
import type {
  AlbumBatchView,
  AlbumShoeResult,
  ScanListView,
  ScanSessionView,
  ScanSummaryView,
} from './scan.view';

/** Minimal file shape (subset of Express.Multer.File) the service needs. */
export interface UploadedPhoto {
  fieldname: string;
  buffer: Buffer;
  size: number;
}

type ShoeWithPhotos = ScanShoeEntity & { photos: ScanPhotoEntity[] };

@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);
  private readonly cfg: ScanConfig;

  constructor(
    @InjectRepository(ScanEntity)
    private readonly scans: Repository<ScanEntity>,
    private readonly dataSource: DataSource,
    private readonly storage: PhotoStorage,
    config: ConfigService,
  ) {
    this.cfg = config.get<ScanConfig>('scan')!;
  }

  // ─── E1 create draft ──────────────────────────────────────────────────────
  async createDraft(userId: string): Promise<ScanSessionView> {
    this.requireStorage();
    if (this.cfg.maxOpenDrafts > 0) {
      const open = await this.scans.count({
        where: { userId, status: 'draft' },
      });
      if (open >= this.cfg.maxOpenDrafts) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'DRAFT_LIMIT_REACHED',
          `You can have at most ${this.cfg.maxOpenDrafts} open scans`,
        );
      }
    }
    const scan = await this.scans.save(
      this.scans.create({ userId, status: 'draft', source: 'camera' }),
    );
    this.logger.log(`scan ${scan.id} created`);
    return this.buildSession(scan, []);
  }

  // ─── E2 list ──────────────────────────────────────────────────────────────
  async list(
    userId: string,
    status: ScanStatus | undefined,
    limit: number,
    offset: number,
  ): Promise<ScanListView> {
    const where = status ? { userId, status } : { userId };
    const [rows, total] = await this.scans.findAndCount({
      where,
      order: { updatedAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    const shoes = rows.length
      ? await this.loadShoes(
          this.dataSource.manager,
          rows.map((r) => r.id),
        )
      : [];
    const items: ScanSummaryView[] = rows.map((r) => {
      const mine = shoes.filter((s) => s.scanId === r.id);
      const complete = mine.filter(
        (s) => computeShoeState(s.photos.map((p) => p.view)).complete,
      ).length;
      return {
        id: r.id,
        status: r.status,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        shoeCount: mine.length,
        completeShoes: complete,
        canFinish:
          r.status === 'draft' && mine.length > 0 && complete === mine.length,
      };
    });
    return { items, total, limit, offset };
  }

  // ─── E3 get ───────────────────────────────────────────────────────────────
  async get(userId: string, scanId: string): Promise<ScanSessionView> {
    this.requireStorage();
    const scan = await this.findOwned(this.dataSource.manager, userId, scanId);
    return this.buildSession(
      scan,
      await this.loadShoes(this.dataSource.manager, [scan.id]),
    );
  }

  // ─── E4 add shoe ──────────────────────────────────────────────────────────
  async addShoe(userId: string, scanId: string): Promise<ScanSessionView> {
    this.requireStorage();
    return this.inDraftTx(userId, scanId, async (m, scan) => {
      const count = await m.count(ScanShoeEntity, {
        where: { scanId: scan.id },
      });
      if (count >= this.cfg.maxShoes) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'SHOE_LIMIT_REACHED',
          `A scan can hold at most ${this.cfg.maxShoes} shoes`,
        );
      }
      await m.insert(ScanShoeEntity, {
        scanId: scan.id,
        position: count + 1,
        status: 'capturing',
      });
      await this.touch(m, scan.id);
      return { afterCommitDeletes: [] };
    });
  }

  // ─── E5 delete shoe (+ renumber) ─────────────────────────────────────────
  async deleteShoe(
    userId: string,
    scanId: string,
    shoeId: string,
  ): Promise<ScanSessionView> {
    this.requireStorage();
    return this.inDraftTx(userId, scanId, async (m, scan) => {
      const shoes = await this.loadShoes(m, [scan.id]);
      const target = shoes.find((s) => s.id === shoeId);
      if (!target) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
      const keys = target.photos.map((p) => p.s3Key);
      await m.delete(ScanShoeEntity, { id: target.id });
      const remaining = orderByPosition(shoes.filter((s) => s.id !== shoeId));
      for (const [id, position] of renumber(remaining.map((s) => s.id))) {
        const before = remaining.find((s) => s.id === id)!.position;
        if (before !== position)
          await m.update(ScanShoeEntity, { id }, { position });
      }
      await this.touch(m, scan.id);
      return { afterCommitDeletes: keys };
    });
  }

  // ─── E6 upload / retake one view ─────────────────────────────────────────
  async uploadPhoto(
    userId: string,
    scanId: string,
    shoeId: string,
    view: ShoeView,
    file: UploadedPhoto | undefined,
    takenAt: Date | null,
  ): Promise<ScanSessionView> {
    this.requireStorage();
    const type = this.validatePhoto(file);

    // Cheap pre-checks without a lock, so a bad request never touches S3.
    const scan = await this.findOwned(this.dataSource.manager, userId, scanId);
    assertDraft(scan);
    const shoe = await this.dataSource.manager.findOne(ScanShoeEntity, {
      where: { id: shoeId, scanId: scan.id },
    });
    if (!shoe) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');

    const key = scanPhotoKey(scan.id, shoe.id, view, type);
    await this.putOrThrow(key, file!.buffer, CONTENT_TYPE[type]);

    let oldKey: string | null = null;
    try {
      const session = await this.inDraftTx(
        userId,
        scanId,
        async (m, locked) => {
          const stillThere = await m.findOne(ScanShoeEntity, {
            where: { id: shoe.id, scanId: locked.id },
          });
          if (!stillThere) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
          const existing = await m.findOne(ScanPhotoEntity, {
            where: { scanShoeId: shoe.id, view },
          });
          oldKey = existing && existing.s3Key !== key ? existing.s3Key : null;
          if (existing) {
            await m.update(
              ScanPhotoEntity,
              { id: existing.id },
              {
                s3Key: key,
                contentType: CONTENT_TYPE[type],
                bytes: file!.size,
                takenAt,
                uploadStatus: 'uploaded',
                width: null,
                height: null,
              },
            );
          } else {
            await m.insert(ScanPhotoEntity, {
              scanShoeId: shoe.id,
              view,
              s3Key: key,
              contentType: CONTENT_TYPE[type],
              bytes: file!.size,
              takenAt,
              uploadStatus: 'uploaded',
            });
          }
          await this.refreshShoeStatus(m, shoe.id);
          await this.touch(m, locked.id);
          // A jpg → png retake leaves the old object under a different key.
          return { afterCommitDeletes: oldKey ? [oldKey] : [] };
        },
      );
      return session;
    } catch (err) {
      // DB step failed: remove the object we just wrote, unless it replaced an
      // existing one under the same key (a retake) — then it is the live photo.
      const sameKeyRetake = await this.photoExistsWithKey(shoe.id, view, key);
      if (!sameKeyRetake) await this.safeDelete(key);
      throw err;
    }
  }

  // ─── E7 delete one view ──────────────────────────────────────────────────
  async deletePhoto(
    userId: string,
    scanId: string,
    shoeId: string,
    view: ShoeView,
  ): Promise<ScanSessionView> {
    this.requireStorage();
    return this.inDraftTx(userId, scanId, async (m, scan) => {
      const shoe = await m.findOne(ScanShoeEntity, {
        where: { id: shoeId, scanId: scan.id },
      });
      if (!shoe) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
      const photo = await m.findOne(ScanPhotoEntity, {
        where: { scanShoeId: shoe.id, view },
      });
      if (!photo)
        throw notFound('PHOTO_NOT_FOUND', `No '${view}' photo for this shoe`);
      await m.delete(ScanPhotoEntity, { id: photo.id });
      await this.refreshShoeStatus(m, shoe.id);
      await this.touch(m, scan.id);
      return { afterCommitDeletes: [photo.s3Key] };
    });
  }

  // ─── E8 album batch ──────────────────────────────────────────────────────
  async albumBatch(
    userId: string,
    scanId: string,
    manifest: AlbumManifestShoe[],
    files: UploadedPhoto[],
  ): Promise<AlbumBatchView> {
    this.requireStorage();
    const refs = manifest.reduce((n, s) => n + s.files.length, 0);
    if (
      manifest.length > this.cfg.albumMaxShoes ||
      refs > this.cfg.albumMaxPhotos ||
      files.length > this.cfg.albumMaxPhotos
    ) {
      throw new ApiError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'BATCH_TOO_LARGE',
        `An album upload can hold at most ${this.cfg.albumMaxShoes} shoes and ${this.cfg.albumMaxPhotos} photos`,
      );
    }
    const byField = new Map<string, UploadedPhoto>();
    for (const f of files) {
      if (byField.has(f.fieldname)) {
        throw new ApiError(
          HttpStatus.BAD_REQUEST,
          'DUPLICATE_FILE_FIELD',
          `File part '${f.fieldname}' was sent twice`,
        );
      }
      byField.set(f.fieldname, f);
    }
    const info = new Map<string, AlbumFileInfo>(
      [...byField].map(([k, f]) => [
        k,
        { size: f.size, type: sniffImageType(f.buffer) },
      ]),
    );

    const uploaded: string[] = [];
    const results: AlbumShoeResult[] = [];
    let session: ScanSessionView;
    try {
      session = await this.inDraftTx(userId, scanId, async (m, scan) => {
        const current = await m.count(ScanShoeEntity, {
          where: { scanId: scan.id },
        });
        const decisions = decideAlbumShoes(
          manifest,
          info,
          {
            photoMaxBytes: this.cfg.photoMaxBytes,
            allowedTypes: this.cfg.photoAllowedTypes,
          },
          this.cfg.maxShoes - current,
        );
        let position = current;
        for (const d of decisions) {
          if (!d.accepted) {
            results.push({
              ref: d.ref,
              saved: false,
              error: d.error,
              detail: d.detail,
            });
            continue;
          }
          const shoeId = randomUUID();
          const keys: string[] = [];
          try {
            for (const f of d.files) {
              const key = scanPhotoKey(scan.id, shoeId, f.view, f.type);
              await this.storage.put(
                key,
                byField.get(f.field)!.buffer,
                CONTENT_TYPE[f.type],
              );
              keys.push(key);
              uploaded.push(key);
            }
          } catch (err) {
            this.logger.error(
              `album shoe ${d.ref} upload failed: ${String(err)}`,
            );
            for (const k of keys) await this.safeDelete(k);
            results.push({
              ref: d.ref,
              saved: false,
              error: 'STORAGE_UNAVAILABLE',
              detail: 'photo storage failed, try again',
            });
            continue;
          }
          position += 1;
          await m.insert(ScanShoeEntity, {
            id: shoeId,
            scanId: scan.id,
            position,
            status: 'capturing',
          });
          await m.insert(
            ScanPhotoEntity,
            d.files.map((f, i) => ({
              scanShoeId: shoeId,
              view: f.view,
              s3Key: keys[i],
              contentType: CONTENT_TYPE[f.type],
              bytes: byField.get(f.field)!.size,
              uploadStatus: 'uploaded' as const,
            })),
          );
          await this.refreshShoeStatus(m, shoeId);
          const state = computeShoeState(d.files.map((f) => f.view));
          results.push({
            ref: d.ref,
            saved: true,
            shoeId,
            label: labelFor(position),
            complete: state.complete,
            missing: state.missing,
          });
        }
        if (results.some((r) => r.saved)) {
          await m.update(ScanEntity, { id: scan.id }, { source: 'album' });
        }
        await this.touch(m, scan.id);
        return { afterCommitDeletes: [] };
      });
    } catch (err) {
      for (const k of uploaded) await this.safeDelete(k);
      throw err;
    }
    return { session, results };
  }

  // ─── E9 finish ───────────────────────────────────────────────────────────
  async finish(userId: string, scanId: string): Promise<ScanSessionView> {
    this.requireStorage();
    return this.inDraftTx(userId, scanId, async (m, scan) => {
      const shoes = await this.loadShoes(m, [scan.id]);
      if (shoes.length === 0) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'NO_SHOES',
          'Add at least one shoe before finishing',
        );
      }
      const incomplete = incompleteShoes(
        shoes.map((s) => ({
          id: s.id,
          position: s.position,
          views: s.photos.map((p) => p.view),
        })),
      );
      if (incomplete.length > 0) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'SCAN_INCOMPLETE',
          'Every shoe needs all 4 views before finishing',
          { incomplete },
        );
      }
      await m.update(
        ScanEntity,
        { id: scan.id },
        { status: 'processing', finishedAt: new Date() },
      );
      this.logger.log(`scan ${scan.id} finished with ${shoes.length} shoe(s)`);
      return { afterCommitDeletes: [] };
    });
  }

  // ─── abandon job ─────────────────────────────────────────────────────────
  /** Marks drafts idle for SCAN_DRAFT_ABANDON_DAYS as abandoned. Idempotent. */
  async abandonStaleDrafts(now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.cfg.draftAbandonDays * 86_400_000,
    );
    const res = await this.scans
      .createQueryBuilder()
      .update(ScanEntity)
      .set({ status: 'abandoned' })
      .where('status = :draft', { draft: 'draft' })
      .andWhere('"updatedAt" < :cutoff', { cutoff })
      .execute();
    return res.affected ?? 0;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * Runs `work` in a transaction holding a row lock on the caller's draft scan,
   * then (after commit) deletes the returned S3 keys and returns the fresh view.
   */
  private async inDraftTx(
    userId: string,
    scanId: string,
    work: (
      m: EntityManager,
      scan: ScanEntity,
    ) => Promise<{ afterCommitDeletes: string[] }>,
  ): Promise<ScanSessionView> {
    const { afterCommitDeletes } = await this.dataSource.transaction(
      async (m) => {
        const scan = await this.findOwned(m, userId, scanId, true);
        assertDraft(scan);
        return work(m, scan);
      },
    );
    if (this.cfg.deleteObjectsOnRemove) {
      for (const key of afterCommitDeletes) await this.safeDelete(key);
    }
    return this.get(userId, scanId);
  }

  private async findOwned(
    m: EntityManager,
    userId: string,
    scanId: string,
    lock = false,
  ): Promise<ScanEntity> {
    const qb = m
      .getRepository(ScanEntity)
      .createQueryBuilder('scan')
      .where('scan.id = :scanId AND scan.userId = :userId', { scanId, userId });
    if (lock) qb.setLock('pessimistic_write');
    const scan = await qb.getOne();
    if (!scan) throw notFound('SCAN_NOT_FOUND', 'Scan not found');
    return scan;
  }

  private async loadShoes(
    m: EntityManager,
    scanIds: string[],
  ): Promise<ShoeWithPhotos[]> {
    const shoes = await m
      .getRepository(ScanShoeEntity)
      .createQueryBuilder('shoe')
      .leftJoinAndSelect('shoe.photos', 'photo')
      .where('shoe.scanId IN (:...scanIds)', { scanIds })
      .orderBy('shoe.position', 'ASC')
      .getMany();
    return shoes.map((s) => ({ ...s, photos: s.photos ?? [] }));
  }

  private async refreshShoeStatus(
    m: EntityManager,
    shoeId: string,
  ): Promise<void> {
    const photos = await m.find(ScanPhotoEntity, {
      where: { scanShoeId: shoeId },
      select: { view: true },
    });
    const { complete } = computeShoeState(photos.map((p) => p.view));
    await m.update(
      ScanShoeEntity,
      { id: shoeId },
      { status: complete ? 'complete' : 'capturing' },
    );
  }

  private async touch(m: EntityManager, scanId: string): Promise<void> {
    await m
      .createQueryBuilder()
      .update(ScanEntity)
      .set({ updatedAt: () => 'now()' })
      .where('id = :scanId', { scanId })
      .execute();
  }

  private async buildSession(
    scan: ScanEntity,
    shoes: ShoeWithPhotos[],
  ): Promise<ScanSessionView> {
    const ttl = this.cfg.photoUrlTtlSeconds;
    const shoeViews = await Promise.all(
      orderByPosition(shoes).map(async (s) => {
        const state = computeShoeState(s.photos.map((p) => p.view));
        const photos = await Promise.all(
          [...s.photos]
            .sort((a, b) => viewIndex(a.view) - viewIndex(b.view))
            .map(async (p) => ({
              view: p.view,
              contentType: p.contentType,
              bytes: p.bytes,
              takenAt: p.takenAt ? new Date(p.takenAt).toISOString() : null,
              updatedAt: new Date(p.updatedAt).toISOString(),
              url: await this.storage.signedGetUrl(p.s3Key, ttl),
            })),
        );
        return {
          id: s.id,
          position: s.position,
          label: labelFor(s.position),
          status: s.status,
          complete: state.complete,
          missing: state.missing,
          photos,
        };
      }),
    );
    return {
      id: scan.id,
      status: scan.status,
      source: scan.source,
      createdAt: new Date(scan.createdAt).toISOString(),
      updatedAt: new Date(scan.updatedAt).toISOString(),
      finishedAt: scan.finishedAt
        ? new Date(scan.finishedAt).toISOString()
        : null,
      canFinish:
        scan.status === 'draft' &&
        shoeViews.length > 0 &&
        shoeViews.every((s) => s.complete),
      shoes: shoeViews,
    };
  }

  private validatePhoto(file: UploadedPhoto | undefined): PhotoType {
    const type = file ? sniffImageType(file.buffer) : null;
    const rejection = checkPhoto(file ? { size: file.size, type } : undefined, {
      photoMaxBytes: this.cfg.photoMaxBytes,
      allowedTypes: this.cfg.photoAllowedTypes,
    });
    if (rejection === 'FILE_REQUIRED') {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'FILE_REQUIRED',
        'A photo file is required',
      );
    }
    if (rejection === 'FILE_TOO_LARGE') {
      throw new ApiError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'FILE_TOO_LARGE',
        `Photo must be at most ${this.cfg.photoMaxBytes} bytes`,
      );
    }
    if (rejection === 'UNSUPPORTED_TYPE') {
      throw new ApiError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'UNSUPPORTED_TYPE',
        `Photo must be one of: ${this.cfg.photoAllowedTypes.join(', ')}`,
      );
    }
    return type!;
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

  private async photoExistsWithKey(
    shoeId: string,
    view: ShoeView,
    key: string,
  ): Promise<boolean> {
    try {
      const row = await this.dataSource.manager.findOne(ScanPhotoEntity, {
        where: { scanShoeId: shoeId, view },
      });
      return row?.s3Key === key;
    } catch {
      return true; // cannot tell — keep the object rather than risk deleting a live photo
    }
  }

  private async safeDelete(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      this.logger.warn(`could not delete ${key}: ${String(err)}`);
    }
  }
}

function assertDraft(scan: ScanEntity): void {
  if (scan.status !== 'draft') {
    throw new ApiError(
      HttpStatus.CONFLICT,
      'NOT_DRAFT',
      `Scan is ${scan.status}; it can no longer be changed`,
    );
  }
}

function notFound(code: string, message: string): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, code, message);
}

function viewIndex(v: ShoeView): number {
  return ['top', 'right', 'left', 'sole'].indexOf(v);
}
