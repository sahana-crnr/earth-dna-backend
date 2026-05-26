// DTO for creating a new user. Defines the expected request body fields and
// validation rules. zipCode is optional; all other fields are required.
import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  fullName: string;

  @ApiProperty({ example: 'jane@example.com' })
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

  @ApiProperty({ example: '10001', required: false })
  @IsString()
  @IsOptional()
  zipCode?: string;
}
