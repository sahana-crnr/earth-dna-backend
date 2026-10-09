// Unit tests for the catalog HTTP layer: guards, throttle, the mute guard and
// the query DTOs as the global ValidationPipe applies them.
import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiError } from '../common/errors/api-error';
import { CatalogController } from './catalog.controller';
import { CatalogMuteGuard } from './catalog-mute.guard';
import { CatalogService } from './catalog.service';
import {
  BrandsQueryDto,
  ColoursQueryDto,
  ModelsQueryDto,
  SizesQueryDto,
} from './dto/catalog-query.dto';

const UUID = '2b1b7e2e-7c1e-4c2e-9a0e-1a2b3c4d5e6f';

async function errorsFor(cls: new () => object, q: unknown): Promise<string[]> {
  const dto = plainToInstance(cls, q);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property).sort();
}

/** The guard only reads metadata off the handler, so an unbound reference is
 *  exactly what Nest hands it; the lookup by name keeps eslint's
 *  unbound-method rule out of it. */
function ctxFor(method: keyof CatalogController): ExecutionContext {
  const handler = Object.getOwnPropertyDescriptor(
    CatalogController.prototype,
    method,
  )!.value as (...args: unknown[]) => unknown;
  return {
    getHandler: () => handler,
    getClass: () => CatalogController,
  } as unknown as ExecutionContext;
}

describe('CatalogController wiring', () => {
  it('uses the JWT guard and the mute guard; throttled at 120/min', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      CatalogController,
    ) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, CatalogMuteGuard]);
    expect(
      Reflect.getMetadata('THROTTLER:LIMITdefault', CatalogController),
    ).toBe(120);
  });

  it('delegates each route to the service', async () => {
    const svc = {
      listBrands: jest.fn().mockResolvedValue('b'),
      listSizes: jest.fn().mockResolvedValue('s'),
      listCategories: jest.fn().mockResolvedValue('c'),
      listModels: jest.fn().mockResolvedValue('m'),
      listColours: jest.fn().mockResolvedValue('k'),
      options: jest.fn().mockReturnValue('o'),
    };
    const ctrl = new CatalogController(svc as unknown as CatalogService);
    await expect(ctrl.brands({ q: 'ni' })).resolves.toBe('b');
    expect(svc.listBrands).toHaveBeenCalledWith('ni');
    await expect(ctrl.sizes({ brandId: UUID })).resolves.toBe('s');
    await expect(ctrl.categories()).resolves.toBe('c');
    await expect(ctrl.models({ brandId: UUID, q: 'air' })).resolves.toBe('m');
    expect(svc.listModels).toHaveBeenCalledWith(UUID, 'air');
    await expect(
      ctrl.colours({ brandId: UUID, model: 'Air Max' }),
    ).resolves.toBe('k');
    expect(ctrl.options()).toBe('o');
  });
});

describe('CatalogMuteGuard', () => {
  const guardWith = (muted: string[]) =>
    new CatalogMuteGuard(new Reflector(), {
      get: () => ({ mutedEndpoints: muted, listMax: 500, source: null }),
    } as unknown as ConfigService);

  it('lets unmarked routes and unmuted routes through', () => {
    const g = guardWith(['models']);
    expect(g.canActivate(ctxFor('brands'))).toBe(true);
    expect(g.canActivate(ctxFor('colours'))).toBe(true);
  });

  it('answers 404 ENDPOINT_MUTED for a muted route', () => {
    const g = guardWith(['models', 'categories']);
    for (const h of ['models', 'categories'] as const) {
      try {
        g.canActivate(ctxFor(h));
        throw new Error('expected ENDPOINT_MUTED');
      } catch (e) {
        expect((e as ApiError).code).toBe('ENDPOINT_MUTED');
        expect((e as ApiError).getStatus()).toBe(404);
      }
    }
  });
});

describe('catalog query DTOs', () => {
  it('brands: optional q up to 50 chars, no extra keys', async () => {
    expect(await errorsFor(BrandsQueryDto, {})).toEqual([]);
    expect(await errorsFor(BrandsQueryDto, { q: 'x'.repeat(51) })).toEqual([
      'q',
    ]);
    expect(await errorsFor(BrandsQueryDto, { page: 1 })).toEqual(['page']);
  });

  it('sizes: optional uuid brandId', async () => {
    expect(await errorsFor(SizesQueryDto, {})).toEqual([]);
    expect(await errorsFor(SizesQueryDto, { brandId: 'nope' })).toEqual([
      'brandId',
    ]);
  });

  it('models / colours: brandId required', async () => {
    expect(await errorsFor(ModelsQueryDto, {})).toEqual(['brandId']);
    expect(await errorsFor(ModelsQueryDto, { brandId: UUID, q: 'a' })).toEqual(
      [],
    );
    expect(
      await errorsFor(ColoursQueryDto, {
        brandId: UUID,
        model: 'x'.repeat(201),
      }),
    ).toEqual(['model']);
  });
});
