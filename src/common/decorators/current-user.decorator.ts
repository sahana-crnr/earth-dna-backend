// Custom parameter decorator to extract the current user from the request.
// Requires JwtAuthGuard to have run first (attaches decoded JWT payload to req.user).
// Usage:
//   @CurrentUser()        → full payload { sub, email }
//   @CurrentUser('sub')   → user id string
//   @CurrentUser('email') → user email string
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return data ? request.user?.[data] : request.user;
  },
);
