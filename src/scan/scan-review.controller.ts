// F3 review endpoints E12 / E13 on the same 'scans' path as F1 and F2, in their
// own Swagger group. Both answer 201 with the full results view (F3-D11) so the
// app needs no second call to redraw "N of M reviewed".
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RejectShoeDto, ShoeDetailsDto } from './dto/shoe-details.dto';
import { ScanHttpErrorFilter } from './scan-http-error.filter';
import { ScanReviewService } from './scan-review.service';
import type { ScanResultsView } from './scan-result.view';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('Scan review (F3)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 404,
  description:
    'SCAN_NOT_FOUND / SHOE_NOT_FOUND (also for ids owned by someone else)',
})
@ApiResponse({
  status: 409,
  description: 'NOT_IN_REVIEW / ALREADY_REVIEWED / NO_RESULT',
})
@UseGuards(JwtAuthGuard)
@UseFilters(ScanHttpErrorFilter)
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('scans')
export class ScanReviewController {
  constructor(private readonly reviews: ScanReviewService) {}

  @Post(':scanId/shoes/:shoeId/confirm')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'E12 — "That\'s my shoe": confirm the prediction, optionally add details',
    description:
      'Creates the My Shoes entry from the ShoeDNA result overlaid with any of brandId, model, color, sizeId, gender sent in the body. Writes the training feedback row. Returns the full results view.',
  })
  @ApiResponse({ status: 201, description: 'Results view with the new myShoe' })
  @ApiResponse({
    status: 400,
    description: 'BRAND_REQUIRED / UNKNOWN_BRAND / UNKNOWN_SIZE',
  })
  confirm(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Body() dto: ShoeDetailsDto,
  ): Promise<ScanResultsView> {
    return this.reviews.confirm(userId, scanId, shoeId, dto);
  }

  @Post(':scanId/shoes/:shoeId/reject')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'E13 — "Not my shoe": reject the prediction with the user\'s answer',
    description:
      'brandId, model, color and sizeId are required; gender optional. Creates the My Shoes entry from the answer, keeps the prediction as training feedback. Returns the full results view.',
  })
  @ApiResponse({ status: 201, description: 'Results view with the new myShoe' })
  @ApiResponse({
    status: 400,
    description: 'validation / UNKNOWN_BRAND / UNKNOWN_SIZE',
  })
  reject(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Body() dto: RejectShoeDto,
  ): Promise<ScanResultsView> {
    return this.reviews.reject(userId, scanId, shoeId, dto);
  }
}
