// Server-side ShoeDNA fallback (analyze). The app runs ShoeDNA on-device
// first; when that fails it calls this instead of the retired Boston path, and
// the backend runs inference on the photos F1 already stored for the shoe.
//
// Three phases, because the CLAUDE.md storage rule applies to any slow
// external call: never hold a DB connection or row lock across it.
//   1. pre-check, no lock: ownership (404), scan finished (409 NOT_PROCESSING),
//      shoe still open (409 RESULT_LOCKED), not already identified (409
//      ALREADY_IDENTIFIED), photos present, storage + ShoeDNA configured — so
//      a request that cannot succeed never reaches the model;
//   2. sign the photo URLs and call ShoeDNA, outside any transaction;
//   3. ScanResultService.inScanTx + writeResult — the E10 write path, so the
//      scan/shoe state is re-checked under the lock (it may have moved while
//      the model ran) and the response is the E10 SubmitResultView by
//      construction.
//
// Fallback only: analyze runs on a shoe with no result yet or a 'failed' one,
// never over an 'identified' one — a retry or double tap must not replace a
// good device answer (or downgrade it to failed). The check is here, not in
// writeResult, because E10 itself may still replace any open result.
//
// A failed or timed-out model call writes nothing: the shoe stays as it was,
// so the app can retry analyze or record `outcome: 'failed'` through E10.
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import type { ScanConfig } from '../config/scan.config';
import { IntegrationsService } from '../integrations/integrations.service';
import { SecretUnavailableError } from '../integrations/secret-resolver';
import { PhotoStorage } from '../storage/photo-storage';
import { requireStorage } from '../storage/photo-storage.ops';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { findOwnedScan, notFound } from './scan-access';
import {
  assertAcceptsResults,
  assertResultOpen,
  ScanResultService,
} from './scan-result.service';
import type { SubmitResultView } from './scan-result.view';
import { SHOE_VIEWS } from './scan.types';
import { mapShoeDnaResponse, type ShoeDnaPhoto } from './shoedna-rules';
import {
  InferenceFailedError,
  InferenceTimeoutError,
  ShoeDnaClient,
} from './shoedna.client';

@Injectable()
export class ScanAnalyzeService {
  private readonly logger = new Logger(ScanAnalyzeService.name);
  private readonly cfg: ScanConfig;

  constructor(
    private readonly dataSource: DataSource,
    private readonly results: ScanResultService,
    private readonly integrations: IntegrationsService,
    private readonly storage: PhotoStorage,
    private readonly shoedna: ShoeDnaClient,
    config: ConfigService,
  ) {
    this.cfg = config.get<ScanConfig>('scan')!;
  }

  async analyze(
    userId: string,
    scanId: string,
    shoeId: string,
  ): Promise<SubmitResultView> {
    // ── 1. pre-check (no lock) ───────────────────────────────────────────────
    const m = this.dataSource.manager;
    const scan = await findOwnedScan(m, userId, scanId);
    assertAcceptsResults(scan);
    const shoe = await m.findOne(ScanShoeEntity, {
      where: { id: shoeId, scanId: scan.id },
    });
    if (!shoe) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
    assertResultOpen(shoe);
    assertNeedsAnalysis(shoe);

    const photos = await m.find(ScanPhotoEntity, {
      where: { scanShoeId: shoe.id },
    });
    if (photos.length === 0) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'NO_PHOTOS',
        'This shoe has no stored photos to analyze',
      );
    }
    requireStorage(this.storage);

    const active = await this.integrations.getActive('shoedna');
    if (!active) {
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        'INFERENCE_NOT_CONFIGURED',
        'Server-side identification is not available',
      );
    }

    // ── 2. sign + infer (no transaction) ─────────────────────────────────────
    const signed = await this.signPhotos(photos);
    let body: unknown;
    try {
      body = await this.shoedna.identify(active, {
        scanId: scan.id,
        shoeId: shoe.id,
        photos: signed,
      });
    } catch (err) {
      throw toApiError(err);
    }

    const mapped = mapShoeDnaResponse(body, {
      maxCandidates: this.cfg.resultMaxCandidates,
      rawMaxBytes: this.cfg.resultRawMaxBytes,
      versionFallback: active.version,
    });
    if (!mapped.ok) {
      this.logger.error(
        `shoe ${shoe.id}: unusable ShoeDNA response: ${mapped.reason}`,
      );
      throw inferenceFailed();
    }
    if (mapped.rawDropped) {
      this.logger.warn(
        `shoe ${shoe.id}: ShoeDNA body over the raw cap, not stored`,
      );
    }

    // ── 3. write under the scan lock (E10 path) ──────────────────────────────
    return this.results.inScanTx(userId, scanId, async (tx, locked) => {
      // The device may have submitted a result while ShoeDNA ran.
      const current = await tx.findOne(ScanShoeEntity, {
        where: { id: shoeId, scanId: locked.id },
      });
      if (current) assertNeedsAnalysis(current);
      return this.results.writeResult(tx, locked, shoeId, mapped.fields);
    });
  }

  /** Every stored view, in canonical view order. A signing failure is a 502:
   *  unlike a thumbnail, the model cannot work around a missing photo. */
  private async signPhotos(photos: ScanPhotoEntity[]): Promise<ShoeDnaPhoto[]> {
    const sorted = [...photos].sort(
      (a, b) => SHOE_VIEWS.indexOf(a.view) - SHOE_VIEWS.indexOf(b.view),
    );
    try {
      return await Promise.all(
        sorted.map(async (p) => ({
          view: p.view,
          contentType: p.contentType,
          url: await this.storage.signedGetUrl(
            p.s3Key,
            this.cfg.photoUrlTtlSeconds,
          ),
        })),
      );
    } catch (err) {
      this.logger.error(`signing photos failed: ${String(err)}`);
      throw new ApiError(
        HttpStatus.BAD_GATEWAY,
        'STORAGE_UNAVAILABLE',
        'Photo storage failed, try again',
      );
    }
  }
}

/** 409 ALREADY_IDENTIFIED: analyze is the fallback, not a second opinion. */
function assertNeedsAnalysis(shoe: ScanShoeEntity): void {
  if (shoe.status !== 'identified') return;
  throw new ApiError(
    HttpStatus.CONFLICT,
    'ALREADY_IDENTIFIED',
    'Shoe already has an identified result; analyze is only for a missing or failed one',
  );
}

function toApiError(err: unknown): unknown {
  if (err instanceof InferenceTimeoutError) {
    return new ApiError(
      HttpStatus.GATEWAY_TIMEOUT,
      'INFERENCE_TIMEOUT',
      'Identification took too long, try again',
    );
  }
  if (err instanceof InferenceFailedError) return inferenceFailed();
  if (err instanceof SecretUnavailableError) {
    return new ApiError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'INFERENCE_CREDENTIAL_UNAVAILABLE',
      'Server-side identification is not available',
    );
  }
  return err;
}

function inferenceFailed(): ApiError {
  return new ApiError(
    HttpStatus.BAD_GATEWAY,
    'INFERENCE_FAILED',
    'Identification failed, try again',
  );
}
