import { IsEmail } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { NormalizeEmail } from '../../common/decorators/normalize-email.decorator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'jane@example.com' })
  @NormalizeEmail()
  @IsEmail()
  email: string;
}
