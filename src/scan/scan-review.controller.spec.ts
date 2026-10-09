// Unit tests for the F3 HTTP layer: guard/filter wiring, throttle limits, and
// the two DTOs exactly as the global ValidationPipe applies them. Behaviour is
// covered by scan-review.service.it.spec.ts, the rules by review-rules.pbt.spec.ts.
import {
  GUARDS_METADATA,
  EXCEPTION_FILTERS_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RejectShoeDto, ShoeDetailsDto } from './dto/shoe-details.dto';
import { ScanHttpErrorFilter } from './scan-http-error.filter';
import { ScanReviewController } from './scan-review.controller';
import { ScanReviewService } from './scan-review.service';

const limitOf = (target: object) =>
  Reflect.getMetadata('THROTTLER:LIMITdefault', target) as number | undefined;

async function errorsFor(
  cls: new () => object,
  body: unknown,
): Promise<string[]> {
  const dto = plainToInstance(cls, body);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property).sort();
}

const UUID = '2b1b7e2e-7c1e-4c2e-9a0e-1a2b3c4d5e6f';

describe('ScanReviewController wiring', () => {
  it('requires the JWT guard and the scan error filter on the whole controller', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ScanReviewController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      ScanReviewController,
    ) as unknown[];
    expect(
      filters.some(
        (f) => f instanceof ScanHttpErrorFilter || f === ScanHttpErrorFilter,
      ),
    ).toBe(true);
  });

  it('throttles the controller at 30/min (reviews are rare, one tap each)', () => {
    expect(limitOf(ScanReviewController)).toBe(30);
  });

  it('delegates to the service with the caller id', async () => {
    const svc = {
      confirm: jest.fn().mockResolvedValue('C'),
      reject: jest.fn().mockResolvedValue('R'),
    };
    const ctrl = new ScanReviewController(svc as unknown as ScanReviewService);
    await expect(ctrl.confirm('u', 's', 'h', { gender: 'men' })).resolves.toBe(
      'C',
    );
    expect(svc.confirm).toHaveBeenCalledWith('u', 's', 'h', { gender: 'men' });
    const body = {
      brandId: UUID,
      model: 'm',
      color: 'c',
      sizeId: UUID,
    } as RejectShoeDto;
    await expect(ctrl.reject('u', 's', 'h', body)).resolves.toBe('R');
    expect(svc.reject).toHaveBeenCalledWith('u', 's', 'h', body);
  });
});

describe('ShoeDetailsDto (confirm)', () => {
  it('accepts an empty body and a full body', async () => {
    expect(await errorsFor(ShoeDetailsDto, {})).toEqual([]);
    expect(
      await errorsFor(ShoeDetailsDto, {
        brandId: UUID,
        model: 'Air Max',
        color: 'White',
        sizeId: UUID,
        gender: 'women',
      }),
    ).toEqual([]);
  });

  it('rejects bad ids, unknown gender, over-long text and unknown keys', async () => {
    expect(await errorsFor(ShoeDetailsDto, { brandId: 'nope' })).toEqual([
      'brandId',
    ]);
    expect(await errorsFor(ShoeDetailsDto, { gender: 'boys' })).toEqual([
      'gender',
    ]);
    expect(await errorsFor(ShoeDetailsDto, { model: 'x'.repeat(151) })).toEqual(
      ['model'],
    );
    expect(await errorsFor(ShoeDetailsDto, { color: 'x'.repeat(101) })).toEqual(
      ['color'],
    );
    expect(await errorsFor(ShoeDetailsDto, { category: 'running' })).toEqual([
      'category',
    ]);
    expect(await errorsFor(ShoeDetailsDto, { condition: 'C1' })).toEqual([
      'condition',
    ]);
  });
});

describe('RejectShoeDto (reject)', () => {
  it('requires brandId, model, color and sizeId; gender stays optional', async () => {
    expect(await errorsFor(RejectShoeDto, {})).toEqual([
      'brandId',
      'color',
      'model',
      'sizeId',
    ]);
    expect(
      await errorsFor(RejectShoeDto, {
        brandId: UUID,
        model: '',
        color: 'c',
        sizeId: UUID,
      }),
    ).toEqual(['model']);
    expect(
      await errorsFor(RejectShoeDto, {
        brandId: UUID,
        model: 'm',
        color: 'c',
        sizeId: UUID,
      }),
    ).toEqual([]);
    expect(
      await errorsFor(RejectShoeDto, {
        brandId: UUID,
        model: 'm',
        color: 'c',
        sizeId: UUID,
        gender: 'kids',
      }),
    ).toEqual([]);
  });
});
