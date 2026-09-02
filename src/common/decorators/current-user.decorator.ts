// Custom parameter decorator to extract the current user from the request.
// Requires JwtAuthGuard to have run first (attaches decoded JWT payload to req.user).
// Usage:
//   @CurrentUser()        → full payload { sub, email }
//   @CurrentUser('sub')   → user id string
//   @CurrentUser('email') → user email string
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

interface JwtPayload {
  sub: string;
  email: string;
  [key: string]: unknown;
}

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: JwtPayload }>();
    return data ? request.user?.[data] : request.user;
  },
);
