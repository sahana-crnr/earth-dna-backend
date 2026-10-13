// F4 + F6 My Shoes endpoints (Backend API Plan §4): E31 list with the Filters
// sheet, E32 summary for the My Shoes header. Numbered after F5's E21–E30 so
// the team docs have one sequence. JWT on
// every route; the service scopes every query to the caller. No storage
// guard: without a bucket the cards simply carry `thumbnailUrl: null`.
//
// Route order matters: this controller is registered before ShoesController
// (F5 `:shoeId` routes), or Express would match "summary" as a shoe id.
//
// Class-level 60/min throttle: the list signs up to 100 URLs per call, so the
// global default is too loose; 60/min matches the F5 owner routes on /shoes.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ListShoesQueryDto } from './dto/list-shoes-query.dto';
import { ShoesListService } from './shoes-list.service';
import type { ShoeListView, ShoeSummaryView } from './shoes.view';

@ApiTags('My Shoes (F4 + F6)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({ status: 429, description: 'Too many requests' })
@Throttle({ default: { limit: 60, ttl: 60000 } })
@UseGuards(JwtAuthGuard)
@Controller('shoes')
export class ShoesListController {
  constructor(private readonly shoes: ShoesListService) {}

  @Get()
  @ApiOperation({
    summary:
      'E31 — list my shoes (newest first), filtered by the Filters sheet; OR within a filter, AND across filters',
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
      'E32 — pairs and potential resale value; the value is null when no shoe carries one',
  })
  summary(@CurrentUser('sub') userId: string): Promise<ShoeSummaryView> {
    return this.shoes.summary(userId);
  }
}
