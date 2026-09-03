// DTO for endpoints that accept a refresh token in the request body
// (POST /auth/refresh, POST /auth/logout).
import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'The refresh token issued at login/register or last refresh',
    example: '3f9a...c2b1',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
