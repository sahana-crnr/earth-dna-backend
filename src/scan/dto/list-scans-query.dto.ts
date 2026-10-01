import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { SCAN_STATUSES, type ScanStatus } from '../scan.types';

export class ListScansQueryDto {
  @ApiPropertyOptional({ enum: SCAN_STATUSES, example: 'draft' })
  @IsOptional()
  @IsIn(SCAN_STATUSES)
  status?: ScanStatus;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  offset?: number;
}
