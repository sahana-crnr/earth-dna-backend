// Unit tests for ScanAnalyzeService with every collaborator mocked: the
// pre-check gates (404 / 409 / 503), the error mapping of a failed model call
// (502 / 504, nothing written), and that a success goes through the shared
// E10 write path with source 'server'. The real write path against Postgres is
// covered in scan-result.service.it.spec.ts.
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import { IntegrationsService } from '../integrations/integrations.service';
import { SecretUnavailableError } from '../integrations/secret-resolver';
import { PhotoStorage } from '../storage/photo-storage';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';
import { ScanAnalyzeService } from './scan-analyze.service';
import { ScanResultService } from './scan-result.service';
import type { SubmitResultView } from './scan-result.view';
import {
  InferenceFailedError,
  InferenceTimeoutError,
  ShoeDnaClient,
} from './shoedna.client';

const USER = 'u1';
const SCAN = 's1';
const SHOE = 'h1';
const ACTIVE = {
  name: 'shoedna' as const,
  baseUrl: 'https://shoedna.example.com',
  version: 'v2.1',
  authRef: null,
};
const VIEW = { shoeId: SHOE, replaced: false } as SubmitResultView;

describe('ScanAnalyzeService', () => {
  let scan: { id: string; status: string } | null;
  let shoe: { id: string; scanId: string; status: string } | null;
  let photos: Partial<ScanPhotoEntity>[];
  let configured: boolean;
  const getActive = jest.fn();
  const identify = jest.fn();
  const signedGetUrl = jest.fn();
  const writeResult = jest.fn();
  let service: ScanAnalyzeService;

  beforeEach(() => {
    scan = { id: SCAN, status: 'processing' };
    shoe = { id: SHOE, scanId: SCAN, status: 'complete' };
    photos = [
      { view: 'sole', s3Key: 'k/sole', contentType: 'image/jpeg' },
      { view: 'top', s3Key: 'k/top', contentType: 'image/png' },
    ];
    configured = true;
    getActive.mockReset().mockResolvedValue(ACTIVE);
    identify.mockReset().mockResolvedValue({
      modelVersion: 'shoedna-server-2',
      brand: 'Nike',
      confidence: 0.8,
    });
    signedGetUrl
      .mockReset()
      .mockImplementation((k: string) => `https://signed/${k}`);
    writeResult.mockReset().mockResolvedValue(VIEW);

    const qb = {
      where: () => qb,
      getOne: () => Promise.resolve(scan),
    };
    const manager = {
      getRepository: () => ({ createQueryBuilder: () => qb }),
      findOne: (entity: unknown, opts: { where: { id: string } }) =>
        Promise.resolve(
          entity === ScanShoeEntity && shoe?.id === opts.where.id ? shoe : null,
        ),
      find: (entity: unknown) =>
        Promise.resolve(entity === ScanPhotoEntity ? photos : []),
    };
    const results = {
      inScanTx: (
        _u: string,
        _s: string,
        work: (m: unknown, s: unknown) => Promise<unknown>,
      ) => work('tx', scan),
      writeResult,
    } as unknown as ScanResultService;
    const storage = {
      isConfigured: () => configured,
      signedGetUrl,
    } as unknown as PhotoStorage;

    service = new ScanAnalyzeService(
      { manager } as unknown as DataSource,
      results,
      { getActive } as unknown as IntegrationsService,
      storage,
      { identify } as unknown as ShoeDnaClient,
      {
        get: () => ({
          resultMaxCandidates: 3,
          resultRawMaxBytes: 8192,
          photoUrlTtlSeconds: 900,
        }),
      } as unknown as ConfigService,
    );
  });

  async function codeOf(p: Promise<unknown>): Promise<[number, string] | 'OK'> {
    try {
      await p;
      return 'OK';
    } catch (e) {
      if (e instanceof ApiError) return [e.getStatus(), e.code];
      throw e;
    }
  }
  const run = (shoeId = SHOE) => service.analyze(USER, SCAN, shoeId);

  it('runs ShoeDNA on the signed photos and writes a server result via the E10 path', async () => {
    await expect(run()).resolves.toBe(VIEW);

    const [active, request] = identify.mock.calls[0] as [
      unknown,
      { photos: unknown[] },
    ];
    expect(active).toBe(ACTIVE);
    // Canonical view order (top before sole), signed with the configured TTL.
    expect(request).toEqual({
      scanId: SCAN,
      shoeId: SHOE,
      photos: [
        { view: 'top', url: 'https://signed/k/top', contentType: 'image/png' },
        {
          view: 'sole',
          url: 'https://signed/k/sole',
          contentType: 'image/jpeg',
        },
      ],
    });
    expect(signedGetUrl).toHaveBeenCalledWith('k/top', 900);

    const [tx, lockedScan, shoeId, fields] = writeResult.mock.calls[0] as [
      unknown,
      unknown,
      string,
      unknown,
    ];
    expect(tx).toBe('tx');
    expect(lockedScan).toBe(scan);
    expect(shoeId).toBe(SHOE);
    expect(fields).toMatchObject({
      source: 'server',
      outcome: 'identified',
      brand: 'Nike',
      confidence: 0.8,
      modelVersion: 'shoedna-server-2',
    });
  });

  it('404 SCAN_NOT_FOUND for an unknown or foreign scan', async () => {
    scan = null;
    expect(await codeOf(run())).toEqual([404, 'SCAN_NOT_FOUND']);
    expect(identify).not.toHaveBeenCalled();
  });

  it('404 SHOE_NOT_FOUND for a shoe outside the scan', async () => {
    expect(await codeOf(run('other'))).toEqual([404, 'SHOE_NOT_FOUND']);
    expect(identify).not.toHaveBeenCalled();
  });

  it.each(['draft', 'completed', 'abandoned'])(
    '409 NOT_PROCESSING on a %s scan, before any model call',
    async (status) => {
      scan!.status = status;
      expect(await codeOf(run())).toEqual([409, 'NOT_PROCESSING']);
      expect(identify).not.toHaveBeenCalled();
    },
  );

  it.each(['confirmed', 'rejected'])(
    '409 RESULT_LOCKED on a %s shoe',
    async (status) => {
      shoe!.status = status;
      expect(await codeOf(run())).toEqual([409, 'RESULT_LOCKED']);
      expect(identify).not.toHaveBeenCalled();
    },
  );

  it('409 NO_PHOTOS when the shoe has nothing stored', async () => {
    photos = [];
    expect(await codeOf(run())).toEqual([409, 'NO_PHOTOS']);
  });

  it('503 STORAGE_NOT_CONFIGURED without a bucket', async () => {
    configured = false;
    expect(await codeOf(run())).toEqual([503, 'STORAGE_NOT_CONFIGURED']);
  });

  it('503 INFERENCE_NOT_CONFIGURED when no ShoeDNA integration is enabled', async () => {
    getActive.mockResolvedValue(null);
    expect(await codeOf(run())).toEqual([503, 'INFERENCE_NOT_CONFIGURED']);
    expect(identify).not.toHaveBeenCalled();
  });

  it.each([
    [
      'model error',
      new InferenceFailedError('status 500'),
      [502, 'INFERENCE_FAILED'],
    ],
    ['timeout', new InferenceTimeoutError(25000), [504, 'INFERENCE_TIMEOUT']],
    [
      'credential lookup failure',
      new SecretUnavailableError('earthdna/be/x'),
      [503, 'INFERENCE_CREDENTIAL_UNAVAILABLE'],
    ],
  ])('%s → %j, and nothing is written', async (_label, err, expected) => {
    identify.mockRejectedValue(err);
    expect(await codeOf(run())).toEqual(expected);
    expect(writeResult).not.toHaveBeenCalled();
  });

  it('502 INFERENCE_FAILED for an unusable answer, nothing written', async () => {
    identify.mockResolvedValue({ brand: 42 });
    expect(await codeOf(run())).toEqual([502, 'INFERENCE_FAILED']);
    expect(writeResult).not.toHaveBeenCalled();
  });

  it('502 STORAGE_UNAVAILABLE when a photo cannot be signed', async () => {
    signedGetUrl.mockRejectedValue(new Error('s3 down'));
    expect(await codeOf(run())).toEqual([502, 'STORAGE_UNAVAILABLE']);
    expect(identify).not.toHaveBeenCalled();
  });
});
