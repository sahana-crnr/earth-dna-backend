// F3 catalog endpoints E14–E19: the dropdown sources for the review form.
// JWT-protected like every scan route (Q14-A); read-only; per-route throttle
// above the global default because a form opens several lists at once.
import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CatalogEndpoint, CatalogMuteGuard } from './catalog-mute.guard';
import { CatalogService } from './catalog.service';
import {
  BrandsQueryDto,
  ColoursQueryDto,
  ModelsQueryDto,
  SizesQueryDto,
} from './dto/catalog-query.dto';

/** Catalog data changes only when the seed runs; the app may cache each list
 *  for five minutes (private: the responses sit behind a user token). */
const CACHE = 'private, max-age=300';

@ApiTags('Catalog (F3)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@UseGuards(JwtAuthGuard, CatalogMuteGuard)
@Throttle({ default: { limit: 120, ttl: 60000 } })
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('brands')
  @Header('Cache-Control', CACHE)
  @ApiOperation({ summary: 'E14 — brands, A→Z, optional ?q= prefix search' })
  brands(@Query() q: BrandsQueryDto) {
    return this.catalog.listBrands(q.q);
  }

  @Get('sizes')
  @Header('Cache-Control', CACHE)
  @ApiOperation({
    summary: 'E15 — US sizes for a brand (?brandId=), generic list otherwise',
  })
  sizes(@Query() q: SizesQueryDto) {
    return this.catalog.listSizes(q.brandId);
  }

  @Get('categories')
  @Header('Cache-Control', CACHE)
  @CatalogEndpoint('categories')
  @ApiOperation({
    summary:
      'E16 — shoe types (Athletic Shoes, Casual Shoes, Dress Shoes, Boots, Sandals, Slippers) with the product categories mapped under each',
    description:
      'The Shoe Type dropdown of Edit shoe details and Find Your Shoe (F5-D20). Un-muted since F5; CATALOG_MUTED_ENDPOINTS=categories switches it off again.',
  })
  @ApiResponse({ status: 404, description: 'ENDPOINT_MUTED' })
  categories() {
    return this.catalog.listShoeTypes();
  }

  @Get('models')
  @Header('Cache-Control', CACHE)
  @CatalogEndpoint('models')
  @ApiOperation({ summary: 'E17 — distinct models for a brand (?brandId=&q=)' })
  @ApiResponse({ status: 404, description: 'ENDPOINT_MUTED' })
  models(@Query() q: ModelsQueryDto) {
    return this.catalog.listModels(q.brandId, q.q);
  }

  @Get('colours')
  @Header('Cache-Control', CACHE)
  @CatalogEndpoint('colours')
  @ApiOperation({
    summary: 'E18 — distinct colours for a brand, optionally one model',
  })
  @ApiResponse({ status: 404, description: 'ENDPOINT_MUTED' })
  colours(@Query() q: ColoursQueryDto) {
    return this.catalog.listColours(q.brandId, q.model);
  }

  @Get('options')
  @Header('Cache-Control', CACHE)
  @CatalogEndpoint('options')
  @ApiOperation({ summary: 'E19 — static lists: genders' })
  @ApiResponse({ status: 404, description: 'ENDPOINT_MUTED' })
  options() {
    return this.catalog.options();
  }
}
