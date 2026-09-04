// DTO for POST /auth/apple.
//
// fullName is optional and only ever present on the user's very first
// authorization: Apple gives the name to the app once and never puts it inside
// the identity token, so the app forwards it here. On later sign-ins it is
// absent and the stored name is kept.
import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AppleLoginDto {
  @ApiProperty({
    description:
      'Apple identity token (a JWT) obtained by the app from Sign in with Apple',
    example: 'eyJraWQiOiJmaDZCczhDIiwiYWxnIjoiUlMyNTYifQ...',
  })
  @IsString()
  @IsNotEmpty({ message: 'identityToken is required' })
  @MaxLength(4096)
  identityToken: string;

  @ApiProperty({
    description:
      "User's full name as given by Apple. Only sent on the very first sign-in.",
    example: 'Jane Doe',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fullName?: string;
}
