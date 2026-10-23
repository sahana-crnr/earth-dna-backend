// Server-side ShoeDNA fallback route (E10b), replacing the Boston cloud path.
// Its own controller on the shared 'scans' path so the F2 submit/results
// controller stays untouched; grouped with F2 in Swagger because the response
// is the E10 response — same SubmitResultView, same 201-create / 200-replace
// status split — so the app parses both with one model.
import {
  Controller,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ScanAnalyzeService } from './scan-analyze.service';
import { ScanHttpErrorFilter } from './scan-http-error.filter';
import type { SubmitResultView } from './scan-result.view';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('Scan results (F2)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@UseGuards(JwtAuthGuard)
@UseFilters(ScanHttpErrorFilter)
@Controller('scans')
export class ScanAnalyzeController {
  constructor(private readonly analyzer: ScanAnalyzeService) {}

  @Post(':scanId/shoes/:shoeId/analyze')
  // Each call is a model inference, so tighter than E10's 30/min.
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary:
      'E10b — run ShoeDNA server-side on the stored photos (on-device fallback)',
    description:
      'For when the on-device model fails: only for a shoe with no result yet or a failed one. Runs ShoeDNA on the photos already uploaded for this shoe, stores the result with source "server", and returns exactly the E10 response. Synchronous; a failed or timed-out call stores nothing, so it is safe to retry.',
  })
  @ApiResponse({
    status: 201,
    description: 'First result for this shoe (replaced: false)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Replaced an earlier result, e.g. a device "failed" (replaced: true)',
  })
  @ApiResponse({
    status: 404,
    description:
      'SCAN_NOT_FOUND / SHOE_NOT_FOUND (also for ids owned by someone else)',
  })
  @ApiResponse({
    status: 409,
    description:
      'NOT_PROCESSING (call /finish first) / RESULT_LOCKED (shoe already confirmed or rejected) / ALREADY_IDENTIFIED (shoe already has an identified result; analyze is only the fallback) / NO_PHOTOS',
  })
  @ApiResponse({
    status: 502,
    description:
      'INFERENCE_FAILED (ShoeDNA error or unusable answer) / STORAGE_UNAVAILABLE',
  })
  @ApiResponse({
    status: 503,
    description:
      'INFERENCE_NOT_CONFIGURED (no enabled ShoeDNA integration) / INFERENCE_CREDENTIAL_UNAVAILABLE / STORAGE_NOT_CONFIGURED',
  })
  @ApiResponse({ status: 504, description: 'INFERENCE_TIMEOUT' })
  async analyze(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitResultView> {
    const view = await this.analyzer.analyze(userId, scanId, shoeId);
    // Same status line as E10 (see ScanResultController.submit).
    res.status(view.replaced ? HttpStatus.OK : HttpStatus.CREATED);
    return view;
  }
}
