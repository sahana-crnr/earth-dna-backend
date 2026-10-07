// Routes the app has not adopted yet answer 404 ENDPOINT_MUTED when listed in
// CATALOG_MUTED_ENDPOINTS (F3-D7, D17). A guard rather than conditional
// registration so Swagger still documents the route and un-muting is a config
// change with no restart logic.
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/errors/api-error';
import type {
  CatalogConfig,
  MutableCatalogEndpoint,
} from '../config/catalog.config';

export const CATALOG_ENDPOINT_KEY = 'catalog:endpoint';
export const CatalogEndpoint = (name: MutableCatalogEndpoint) =>
  SetMetadata(CATALOG_ENDPOINT_KEY, name);

@Injectable()
export class CatalogMuteGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const name = this.reflector.get<MutableCatalogEndpoint | undefined>(
      CATALOG_ENDPOINT_KEY,
      ctx.getHandler(),
    );
    if (!name) return true;
    const muted =
      this.config.get<CatalogConfig>('catalog')?.mutedEndpoints ?? [];
    if (muted.includes(name)) {
      throw new ApiError(
        HttpStatus.NOT_FOUND,
        'ENDPOINT_MUTED',
        `catalog/${name} is not enabled on this environment`,
      );
    }
    return true;
  }
}
