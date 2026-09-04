// DTO for POST /auth/facebook.
//
// One field. Its shape differs per platform (iOS sends a Limited Login JWT,
// Android a classic opaque access token) and FacebookTokenVerifier picks the
// verification path by shape - the app does not have to say which it is.
//
// The global ValidationPipe runs with forbidNonWhitelisted, so any extra key is
// a 400 rather than being silently ignored.
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FacebookLoginDto {
  @ApiProperty({
    description:
      'Facebook token from the app: Limited Login OIDC JWT (iOS) or classic access token (Android)',
    example: 'EAAPf...',
  })
  @IsString()
  @IsNotEmpty({ message: 'accessToken is required' })
  @MaxLength(4096)
  accessToken: string;
}
