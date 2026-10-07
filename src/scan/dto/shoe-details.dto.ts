// Body of E12 confirm and E13 reject (F3-D5): the five fields the review form
// collects. Confirm: everything optional, the ShoeDNA prediction fills the
// gaps. Reject: brand, model, color and size are required — the user is
// telling us the prediction was wrong, so the answer must be complete.
// Category, sub-category, condition and material are never accepted here;
// they come from the F2 result (F3-D5, D8).
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { GENDERS, type Gender } from '../scan.types';

export class ShoeDetailsDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'catalog brand id (E14)',
  })
  @IsOptional()
  @IsUUID('4')
  brandId?: string;

  @ApiPropertyOptional({ example: 'Cloudmonster 2', maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  model?: string;

  @ApiPropertyOptional({ example: 'Black', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  color?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'catalog size id (E15)' })
  @IsOptional()
  @IsUUID('4')
  sizeId?: string;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender;
}

// Not `extends ShoeDetailsDto`: class-validator merges parent metadata, so the
// parent's @IsOptional would keep applying and silently make these optional.
export class RejectShoeDto {
  @ApiProperty({ format: 'uuid', description: 'catalog brand id (E14)' })
  @IsUUID('4')
  brandId: string;

  @ApiProperty({ example: 'Air Max', maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  model: string;

  @ApiProperty({ example: 'White', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  color: string;

  @ApiProperty({ format: 'uuid', description: 'catalog size id (E15)' })
  @IsUUID('4')
  sizeId: string;

  @ApiPropertyOptional({ enum: GENDERS })
  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender;
}
