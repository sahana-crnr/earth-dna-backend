// Unit tests for the F2 HTTP layer: guard/filter wiring, the per-route throttle
// limits, and the DTO as the global ValidationPipe will apply it. Service
// behaviour is covered by scan-result.service.it.spec.ts, the pure rules by
// result-rules.pbt.spec.ts.
import {
  GUARDS_METADATA,
  EXCEPTION_FILTERS_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SubmitShoeResultDto } from './dto/submit-shoe-result.dto';
import { ScanHttpErrorFilter } from './scan-http-error.filter';
import { ScanResultController } from './scan-result.controller';

// Key names come from @nestjs/throttler's internals. Asserting them directly is
// the only way to catch the failure mode CLAUDE.md warns about: if the throttler
// name stops matching 'default', @Throttle resolves nothing and the route
// silently falls back to the generous global limit.
const limitOf = (method: keyof ScanResultController) =>
  Reflect.getMetadata(
    'THROTTLER:LIMITdefault',
    ScanResultController.prototype[method],
  ) as number | undefined;
const ttlOf = (method: keyof ScanResultController) =>
  Reflect.getMetadata(
    'THROTTLER:TTLdefault',
    ScanResultController.prototype[method],
  ) as number | undefined;

/** Validates a body exactly as the global ValidationPipe does. */
async function errorsFor(body: unknown): Promise<string[]> {
  const dto = plainToInstance(SubmitShoeResultDto, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

const VALID = {
  modelVersion: 'shoedna-tflite-1.4.2',
  brand: 'Nike',
  confidence: 0.9234,
  conditionCode: 'C2',
  candidates: [
    { brand: 'Nike', model: 'Air Max 90', confidence: 0.9234 },
    { brand: 'Adidas', confidence: 0.0256 },
  ],
  raw: { embeddingVersion: 'v3' },
};

describe('ScanResultController wiring', () => {
  it('JwtAuthGuard protects every route (class-level guard)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ScanResultController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('uses the scan error filter so Multer/ApiError codes stay stable', () => {
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      ScanResultController,
    ) as unknown[];
    expect(filters).toContain(ScanHttpErrorFilter);
  });

  it('submit is rate limited per minute', () => {
    expect(limitOf('submit')).toBe(30);
    expect(ttlOf('submit')).toBe(60000);
  });

  it('getResults allows polling: a limit well above the global default of 100', () => {
    expect(limitOf('getResults')).toBe(120);
    expect(ttlOf('getResults')).toBe(60000);
  });
});

describe('SubmitShoeResultDto', () => {
  it('accepts a full on-device result', async () => {
    expect(await errorsFor(VALID)).toEqual([]);
  });

  it('accepts the minimum: a failed result needs only a model version', async () => {
    expect(
      await errorsFor({
        modelVersion: 'shoedna-tflite-1.4.2',
        outcome: 'failed',
      }),
    ).toEqual([]);
  });

  it('rejects unknown properties, so a typo is never silently dropped', async () => {
    expect(await errorsFor({ ...VALID, sourceOverride: 'server' })).toEqual([
      'sourceOverride',
    ]);
  });

  it('never lets a client set `source` — it is recorded server-side', async () => {
    expect(await errorsFor({ ...VALID, source: 'server' })).toEqual(['source']);
  });

  it('never lets a client set `submittedAt` — it is stamped server-side', async () => {
    expect(
      await errorsFor({ ...VALID, submittedAt: '2026-10-05T10:15:00.000Z' }),
    ).toEqual(['submittedAt']);
  });

  it('requires a model version', async () => {
    expect(await errorsFor({ brand: 'Nike', confidence: 0.5 })).toContain(
      'modelVersion',
    );
  });

  it.each([
    ['confidence above 1', { confidence: 1.5 }, 'confidence'],
    ['confidence below 0', { confidence: -0.1 }, 'confidence'],
    ['an unknown condition code', { conditionCode: 'C9' }, 'conditionCode'],
    ['an unknown outcome', { outcome: 'maybe' }, 'outcome'],
    ['a non-object raw', { raw: 'just a string' }, 'raw'],
  ])('rejects %s', async (_label, patch, property) => {
    expect(await errorsFor({ ...VALID, ...patch })).toContain(property);
  });

  it.each([
    ['spaces', 'shoedna 1.4.2'],
    ['a newline', 'shoedna\n1.4.2'],
    ['an empty string', ''],
  ])('rejects a model version containing %s', async (_label, modelVersion) => {
    expect(await errorsFor({ ...VALID, modelVersion })).toContain(
      'modelVersion',
    );
  });

  it('validates nested candidates', async () => {
    expect(
      await errorsFor({ ...VALID, candidates: [{ confidence: 0.5 }] }),
    ).toContain('candidates');
    expect(
      await errorsFor({ ...VALID, candidates: [{ brand: 'Nike' }] }),
    ).toContain('candidates');
  });

  it('caps candidates well above the configurable limit, which the service enforces', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      brand: `B${i}`,
      confidence: 0.5,
    }));
    expect(await errorsFor({ ...VALID, candidates: eleven })).toContain(
      'candidates',
    );
  });

  it('does not recurse into raw: unknown ShoeDNA fields pass through', async () => {
    expect(
      await errorsFor({
        ...VALID,
        raw: { anything: { at: ['all', 1, true, null] } },
      }),
    ).toEqual([]);
  });
});
