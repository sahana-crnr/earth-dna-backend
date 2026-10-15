// E22 body (F5-D6): every field optional, at least one must be present (checked
// in the service: EMPTY_UPDATE). Catalog ids are validated against the
// catalog in the service (UNKNOWN_BRAND / UNKNOWN_SIZE / UNKNOWN_SHOE_TYPE /
// UNKNOWN_PHOTO). Condition is not editable (F5-D5, Q27); category /
// sub-category come from ShoeDNA only.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  ACTION_TAKEN,
  GENDERS,
  type ActionTaken,
  type Gender,
} from '../../scan/scan.types';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateShoeDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Catalog brand id (E14)',
  })
  @ValidateIf((_, v) => v !== undefined)
  @IsUUID('4')
  brandId?: string;

  @ApiPropertyOptional({ maxLength: 150, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(150)
  @Transform(trim)
  model?: string | null;

  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  color?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Catalog size id (E15); null clears the size',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('4')
  sizeId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Shoe type id (E16); null clears it',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID('4')
  shoeTypeId?: string | null;

  @ApiPropertyOptional({ enum: GENDERS, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(GENDERS)
  gender?: Gender | null;

  @ApiPropertyOptional({
    enum: ACTION_TAKEN,
    description:
      'What the user did with the pair (F5-D9). Sets / clears actionTakenAt.',
  })
  @IsOptional()
  @IsIn(ACTION_TAKEN)
  actionTaken?: ActionTaken;

  @ApiPropertyOptional({
    format: 'uuid',
    description: "One of this shoe's photo ids becomes the main photo",
  })
  @ValidateIf((_, v) => v !== undefined)
  @IsUUID('4')
  primaryPhotoId?: string;
}
