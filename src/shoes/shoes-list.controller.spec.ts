// Unit tests for the F4 + F6 HTTP layer: guard wiring, route order, delegation,
// and ListShoesQueryDto exactly as the global ValidationPipe applies it
// (implicit conversion on). Behaviour is covered by shoes.service.it.spec.ts.
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ListShoesQueryDto } from './dto/list-shoes-query.dto';
import { ShoesListController } from './shoes-list.controller';
import { ShoesListService } from './shoes-list.service';

function parse(q: Record<string, unknown>) {
  return plainToInstance(ListShoesQueryDto, q, {
    enableImplicitConversion: true,
  });
}

async function errorsFor(q: Record<string, unknown>): Promise<string[]> {
  const errors = await validate(parse(q), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property).sort();
}

describe('ShoesListController wiring', () => {
  it('requires the JWT guard on the whole controller', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ShoesListController,
    ) as unknown[];
    expect(guards).toEqual([JwtAuthGuard]);
  });

  it('serves /shoes and /shoes/summary', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ShoesListController)).toBe(
      'shoes',
    );
    const path = (m: keyof ShoesListController) =>
      Reflect.getMetadata(
        PATH_METADATA,
        Object.getOwnPropertyDescriptor(ShoesListController.prototype, m)!
          .value as object,
      ) as string;
    expect(path('list')).toBe('/');
    expect(path('summary')).toBe('summary');
  });

  it('delegates to the service with the caller id', async () => {
    const svc = {
      list: jest.fn().mockResolvedValue('l'),
      summary: jest.fn().mockResolvedValue('s'),
    };
    const ctrl = new ShoesListController(svc as unknown as ShoesListService);
    const q = parse({ condition: 'like_new' });
    await expect(ctrl.list('u1', q)).resolves.toBe('l');
    expect(svc.list).toHaveBeenCalledWith('u1', q);
    await expect(ctrl.summary('u1')).resolves.toBe('s');
    expect(svc.summary).toHaveBeenCalledWith('u1');
  });
});

describe('ListShoesQueryDto', () => {
  it('accepts an empty query', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  it('splits comma lists and merges repeated params', async () => {
    const q = parse({
      actionTaken: 'none,resold',
      condition: ['like_new', 'heavily_worn,not_wearable'],
      recommendedAction: 'resell',
      resaleBucket: ['over_100'],
      limit: '50',
      offset: '10',
    });
    expect(q.actionTaken).toEqual(['none', 'resold']);
    expect(q.condition).toEqual(['like_new', 'heavily_worn', 'not_wearable']);
    expect(q.recommendedAction).toEqual(['resell']);
    expect(q.resaleBucket).toEqual(['over_100']);
    expect(q.limit).toBe(50);
    expect(q.offset).toBe(10);
    expect(await errorsFor(q as unknown as Record<string, unknown>)).toEqual(
      [],
    );
  });

  it('rejects unknown filter values', async () => {
    expect(
      await errorsFor({
        actionTaken: 'sold',
        condition: 'great',
        recommendedAction: 'keep',
        resaleBucket: '20_to_25',
      }),
    ).toEqual([
      'actionTaken',
      'condition',
      'recommendedAction',
      'resaleBucket',
    ]);
  });

  it('rejects raw condition codes — the filter takes the card label', async () => {
    expect(await errorsFor({ condition: 'C1' })).toEqual(['condition']);
  });

  it('rejects an unknown property and bad paging', async () => {
    expect(await errorsFor({ brand: 'Nike' })).toEqual(['brand']);
    expect(await errorsFor({ limit: '0' })).toEqual(['limit']);
    expect(await errorsFor({ limit: '101' })).toEqual(['limit']);
    expect(await errorsFor({ offset: '-1' })).toEqual(['offset']);
  });
});
