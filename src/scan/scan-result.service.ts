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
import { labelFor } from './scan-rules';
import {
  checkRawPayload,
  conditionLabelFor,
  matchPercent,
  normalizeCandidates,
  resultStatusFor,
  type ResultCandidate,
} from './result-rules';
import type { ScanStatus } from './scan.types';
import type { SubmitShoeResultDto } from './dto/submit-shoe-result.dto';
import type {
  ScanResultsView,
  ShoeResultEntryView,
  ShoeResultView,
  SubmitResultView,
} from './scan-result.view';

/** Scan states that accept a result: everything after /finish, before F3 closes it. */
const SUBMITTABLE: readonly ScanStatus[] = ['processing', 'review'];

/** Shoe states F3 has already closed; their result must not change (F2-D1). */
const LOCKED_SHOE_STATUSES = ['confirmed', 'rejected'] as const;

@Injectable()
export class ScanResultService {
  private readonly logger = new Logger(ScanResultService.name);
  private readonly cfg: ScanConfig;

  constructor(
    private readonly dataSource: DataSource,
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

    return this.inScanTx(userId, scanId, SUBMITTABLE, async (m, scan) => {
      const shoe = await m.findOne(ScanShoeEntity, {
        where: { id: shoeId, scanId: scan.id },
      });
      if (!shoe) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
      if ((LOCKED_SHOE_STATUSES as readonly string[]).includes(shoe.status)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'RESULT_LOCKED',
          `Shoe is ${shoe.status}; its result can no longer be changed`,
        );
      }

      const existing = await m.findOne(ScanShoeResultEntity, {
        where: { scanShoeId: shoe.id },
      });
      const fields = {
        source: 'device' as const,
        outcome,
        modelVersion: dto.modelVersion,
        brand: dto.brand ?? null,
        subBrand: dto.subBrand ?? null,
        model: dto.model ?? null,
        colorway: dto.colorway ?? null,
        confidence: dto.confidence ?? null,
        conditionCode: dto.conditionCode ?? null,
        candidates,
        raw: dto.raw ?? null,
        submittedAt: dto.submittedAt ? new Date(dto.submittedAt) : new Date(),
      };
      // save() rather than insert/update: a free-form jsonb column cannot be
      // expressed in TypeORM's QueryDeepPartialEntity, and setting `id` makes
      // this one call the upsert — INSERT when absent, UPDATE when present.
      const row = m.create(ScanShoeResultEntity, {
        scanShoeId: shoe.id,
        ...fields,
      });
      if (existing) row.id = existing.id;
      await m.save(row);
      await m.update(ScanShoeEntity, { id: shoe.id }, { status: outcome });

      const scanStatus = await this.advanceScanIfResolved(m, scan);

      // Re-read so createdAt/updatedAt are the committed values, not guesses.
      const saved = await m.findOneOrFail(ScanShoeResultEntity, {
        where: { scanShoeId: shoe.id },
      });
      this.logger.log(
        `scan ${scan.id} shoe ${shoe.id} result ${outcome} (${existing ? 'replaced' : 'created'})`,
      );
      return {
        shoeId: shoe.id,
        label: labelFor(shoe.position),
        replaced: existing !== null,
        status: resultStatusFor(outcome, outcome),
        result: toResultView(saved),
        scanStatus,
      };
    });
  }

  // ─── E11 per-shoe results ────────────────────────────────────────────────
  async results(userId: string, scanId: string): Promise<ScanResultsView> {
    const m = this.dataSource.manager;
    const scan = await findOwnedScan(m, userId, scanId);
    const shoes = await m.find(ScanShoeEntity, {
      where: { scanId: scan.id },
      order: { position: 'ASC' },
    });
    const rows = shoes.length
      ? await m.find(ScanShoeResultEntity, {
          where: { scanShoeId: In(shoes.map((s) => s.id)) },
        })
      : [];
    const byShoe = new Map(rows.map((r) => [r.scanShoeId, r]));

    const entries: ShoeResultEntryView[] = shoes.map((s) => {
      const row = byShoe.get(s.id) ?? null;
      return {
        shoeId: s.id,
        position: s.position,
        label: labelFor(s.position),
        status: resultStatusFor(s.status, row?.outcome ?? null),
        result: row ? toResultView(row) : null,
      };
    });
    return {
      scanId: scan.id,
      status: scan.status,
      allResolved: shoes.length > 0 && entries.every((e) => e.result !== null),
      shoes: entries,
    };
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * Runs `work` in a transaction holding a row lock on the caller's scan, after
   * asserting the scan is in one of `allowed`. Mirrors ScanService.inDraftTx;
   * the response is built inside the transaction so a committed change can
   * never be reported as a failure.
   */
  private async inScanTx<T>(
    userId: string,
    scanId: string,
    allowed: readonly ScanStatus[],
    work: (m: EntityManager, scan: ScanEntity) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (m) => {
      const scan = await findOwnedScan(m, userId, scanId, true);
      if (!allowed.includes(scan.status)) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'NOT_PROCESSING',
          scan.status === 'draft'
            ? 'Scan is still a draft; call /finish before submitting results'
            : `Scan is ${scan.status}; it no longer accepts results`,
        );
      }
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

/** Entity → response. The label and matchPercent are derived, never stored. */
function toResultView(row: ScanShoeResultEntity): ShoeResultView {
  return {
    source: row.source,
    outcome: row.outcome,
    modelVersion: row.modelVersion,
    brand: row.brand,
    subBrand: row.subBrand,
    model: row.model,
    colorway: row.colorway,
    confidence: row.confidence,
    matchPercent: matchPercent(row.confidence),
    condition: {
      code: row.conditionCode,
      label: conditionLabelFor(row.conditionCode),
    },
    candidates: row.candidates ?? [],
    raw: row.raw,
    submittedAt: new Date(row.submittedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
