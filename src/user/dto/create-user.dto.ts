// DTO for creating a new user. Defines the expected request body fields and
// validation rules. zipCode and countryCode are optional; all others required.
import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from '../../common/decorators/normalize-email.decorator';

export class CreateUserDto {
  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  fullName: string;

  @ApiProperty({ example: 'jane@example.com' })
  @NormalizeEmail()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @ApiProperty({ example: 'Password123', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  password: string;

  @ApiProperty({ example: 'USA' })
  @IsString()
  country: string;

  // The app computes a country code on sign-up. Before this field existed the
  // global ValidationPipe (forbidNonWhitelisted) rejected the whole request with
  // a 400 rather than ignoring the extra key.
  @ApiProperty({ example: '+1', required: false })
  @IsString()
  @IsOptional()
  @MaxLength(10)
  countryCode?: string;

  @ApiProperty({ example: '10001', required: false })
  @IsString()
  @IsOptional()
  zipCode?: string;
}
