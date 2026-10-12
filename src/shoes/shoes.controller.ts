// F4 + F6 My Shoes endpoints (Backend API Plan §4): E20 list with the Filters
// sheet, E21 summary for the Home stats card and the My Shoes header. JWT on
// every route; the service scopes every query to the caller. No storage
// guard: without a bucket the cards simply carry `thumbnailUrl: null`.
//
// Route order matters: `summary` is declared before any `:shoeId` route F5
// adds, or Express would match "summary" as a shoe id.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ListShoesQueryDto } from './dto/list-shoes-query.dto';
import { ShoesService } from './shoes.service';
import type { ShoeListView, ShoeSummaryView } from './shoes.view';

@ApiTags('My Shoes (F4 + F6)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@UseGuards(JwtAuthGuard)
@Controller('shoes')
export class ShoesController {
  constructor(private readonly shoes: ShoesService) {}

  @Get()
  @ApiOperation({
    summary:
      'E20 — list my shoes (newest first), filtered by the Filters sheet; OR within a filter, AND across filters',
  })
  @ApiResponse({
    status: 400,
    description: 'Unknown filter value, unknown query parameter, bad paging',
  })
  list(
    @CurrentUser('sub') userId: string,
    @Query() q: ListShoesQueryDto,
  ): Promise<ShoeListView> {
    return this.shoes.list(userId, q);
  }

  @Get('summary')
  @ApiOperation({
    summary:
      'E21 — pairs, potential resale value and CO2e; a total is null when no shoe carries the value',
  })
  summary(@CurrentUser('sub') userId: string): Promise<ShoeSummaryView> {
    return this.shoes.summary(userId);
  }
}
