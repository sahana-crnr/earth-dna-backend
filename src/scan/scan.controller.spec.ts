// Unit tests for the F1 HTTP layer: guard wiring, route param pipe, manifest
// parsing and multer error mapping. Service behaviour is covered by
// scan.service.it.spec.ts; pure rules by scan-rules.pbt.spec.ts.
import {
  BadRequestException,
  HttpStatus,
  PayloadTooLargeException,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiError } from '../common/errors/api-error';
import { parseManifest, ScanController } from './scan.controller';
import { ScanService } from './scan.service';
import { mapMulter } from './scan-http-error.filter';
import { ShoeViewPipe } from './shoe-view.pipe';

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: unknown) => (e instanceof ApiError ? e.code : 'OTHER'),
  );

describe('ScanController wiring', () => {
  it('JwtAuthGuard protects every route (class-level guard)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ScanController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });

  it('E20 DELETE /scans/:scanId answers 204 and delegates to deleteEmptyDraft', async () => {
    // Metadata lives on the unbound handler, which is what Nest reads too.
    const handler = Object.getOwnPropertyDescriptor(
      ScanController.prototype,
      'deleteScan',
    )!.value as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
    const status = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number;
    expect(path).toBe(':scanId');
    expect(method).toBe(RequestMethod.DELETE);
    expect(status).toBe(204);
    const svc = { deleteEmptyDraft: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new ScanController(svc as unknown as ScanService);
    await expect(ctrl.deleteScan('u', 's')).resolves.toBeUndefined();
    expect(svc.deleteEmptyDraft).toHaveBeenCalledWith('u', 's');
  });
});

describe('ShoeViewPipe', () => {
  const pipe = new ShoeViewPipe();
  it.each(['top', 'right', 'left', 'sole'])('accepts %s', (v) => {
    expect(pipe.transform(v)).toBe(v);
  });
  it.each(['front', 'TOP', '', 'top ', '../x'])(
    'rejects %p with INVALID_VIEW',
    (v) => {
      try {
        pipe.transform(v);
        fail('expected INVALID_VIEW');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).code).toBe('INVALID_VIEW');
        expect((e as ApiError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    },
  );
});

describe('parseManifest', () => {
  const ok = { shoes: [{ ref: 'a', files: [{ field: 'f1', view: 'top' }] }] };

  it('accepts a valid manifest', async () => {
    await expect(parseManifest(JSON.stringify(ok))).resolves.toMatchObject(ok);
  });

  it.each([
    ['not json', '{oops'],
    ['no shoes', JSON.stringify({ shoes: [] })],
    ['extra property', JSON.stringify({ ...ok, extra: 1 })],
    [
      'bad field name',
      JSON.stringify({
        shoes: [{ ref: 'a', files: [{ field: 'f 1', view: 'top' }] }],
      }),
    ],
    [
      'too many files per shoe',
      JSON.stringify({
        shoes: [
          {
            ref: 'a',
            files: Array.from({ length: 5 }, (_, i) => ({
              field: `f${i}`,
              view: 'top',
            })),
          },
        ],
      }),
    ],
    [
      'ref with markup',
      JSON.stringify({
        shoes: [{ ref: '<b>', files: [{ field: 'f1', view: 'top' }] }],
      }),
    ],
  ])('rejects %s with INVALID_MANIFEST', async (_name, raw) => {
    expect(await codeOf(parseManifest(raw))).toBe('INVALID_MANIFEST');
  });
});

describe('mapMulter', () => {
  it('maps multer size errors to FILE_TOO_LARGE (413)', () => {
    const out = mapMulter(
      new PayloadTooLargeException('File too large'),
    ) as ApiError;
    expect(out.code).toBe('FILE_TOO_LARGE');
    expect(out.getStatus()).toBe(413);
  });

  it.each([
    ['Unexpected field', 'UNEXPECTED_FILE_FIELD', 400],
    ['Unexpected file field - photo', 'UNEXPECTED_FILE_FIELD', 400],
    ['Too many files', 'BATCH_TOO_LARGE', 413],
    ['Field value too long', 'MANIFEST_TOO_LARGE', 413],
  ])('maps %p to %s', (msg, code, status) => {
    const out = mapMulter(new BadRequestException(msg)) as ApiError;
    expect(out.code).toBe(code);
    expect(out.getStatus()).toBe(status);
  });

  it('leaves validation errors and ApiErrors untouched', () => {
    const validation = new BadRequestException([
      'takenAt must be a valid ISO 8601 date string',
    ]);
    expect(mapMulter(validation)).toBe(validation);
    const api = new ApiError(409, 'NOT_DRAFT', 'x');
    expect(mapMulter(api)).toBe(api);
  });
});
