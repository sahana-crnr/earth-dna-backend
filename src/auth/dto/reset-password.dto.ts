import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Token received in the password reset email' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'newStrongP@ss1', minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;
}
