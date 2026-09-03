// DTO for POST /auth/google.
//
// Only idToken is accepted. The global ValidationPipe runs with
// forbidNonWhitelisted, so a request carrying any additional key is rejected with
// a 400 rather than having the extra field silently ignored.
import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GoogleLoginDto {
  @ApiProperty({
    description:
      'Google ID token (a JWT) obtained by the app from Google Sign-In',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjFiN2...',
  })
  @IsString()
  @IsNotEmpty({ message: 'idToken is required' })
  idToken: string;
}
