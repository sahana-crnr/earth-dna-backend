// E30 body (F5-D19): the user's suggested condition and why. Stored as a
// training row; the shoe's condition is not changed.
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { CONDITION_CODES, type ConditionCode } from '../../scan/scan.types';

export class ConditionFeedbackDto {
  @ApiProperty({ enum: CONDITION_CODES })
  @IsIn(CONDITION_CODES)
  suggestedConditionCode: ConditionCode;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
