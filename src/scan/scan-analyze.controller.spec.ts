// Unit tests for the analyze HTTP layer: guard/filter wiring, the throttle,
// and the E10 status-line contract (201 create / 200 replace) on an unchanged
// SubmitResultView.
import {
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ScanAnalyzeController } from './scan-analyze.controller';
import type { ScanAnalyzeService } from './scan-analyze.service';
import { ScanHttpErrorFilter } from './scan-http-error.filter';
import type { SubmitResultView } from './scan-result.view';

describe('ScanAnalyzeController', () => {
  it('JwtAuthGuard and the scan error filter apply to the route', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ScanAnalyzeController),
    ).toContain(JwtAuthGuard);
    expect(
      Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, ScanAnalyzeController),
    ).toContain(ScanHttpErrorFilter);
  });

  it('is rate limited to 20/min under the "default" throttler', () => {
    const meta = (key: string) =>
      Reflect.getMetadata(
        key,
        Object.getOwnPropertyDescriptor(
          ScanAnalyzeController.prototype,
          'analyze',
        )!.value as object,
      ) as unknown;
    expect(meta('THROTTLER:LIMITdefault')).toBe(20);
    expect(meta('THROTTLER:TTLdefault')).toBe(60000);
  });

  it.each([
    [false, 201],
    [true, 200],
  ])(
    'replaced=%s answers %i and returns the service view unchanged',
    async (replaced, status) => {
      const view = { shoeId: 'h1', replaced } as SubmitResultView;
      const analyze = jest.fn().mockResolvedValue(view);
      const controller = new ScanAnalyzeController({
        analyze,
      } as unknown as ScanAnalyzeService);
      const setStatus = jest.fn();
      const res = { status: setStatus } as unknown as Response;

      await expect(controller.analyze('u1', 's1', 'h1', res)).resolves.toBe(
        view,
      );
      expect(analyze).toHaveBeenCalledWith('u1', 's1', 'h1');
      expect(setStatus).toHaveBeenCalledWith(status);
    },
  );
});
