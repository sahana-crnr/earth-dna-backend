// E20 query. Each filter is multi-select like the Filters sheet: values within
// one filter are OR-ed, different filters AND-ed. `?x=a,b` and `?x=a&x=b` are
// both accepted (splitMulti); an unknown value is a 400 from the global
// ValidationPipe, never a silently empty page. Paging mirrors E2.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import {
  ACTION_TAKEN,
  RECOMMENDED_ACTIONS,
  RESALE_BUCKETS,
  type ActionTaken,
  type RecommendedAction,
  type ResaleBucket,
} from '../../scan/scan.types';
import { CONDITION_FILTERS, splitMulti } from '../shoes-rules';

const multi = () => Transform(({ value }) => splitMulti(value));

export class ListShoesQueryDto {
  @ApiPropertyOptional({
    type: [String],
    enum: ACTION_TAKEN,
    description: 'Comma-separated or repeated',
    example: 'none,resold',
  })
  @IsOptional()
  @multi()
  @IsArray()
  @ArrayMaxSize(ACTION_TAKEN.length)
  @IsIn(ACTION_TAKEN, { each: true })
  actionTaken?: ActionTaken[];

  @ApiPropertyOptional({
    type: [String],
    enum: CONDITION_FILTERS,
    description:
      'Condition label as the card shows it (F2 scale, PROVISIONAL). Comma-separated or repeated',
    example: 'like_new,lightly_worn',
  })
  @IsOptional()
  @multi()
  @IsArray()
  @ArrayMaxSize(CONDITION_FILTERS.length)
  @IsIn(CONDITION_FILTERS, { each: true })
  condition?: string[];

  @ApiPropertyOptional({
    type: [String],
    enum: RECOMMENDED_ACTIONS,
    description: 'Comma-separated or repeated',
    example: 'resell',
  })
  @IsOptional()
  @multi()
  @IsArray()
  @ArrayMaxSize(RECOMMENDED_ACTIONS.length)
  @IsIn(RECOMMENDED_ACTIONS, { each: true })
  recommendedAction?: RecommendedAction[];

  @ApiPropertyOptional({
    type: [String],
    enum: RESALE_BUCKETS,
    description: 'Comma-separated or repeated',
    example: 'from_50_to_100,over_100',
  })
  @IsOptional()
  @multi()
  @IsArray()
  @ArrayMaxSize(RESALE_BUCKETS.length)
  @IsIn(RESALE_BUCKETS, { each: true })
  resaleBucket?: ResaleBucket[];

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
