// F1 scan-session service. Every query is scoped by the caller's user id
// (foreign ids behave exactly like missing ones → 404). Writes that depend on
// session state lock the scan row (SELECT … FOR UPDATE) so concurrent taps from
// the same user cannot race positions, finish twice or edit after finish.
//
// Storage ordering (PR #11 review):
//   upload → every upload gets a UNIQUE key; the object is written to S3 before
//            the short DB transaction, and the previous key (retake) is deleted
//            only after commit. A failed DB step deletes the new object. No two
//            requests ever share a key, so none can clobber another's object.
//   delete → DB rows first, then S3 objects after commit. A failed S3 delete is
//            only logged; abandon/purge sweeps are the backstop.
//   album  → same: S3 first (no DB connection held), then one short transaction.
//
// Responses are built from data read INSIDE the transaction, so a committed
// change can never be reported as a failure. URL signing problems degrade to
// `url: null` instead of failing the request.
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

/** What a locked-transaction body hands back. */
interface TxResult {
  /** S3 keys to delete once the transaction has committed. */
  afterCommitDeletes: string[];
}

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
    const scan = await this.dataSource.transaction(async (m) => {
      if (this.cfg.maxOpenDrafts > 0) {
        // Serialise count+insert per user so a double tap cannot exceed the
        // limit. Transaction-scoped advisory lock: released on commit/rollback.
        await m.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `scan-draft:${userId}`,
        ]);
        const open = await m.count(ScanEntity, {
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
      return m.save(
        m.create(ScanEntity, { userId, status: 'draft', source: 'camera' }),
      );
    });
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
      // `id` tiebreaker keeps pages stable when updatedAt values collide.
      order: { updatedAt: 'DESC', id: 'DESC' },
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
    const m = this.dataSource.manager;
    const scan = await this.findOwned(m, userId, scanId);
    return this.buildSession(scan, await this.loadShoes(m, [scan.id]));
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
      await m.delete(ScanShoeEntity, { id: target.id });
      const remaining = orderByPosition(shoes.filter((s) => s.id !== shoeId));
      for (const [id, position] of renumber(remaining.map((s) => s.id))) {
        const before = remaining.find((s) => s.id === id)!.position;
        if (before !== position) {
          await m.update(ScanShoeEntity, { id }, { position });
        }
      }
      return {
        afterCommitDeletes: this.cfg.deleteObjectsOnRemove
          ? target.photos.map((p) => p.s3Key)
          : [],
      };
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

    // Unique key per upload: a rejected or racing request can never replace
    // the object a committed row points at.
    const key = scanPhotoKey(scan.id, shoe.id, view, type, randomUUID());
    await this.putOrThrow(key, file!.buffer, CONTENT_TYPE[type]);

    try {
      return await this.inDraftTx(userId, scanId, async (m, locked) => {
        const stillThere = await m.findOne(ScanShoeEntity, {
          where: { id: shoe.id, scanId: locked.id },
        });
        if (!stillThere) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
        const existing = await m.findOne(ScanPhotoEntity, {
          where: { scanShoeId: shoe.id, view },
        });
        const fields = {
          s3Key: key,
          contentType: CONTENT_TYPE[type],
          bytes: file!.size,
          takenAt,
          uploadStatus: 'uploaded' as const,
          width: null,
          height: null,
        };
        if (existing) {
          await m.update(ScanPhotoEntity, { id: existing.id }, fields);
        } else {
          await m.insert(ScanPhotoEntity, {
            scanShoeId: shoe.id,
            view,
            ...fields,
          });
        }
        await this.refreshShoeStatus(m, shoe.id);
        // The replaced object is always removed: it is unreachable now.
        return { afterCommitDeletes: existing ? [existing.s3Key] : [] };
      });
    } catch (err) {
      // Nothing committed → the object we just wrote is an orphan.
      await this.safeDelete(key);
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
      if (!photo) {
        throw notFound('PHOTO_NOT_FOUND', `No '${view}' photo for this shoe`);
      }
      await m.delete(ScanPhotoEntity, { id: photo.id });
      await this.refreshShoeStatus(m, shoe.id);
      return {
        afterCommitDeletes: this.cfg.deleteObjectsOnRemove ? [photo.s3Key] : [],
      };
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

    // 1. Decide and upload WITHOUT holding a DB connection or the row lock.
    const m0 = this.dataSource.manager;
    const scan = await this.findOwned(m0, userId, scanId);
    assertDraft(scan);
    const current = await m0.count(ScanShoeEntity, {
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

    type Staged = {
      ref: string;
      shoeId: string;
      files: { view: ShoeView; type: PhotoType; key: string; bytes: number }[];
    };
    const results: AlbumShoeResult[] = [];
    const staged: Staged[] = [];
    const uploaded: string[] = [];
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
      const entry: Staged = { ref: d.ref, shoeId, files: [] };
      try {
        for (const f of d.files) {
          const key = scanPhotoKey(
            scan.id,
            shoeId,
            f.view,
            f.type,
            randomUUID(),
          );
          const part = byField.get(f.field)!;
          await this.storage.put(key, part.buffer, CONTENT_TYPE[f.type]);
          uploaded.push(key);
          entry.files.push({
            view: f.view,
            type: f.type,
            key,
            bytes: part.size,
          });
        }
        staged.push(entry);
      } catch (err) {
        this.logger.error(`album shoe ${d.ref} upload failed: ${String(err)}`);
        for (const f of entry.files) await this.safeDelete(f.key);
        results.push({
          ref: d.ref,
          saved: false,
          error: 'STORAGE_UNAVAILABLE',
          detail: 'photo storage failed, try again',
        });
      }
    }

    // 2. One short transaction for the rows. Capacity is re-checked under the
    //    lock; shoes that no longer fit are reported, their objects removed.
    let session: ScanSessionView;
    try {
      session = await this.inDraftTx(userId, scanId, async (m, locked) => {
        let position = await m.count(ScanShoeEntity, {
          where: { scanId: locked.id },
        });
        const dropKeys: string[] = [];
        for (const s of staged) {
          if (position >= this.cfg.maxShoes) {
            dropKeys.push(...s.files.map((f) => f.key));
            results.push({
              ref: s.ref,
              saved: false,
              error: 'SHOE_LIMIT_REACHED',
              detail: 'session is full',
            });
            continue;
          }
          position += 1;
          await m.insert(ScanShoeEntity, {
            id: s.shoeId,
            scanId: locked.id,
            position,
            status: 'capturing',
          });
          await m.insert(
            ScanPhotoEntity,
            s.files.map((f) => ({
              scanShoeId: s.shoeId,
              view: f.view,
              s3Key: f.key,
              contentType: CONTENT_TYPE[f.type],
              bytes: f.bytes,
              uploadStatus: 'uploaded' as const,
            })),
          );
          await this.refreshShoeStatus(m, s.shoeId);
          const state = computeShoeState(s.files.map((f) => f.view));
          results.push({
            ref: s.ref,
            saved: true,
            shoeId: s.shoeId,
            label: labelFor(position),
            complete: state.complete,
            missing: state.missing,
          });
        }
        if (results.some((r) => r.saved)) {
          await m.update(ScanEntity, { id: locked.id }, { source: 'album' });
        }
        return { afterCommitDeletes: dropKeys };
      });
    } catch (err) {
      for (const k of uploaded) await this.safeDelete(k);
      throw err;
    }
    // Keep manifest order in the response.
    const order = new Map(manifest.map((s, i) => [s.ref, i]));
    results.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));
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

  // ─── sweeps ──────────────────────────────────────────────────────────────
  /**
   * Marks drafts idle for SCAN_DRAFT_ABANDON_DAYS as abandoned and removes
   * their photos (rows + objects). Idempotent; safe to run on many containers.
   */
  async abandonStaleDrafts(now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.cfg.draftAbandonDays * 86_400_000,
    );
    const stale = await this.scans
      .createQueryBuilder('scan')
      .select('scan.id')
      .where('scan.status = :draft', { draft: 'draft' })
      .andWhere('scan."updatedAt" < :cutoff', { cutoff })
      .getMany();
    let n = 0;
    for (const { id } of stale) {
      const keys = await this.dataSource.transaction(async (m) => {
        // Re-check under lock: the user may have resumed it meanwhile.
        const res = await m
          .createQueryBuilder()
          .update(ScanEntity)
          .set({ status: 'abandoned' })
          .where('id = :id AND status = :draft AND "updatedAt" < :cutoff', {
            id,
            draft: 'draft',
            cutoff,
          })
          .execute();
        if (!res.affected) return null;
        return this.purgePhotosInTx(m, id);
      });
      if (keys === null) continue;
      for (const k of keys) await this.safeDelete(k);
      n += 1;
    }
    return n;
  }

  /**
   * Removes every scan of a user together with its S3 objects. Must be called
   * by any future account-deletion flow BEFORE the users row is deleted —
   * the FK cascade alone would leave the objects behind.
   */
  async deleteAllForUser(userId: string): Promise<number> {
    const keys: string[] = [];
    const n = await this.dataSource.transaction(async (m) => {
      const scans = await m.find(ScanEntity, {
        where: { userId },
        select: { id: true },
      });
      for (const s of scans)
        keys.push(...(await this.purgePhotosInTx(m, s.id)));
      if (scans.length) await m.delete(ScanEntity, { userId });
      return scans.length;
    });
    for (const k of keys) await this.safeDelete(k);
    return n;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * Runs `work` in a transaction holding a row lock on the caller's draft
   * scan, builds the response from data read inside that transaction, then
   * (after commit) deletes the returned S3 keys. The response can no longer
   * fail after the commit: URL signing errors degrade to `url: null`.
   */
  private async inDraftTx(
    userId: string,
    scanId: string,
    work: (m: EntityManager, scan: ScanEntity) => Promise<TxResult>,
  ): Promise<ScanSessionView> {
    const { view, afterCommitDeletes } = await this.dataSource.transaction(
      async (m) => {
        const scan = await this.findOwned(m, userId, scanId, true);
        assertDraft(scan);
        const result = await work(m, scan);
        await this.touch(m, scan.id);
        const fresh = await this.findOwned(m, userId, scanId);
        const view = await this.buildSession(
          fresh,
          await this.loadShoes(m, [scan.id]),
        );
        return { view, afterCommitDeletes: result.afterCommitDeletes };
      },
    );
    for (const key of afterCommitDeletes) await this.safeDelete(key);
    return view;
  }

  /** Deletes a scan's photo rows inside `m` and returns their S3 keys. */
  private async purgePhotosInTx(
    m: EntityManager,
    scanId: string,
  ): Promise<string[]> {
    const photos = await m
      .getRepository(ScanPhotoEntity)
      .createQueryBuilder('p')
      .innerJoin('p.shoe', 's')
      .where('s.scanId = :scanId', { scanId })
      .getMany();
    if (photos.length) {
      await m.delete(
        ScanPhotoEntity,
        photos.map((p) => p.id),
      );
    }
    return photos.map((p) => p.s3Key);
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
              url: await this.signOrNull(p.s3Key, ttl),
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

  /** A signing failure must never turn a saved change into an error. */
  private async signOrNull(key: string, ttl: number): Promise<string | null> {
    try {
      return await this.storage.signedGetUrl(key, ttl);
    } catch (err) {
      this.logger.warn(`could not sign ${key}: ${String(err)}`);
      return null;
    }
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
