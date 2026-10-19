// F7 admin routes: GET /admin/integrations and PUT /admin/integrations/{name}.
// No screen in the app - these are for the admin only, so the whole controller
// is @Roles('ADMIN'). RolesGuard must come after JwtAuthGuard in UseGuards: it
// reads req.user.sub, which JwtAuthGuard sets.
//
// PUT is throttled at 20/min: one admin editing by hand never gets near it,
// and a leaked admin token cannot flap the model endpoint in a loop.
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateIntegrationDto } from './dto/update-integration.dto';
import { INTEGRATION_NAMES } from './integration.types';
import { IntegrationsService } from './integrations.service';
import type { IntegrationListView, IntegrationView } from './integration.view';

@ApiTags('Admin — Integrations (F7)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 403,
  description: 'FORBIDDEN_ROLE — the caller is not an admin',
})
@ApiResponse({ status: 429, description: 'Too many requests' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('admin/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Current ShoeDNA / ValueLens endpoint, version and enabled flag',
  })
  list(): Promise<IntegrationListView> {
    return this.integrations.list();
  }

  @Put(':name')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Update endpoint / version / auth reference / enabled (partial: absent keeps, null clears)',
  })
  @ApiParam({ name: 'name', enum: INTEGRATION_NAMES })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (non-https URL, unknown field, …)',
  })
  @ApiResponse({
    status: 404,
    description: 'INTEGRATION_NOT_FOUND — unknown integration name',
  })
  @ApiResponse({
    status: 409,
    description: 'INTEGRATION_INCOMPLETE — enabled without a baseUrl',
  })
  update(
    @Param('name') name: string,
    @Body() dto: UpdateIntegrationDto,
    @CurrentUser('sub') adminId: string,
  ): Promise<IntegrationView> {
    return this.integrations.update(name, dto, adminId);
  }
}
