// @Roles('ADMIN') marks a handler or controller as restricted to the listed
// roles. Read by RolesGuard, which must run after JwtAuthGuard:
//   @UseGuards(JwtAuthGuard, RolesGuard) @Roles('ADMIN')
import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../user/user-roles';

export const ROLES_KEY = 'auth:roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
