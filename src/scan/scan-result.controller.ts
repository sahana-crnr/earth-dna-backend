// F2 identification-result endpoints (Backend API Plan §4, E10–E11). A second
// controller on the same 'scans' path so F1's routes stay untouched and F2 gets
// its own Swagger group. Every route requires the EarthDNA JWT; the service
// scopes every query to the caller.
import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { SubmitShoeResultDto } from './dto/submit-shoe-result.dto';
import { ScanHttpErrorFilter } from './scan-http-error.filter';
import { ScanResultService } from './scan-result.service';
import type { ScanResultsView, SubmitResultView } from './scan-result.view';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('Scan results (F2)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 404,
  description:
    'SCAN_NOT_FOUND / SHOE_NOT_FOUND (also for ids owned by someone else)',
})
@UseGuards(JwtAuthGuard)
@UseFilters(ScanHttpErrorFilter)
@Controller('scans')
export class ScanResultController {
  constructor(private readonly results: ScanResultService) {}

  @Post(':scanId/shoes/:shoeId/result')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'E10 — submit the on-device ShoeDNA result for one shoe',
  })
  @ApiResponse({
    status: 201,
    description: 'First result for this shoe (replaced: false)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Result replaced (replaced: true). Re-submitting the same payload is safe.',
  })
  @ApiResponse({
    status: 400,
    description:
      'RESULT_INCOMPLETE / TOO_MANY_CANDIDATES / DUPLICATE_CANDIDATE / CONFIDENCE_OUT_OF_RANGE / RAW_TOO_DEEP',
  })
  @ApiResponse({
    status: 409,
    description:
      'NOT_PROCESSING (call /finish first) / RESULT_LOCKED (shoe already confirmed or rejected)',
  })
  @ApiResponse({ status: 413, description: 'RAW_TOO_LARGE' })
  async submit(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Body() dto: SubmitShoeResultDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitResultView> {
    const view = await this.results.submit(userId, scanId, shoeId, dto);
    // passthrough (unlike the bare @Res() in auth.controller.ts) KEEPS the
    // ResponseInterceptor envelope — only the status line changes, so a first
    // submit reads as a create and a retry as an idempotent replace.
    if (!view.replaced) res.status(HttpStatus.CREATED);
    return view;
  }

  @Get(':scanId/results')
  // The "Scan processing" screen polls this until allResolved, so the limit is
  // well above the global default rather than below it.
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({
    summary:
      'E11 — per-shoe identification status and stored result (waiting / analyzing / identified / failed)',
  })
  getResults(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
  ): Promise<ScanResultsView> {
    return this.results.results(userId, scanId);
  }
}
