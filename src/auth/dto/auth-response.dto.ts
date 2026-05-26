// Response DTO for auth endpoints (register, login).
// Uses a class instead of an interface so Swagger can introspect and document
// the response schema automatically.
import { ApiProperty } from '@nestjs/swagger';
import { UserEntity } from '../../user/entities/user.entity';

export class AuthResponseDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ type: () => UserEntity })
  user: UserEntity;
}
