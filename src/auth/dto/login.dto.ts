// DTO for the POST /auth/login endpoint.
// Validates that email is properly formatted and password is provided.
import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from '../../common/decorators/normalize-email.decorator';

export class LoginDto {
  @ApiProperty({ example: 'jane@example.com' })
  @NormalizeEmail()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @ApiProperty({ example: 'Password123' })
  @IsString()
  password: string;
}
