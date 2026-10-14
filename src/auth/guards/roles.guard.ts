// Role check for routes marked with @Roles(). Runs after JwtAuthGuard, which
// has already put { sub, ... } on req.user.
//
// The role is re-read from the users row, NOT taken from the JWT claim: access
// tokens live up to JWT_EXPIRES_IN (24h on dev), and AdminBootstrapService
// demotes an admin the moment ADMIN_EMAIL changes. Trusting the claim would
// leave a demoted admin in for the rest of the token's life. The cost is one
// primary-key lookup on low-traffic admin routes.
//
// A deleted account (findById 404) is answered as 403 too, so the guard never
// reveals whether the token's subject still exists.
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ApiError } from '../../common/errors/api-error';
import { UserService } from '../../user/user.service';
import type { UserRole } from '../../user/user-roles';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly users: UserService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const userId = ctx
      .switchToHttp()
      .getRequest<Request & { user?: { sub?: string } }>().user?.sub;
    const role = userId ? await this.currentRole(userId) : null;

    if (!role || !required.includes(role)) {
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        'FORBIDDEN_ROLE',
        'You do not have permission to access this resource',
      );
    }
    return true;
  }

  private async currentRole(userId: string): Promise<UserRole | null> {
    try {
      return (await this.users.findById(userId)).role;
    } catch (err) {
      // Only "no such user" becomes a 403; a DB outage stays a 500.
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }
}
