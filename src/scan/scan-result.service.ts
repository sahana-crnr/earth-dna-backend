// F2 identification-result service (Backend API Plan §4). Every query is scoped
// by the caller's user id through findOwnedScan, so a foreign id behaves exactly
// like a missing one (404) — the same invariant F1 relies on.
//
// Why the scan row is locked for a submit (F2-D2):
//   the write is three statements — upsert the result, move the shoe to
//   identified/failed, and flip the scan to 'review' once the LAST shoe has a
//   result. Without SELECT … FOR UPDATE on the scan, two shoes finishing at the
//   same moment could both read "one shoe still missing" and neither would flip
//   the scan, leaving the processing screen polling forever. The lock also makes
//   a retried submit serialise behind the first, which is what makes the upsert
//   idempotent rather than merely usually-idempotent.
//
// Unlike F1 this module touches no object storage, so requireStorage() is NOT
// called: results keep working when SHOE_PHOTOS_BUCKET is unset.
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import type { ScanConfig } from '../config/scan.config';
import { ScanEntity } from './entities/scan.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanShoeResultEntity } from './entities/scan-shoe-result.entity';
import { findOwnedScan, notFound, touchScan } from './scan-access';
import { ScanResultsBuilder, toResultView } from './scan-results.builder';
import { labelFor } from './scan-rules';
import {
  checkRawPayload,
  normalizeCandidates,
  resultStatusFor,
  type ResultCandidate,
} from './result-rules';
import type { ScanStatus } from './scan.types';
import type { SubmitShoeResultDto } from './dto/submit-shoe-result.dto';
import type { ScanResultsView, SubmitResultView } from './scan-result.view';

/** Scan states that accept a result: everything after /finish, before F3 closes it. */
const SUBMITTABLE: readonly ScanStatus[] = ['processing', 'review'];

/** Shoe states F3 has already closed; their result must not change (F2-D1). */
const LOCKED_SHOE_STATUSES = ['confirmed', 'rejected'] as const;

/** Every stored result column a writer chooses; submittedAt is stamped here. */
export type ResultFields = Pick<
  ScanShoeResultEntity,
  | 'source'
  | 'outcome'
  | 'modelVersion'
  | 'brand'
  | 'subBrand'
  | 'model'
  | 'colorway'
  | 'category'
  | 'subCategory'
  | 'material'
  | 'confidence'
  | 'conditionCode'
  | 'candidates'
  | 'raw'
>;

/** 409 NOT_PROCESSING unless the scan is past /finish and not yet closed. */
export function assertAcceptsResults(scan: ScanEntity): void {
  if (SUBMITTABLE.includes(scan.status)) return;
  throw new ApiError(
    HttpStatus.CONFLICT,
    'NOT_PROCESSING',
    scan.status === 'draft'
      ? 'Scan is still a draft; call /finish before submitting results'
      : `Scan is ${scan.status}; it no longer accepts results`,
  );
}

/** 409 RESULT_LOCKED once F3 has confirmed or rejected the shoe. */
export function assertResultOpen(shoe: ScanShoeEntity): void {
  if (!(LOCKED_SHOE_STATUSES as readonly string[]).includes(shoe.status)) {
    return;
  }
  throw new ApiError(
    HttpStatus.CONFLICT,
    'RESULT_LOCKED',
    `Shoe is ${shoe.status}; its result can no longer be changed`,
  );
}

@Injectable()
export class ScanResultService {
  private readonly logger = new Logger(ScanResultService.name);
  private readonly cfg: ScanConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly builder: ScanResultsBuilder,
    config: ConfigService,
  ) {
    this.cfg = config.get<ScanConfig>('scan')!;
  }

  // ─── E10 submit the on-device result ─────────────────────────────────────
  async submit(
    userId: string,
    scanId: string,
    shoeId: string,
    dto: SubmitShoeResultDto,
  ): Promise<SubmitResultView> {
    const outcome = dto.outcome ?? 'identified';
    // Cheap pure checks first, so a malformed payload never opens a transaction
    // or takes the scan row lock.
    if (outcome === 'identified' && (!dto.brand || dto.confidence == null)) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'RESULT_INCOMPLETE',
        "An 'identified' result needs both brand and confidence",
        {
          missing: [
            ...(dto.brand ? [] : ['brand']),
            ...(dto.confidence == null ? ['confidence'] : []),
          ],
        },
      );
    }
    const candidates = this.validateCandidates(dto.candidates ?? []);
    this.validateRaw(dto.raw);

    return this.inScanTx(userId, scanId, (m, scan) =>
      this.writeResult(m, scan, shoeId, {
        source: 'device',
        outcome,
        modelVersion: dto.modelVersion,
        brand: dto.brand ?? null,
        subBrand: dto.subBrand ?? null,
        model: dto.model ?? null,
        colorway: dto.colorway ?? null,
        category: dto.category ?? null,
        subCategory: dto.subCategory ?? null,
        material: dto.material ?? null,
        confidence: dto.confidence ?? null,
        conditionCode: dto.conditionCode ?? null,
        candidates,
        raw: dto.raw ?? null,
      }),
    );
  }

  /**
   * The shared E10 / analyze write: upsert the shoe's one result row, move the
   * shoe to identified/failed, flip the scan to 'review' on the last shoe, and
   * build the SubmitResultView — one code path, so the analyze response is the
   * E10 response by construction. Must run inside inScanTx (scan row locked).
   */
  async writeResult(
    m: EntityManager,
    scan: ScanEntity,
    shoeId: string,
    fields: ResultFields,
  ): Promise<SubmitResultView> {
    const shoe = await m.findOne(ScanShoeEntity, {
      where: { id: shoeId, scanId: scan.id },
    });
    if (!shoe) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
    assertResultOpen(shoe);

    const existing = await m.findOne(ScanShoeResultEntity, {
      where: { scanShoeId: shoe.id },
    });
    // save() rather than insert/update: a free-form jsonb column cannot be
    // expressed in TypeORM's QueryDeepPartialEntity, and setting `id` makes
    // this one call the upsert — INSERT when absent, UPDATE when present.
    const row = m.create(ScanShoeResultEntity, {
      scanShoeId: shoe.id,
      ...fields,
      // Server clock only — never taken from the body (see the DTO header).
      submittedAt: new Date(),
    });
    if (existing) row.id = existing.id;
    await m.save(row);
    await m.update(ScanShoeEntity, { id: shoe.id }, { status: fields.outcome });

    const scanStatus = await this.advanceScanIfResolved(m, scan);

    // Re-read so createdAt/updatedAt are the committed values, not guesses.
    const saved = await m.findOneOrFail(ScanShoeResultEntity, {
      where: { scanShoeId: shoe.id },
    });
    this.logger.log(
      `scan ${scan.id} shoe ${shoe.id} ${fields.source} result ${fields.outcome} (${existing ? 'replaced' : 'created'})`,
    );
    return {
      shoeId: shoe.id,
      label: labelFor(shoe.position),
      replaced: existing !== null,
      status: resultStatusFor(fields.outcome),
      // E10 returns the single submitted result with raw payload included so the
      // caller can inspect the original model output immediately.
      result: toResultView(saved, true),
      scanStatus,
    };
  }

  // ─── E11 per-shoe results ────────────────────────────────────────────────
  // E11 is polled roughly every 2s while processing; raw payloads are large and
  // should not be returned unless the caller explicitly asks for them. The view
  // itself is built by ScanResultsBuilder, shared with the F3 review routes.
  async results(
    userId: string,
    scanId: string,
    includeRaw = false,
  ): Promise<ScanResultsView> {
    const m = this.dataSource.manager;
    const scan = await findOwnedScan(m, userId, scanId);
    return this.builder.build(m, scan, includeRaw === true);
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * Runs `work` in a transaction holding a row lock on the caller's scan, after
   * asserting the scan accepts results. Mirrors ScanService.inDraftTx; the
   * response is built inside the transaction so a committed change can never
   * be reported as a failure. Public for the analyze route, which must re-check
   * state here because the scan may have moved while ShoeDNA ran.
   */
  async inScanTx<T>(
    userId: string,
    scanId: string,
    work: (m: EntityManager, scan: ScanEntity) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (m) => {
      const scan = await findOwnedScan(m, userId, scanId, true);
      assertAcceptsResults(scan);
      const out = await work(m, scan);
      await touchScan(m, scan.id);
      return out;
    });
  }

  /**
   * Moves the scan to 'review' once every shoe has a result. Idempotent and
   * safe under the row lock: an already-'review' scan stays as it is.
   */
  private async advanceScanIfResolved(
    m: EntityManager,
    scan: ScanEntity,
  ): Promise<ScanStatus> {
    const shoeIds = (
      await m.find(ScanShoeEntity, {
        where: { scanId: scan.id },
        select: { id: true },
      })
    ).map((s) => s.id);
    const done = shoeIds.length
      ? await m.count(ScanShoeResultEntity, {
          where: { scanShoeId: In(shoeIds) },
        })
      : 0;
    if (shoeIds.length === 0 || done < shoeIds.length) return scan.status;
    if (scan.status === 'review') return 'review';
    await m.update(ScanEntity, { id: scan.id }, { status: 'review' });
    this.logger.log(`scan ${scan.id} moved to review (${done} shoe result(s))`);
    return 'review';
  }

  private validateCandidates(
    raw: readonly { brand: string; model?: string; confidence: number }[],
  ): ResultCandidate[] {
    const decision = normalizeCandidates(raw, this.cfg.resultMaxCandidates);
    if (decision.ok) return decision.candidates;
    // Every candidate rejection is a malformed payload, never a conflict.
    throw new ApiError(HttpStatus.BAD_REQUEST, decision.error, decision.detail);
  }

  private validateRaw(raw: Record<string, unknown> | undefined): void {
    const bad = checkRawPayload(raw, this.cfg.resultRawMaxBytes);
    if (bad === 'RAW_TOO_LARGE') {
      throw new ApiError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'RAW_TOO_LARGE',
        `raw must serialize to at most ${this.cfg.resultRawMaxBytes} bytes`,
      );
    }
    if (bad === 'RAW_TOO_DEEP') {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'RAW_TOO_DEEP',
        'raw is nested too deeply (max 6 levels)',
      );
    }
  }
}
