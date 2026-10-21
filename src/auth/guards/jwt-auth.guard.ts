// JWT authentication guard. Validates the Bearer token from the Authorization
// header using JwtService. Attaches the decoded payload to req.user on success.
// Throws UnauthorizedException if the token is missing, invalid, expired, or
// was issued before the user's last password reset (one primary-key lookup per
// request, so a reset signs out every device, not only refresh tokens).
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import type { UserRole } from '../../user/user-roles';
import { UserService } from '../../user/user.service';

interface JwtPayload {
  sub: string;
  email: string;
  /** Absent on tokens issued before F7. Informational - see RolesGuard. */
  role?: UserRole;
  /** Issued-at, seconds since epoch (set by JwtService.sign). */
  iat?: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly users: UserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    // Seconds, like iat: a token signed in the same second as the reset (the
    // login right after it) is still accepted.
    const changedAt = await this.users.getPasswordChangedAt(payload.sub);
    if (
      changedAt &&
      (payload.iat ?? 0) < Math.floor(changedAt.getTime() / 1000)
    ) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    (request as Request & { user: JwtPayload }).user = payload;
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers['authorization']?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
