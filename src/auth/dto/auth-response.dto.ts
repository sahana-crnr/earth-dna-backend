// Response DTO for auth endpoints (register, login).
// Uses a class instead of an interface so Swagger can introspect and document
// the response schema automatically.
import { ApiProperty } from '@nestjs/swagger';
import { UserEntity } from '../../user/entities/user.entity';

export class AuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({
    example: '3f9a...c2b1',
    description: 'Opaque refresh token; send to POST /auth/refresh to renew',
  })
  refreshToken: string;

  @ApiProperty({ type: () => UserEntity })
  user: UserEntity;
}
