// Unit tests for the F5 HTTP layer: guard / filter wiring, throttle limits,
// status codes for the create-or-return routes, the DTOs exactly as the global
// ValidationPipe applies them, and the API-base helper. Behaviour is covered
// by shoes.service.it.spec.ts, the rules by the two pbt specs.
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ScanHttpErrorFilter } from '../scan/scan-http-error.filter';
import { ConditionFeedbackDto } from './dto/condition-feedback.dto';
import { UpdateShoeDto } from './dto/update-shoe.dto';
import { ShoesController, apiBaseOf } from './shoes.controller';
import { ShoesService } from './shoes.service';

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

function fakeReq(originalUrl: string, host = 'api.test', proto = 'http') {
  return {
    originalUrl,
    url: originalUrl,
    protocol: proto,
    get: (h: string) => (h.toLowerCase() === 'host' ? host : undefined),
  } as unknown as Request;
}

describe('ShoesController wiring', () => {
  it('requires the JWT guard and the scan error filter on the whole controller', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ShoesController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
    const filters = Reflect.getMetadata(
      EXCEPTION_FILTERS_METADATA,
      ShoesController,
    ) as unknown[];
    expect(
      filters.some(
        (f) => f instanceof ScanHttpErrorFilter || f === ScanHttpErrorFilter,
      ),
    ).toBe(true);
  });

  it('throttles: 60/min on the controller, 30/min on share, upload, rescan and condition feedback', () => {
    expect(limitOf(ShoesController)).toBe(60);
    const p = ShoesController.prototype as unknown as Record<string, object>;
    for (const h of ['share', 'uploadPhoto', 'rescan', 'suggestCondition']) {
      expect(limitOf(p[h])).toBe(30);
    }
  });

  it('share answers 201 on create and 200 when a link already existed', async () => {
    const link = { url: 'u', token: 't', createdAt: 'c' };
    const svc = {
      shareBase: (b: string) => b,
      createShare: jest
        .fn()
        .mockResolvedValueOnce({ created: true, link })
        .mockResolvedValueOnce({ created: false, link }),
    } as unknown as ShoesService;
    const ctrl = new ShoesController(svc);
    const status = jest.fn<void, [number]>();
    const res = { status } as unknown as Response;
    await expect(
      ctrl.share('u', UUID, fakeReq(`/api/v1/shoes/${UUID}/share`), res),
    ).resolves.toBe(link);
    expect(status).toHaveBeenNthCalledWith(1, 201);
    await ctrl.share('u', UUID, fakeReq(`/api/v1/shoes/${UUID}/share`), res);
    expect(status).toHaveBeenNthCalledWith(2, 200);
  });

  it('rescan answers 201 on a new draft and 200 when one is open', async () => {
    const svc = {
      rescan: jest
        .fn()
        .mockResolvedValueOnce({ created: true })
        .mockResolvedValueOnce({ created: false }),
    } as unknown as ShoesService;
    const ctrl = new ShoesController(svc);
    const status = jest.fn<void, [number]>();
    const res = { status } as unknown as Response;
    await ctrl.rescan('u', UUID, res);
    await ctrl.rescan('u', UUID, res);
    expect(status).toHaveBeenNthCalledWith(1, 201);
    expect(status).toHaveBeenNthCalledWith(2, 200);
  });
});

describe('apiBaseOf', () => {
  it('keeps the global prefix and host, cuts at the marker', () => {
    expect(apiBaseOf(fakeReq(`/api/v1/shoes/${UUID}`), '/shoes')).toBe(
      'http://api.test/api/v1',
    );
    expect(apiBaseOf(fakeReq('/api/v1/s/cloud-2-abc'), '/s/')).toBe(
      'http://api.test/api/v1',
    );
  });

  it('honours x-forwarded-proto behind the ALB', () => {
    const req = {
      originalUrl: '/api/v1/shoes/x',
      protocol: 'http',
      get: (h: string) =>
        h === 'x-forwarded-proto'
          ? 'https, http'
          : h === 'host'
            ? 'h'
            : undefined,
    } as unknown as Request;
    expect(apiBaseOf(req, '/shoes')).toBe('https://h/api/v1');
  });
});

describe('UpdateShoeDto', () => {
  it('accepts an empty body (EMPTY_UPDATE is the service’s call) and every valid field', async () => {
    expect(await errorsFor(UpdateShoeDto, {})).toEqual([]);
    expect(
      await errorsFor(UpdateShoeDto, {
        brandId: UUID,
        model: ' Cloudmonster 2 ',
        color: 'Black',
        sizeId: UUID,
        shoeTypeId: UUID,
        gender: 'men',
        actionTaken: 'resold',
        primaryPhotoId: UUID,
      }),
    ).toEqual([]);
  });

  it('allows null to clear model, color, size, shoe type and gender', async () => {
    expect(
      await errorsFor(UpdateShoeDto, {
        model: null,
        color: null,
        sizeId: null,
        shoeTypeId: null,
        gender: null,
      }),
    ).toEqual([]);
    const dto = plainToInstance(UpdateShoeDto, { model: '  x  ' });
    expect(dto.model).toBe('x');
  });

  it('rejects bad ids, enums, lengths and unknown keys', async () => {
    expect(
      await errorsFor(UpdateShoeDto, {
        brandId: 'nope',
        sizeId: 12,
        shoeTypeId: 'x',
        gender: 'other',
        actionTaken: 'sold',
        primaryPhotoId: null,
        model: 'a'.repeat(151),
        color: 'b'.repeat(101),
        conditionCode: 'C1',
      }),
    ).toEqual([
      'actionTaken',
      'brandId',
      'color',
      'conditionCode',
      'gender',
      'model',
      'primaryPhotoId',
      'shoeTypeId',
      'sizeId',
    ]);
  });
});

describe('ConditionFeedbackDto', () => {
  it('needs a C1–C5 code and a 1–500 char reason', async () => {
    expect(
      await errorsFor(ConditionFeedbackDto, {
        suggestedConditionCode: 'C3',
        reason: ' heel worn ',
      }),
    ).toEqual([]);
    expect(await errorsFor(ConditionFeedbackDto, {})).toEqual([
      'reason',
      'suggestedConditionCode',
    ]);
    expect(
      await errorsFor(ConditionFeedbackDto, {
        suggestedConditionCode: 'A',
        reason: '   ',
      }),
    ).toEqual(['reason', 'suggestedConditionCode']);
    expect(
      await errorsFor(ConditionFeedbackDto, {
        suggestedConditionCode: 'C1',
        reason: 'x'.repeat(501),
      }),
    ).toEqual(['reason']);
  });
});
