// Body of E10 (POST /scans/:scanId/shoes/:shoeId/result). Hard caps live here;
// the configurable caps (SCAN_RESULT_*) are enforced in the service, the same
// split as album-batch.dto.ts.
//
// `source` is deliberately absent: the endpoint is the on-device submit route
// and the service records source='device' itself, so a client cannot claim to
// be the server-side ShoeDNA endpoint.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CONDITION_CODES,
  IDENTIFICATION_OUTCOMES,
  type ConditionCode,
  type IdentificationOutcome,
} from '../scan.types';

export class ResultCandidateDto {
  @ApiProperty({ example: 'Nike' })
  @IsString()
  @MaxLength(120)
  brand: string;

  @ApiPropertyOptional({ example: 'Air Max 90' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  model?: string;

  @ApiProperty({ example: 0.9234, minimum: 0, maximum: 1 })
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence: number;
}

export class SubmitShoeResultDto {
  @ApiProperty({
    example: 'shoedna-tflite-1.4.2',
    description:
      'Which ShoeDNA build produced this result. Stored verbatim so results stay comparable across model upgrades.',
  })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9._@/-]+$/, {
    message: 'modelVersion may contain letters, digits and . _ @ / -',
  })
  modelVersion: string;

  @ApiPropertyOptional({
    enum: IDENTIFICATION_OUTCOMES,
    default: 'identified',
    description: "Send 'failed' when the on-device model could not identify.",
  })
  @IsOptional()
  @IsIn(IDENTIFICATION_OUTCOMES)
  outcome?: IdentificationOutcome;

  @ApiPropertyOptional({
    example: 'Nike',
    description: "Required when outcome is 'identified'.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional({ example: 'Sportswear' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subBrand?: string;

  @ApiPropertyOptional({ example: 'Air Max 90' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  model?: string;

  @ApiPropertyOptional({ example: 'White / Black' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  colorway?: string;

  @ApiPropertyOptional({
    example: 0.9234,
    minimum: 0,
    maximum: 1,
    description:
      "Required when outcome is 'identified'. The whole-number matchPercent is derived server-side.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiPropertyOptional({
    enum: CONDITION_CODES,
    description:
      'Raw ShoeDNA grade. The label is derived server-side and is provisional.',
  })
  @IsOptional()
  @IsIn(CONDITION_CODES)
  conditionCode?: ConditionCode;

  @ApiPropertyOptional({
    type: [ResultCandidateDto],
    description:
      'Ranked candidates, top-3 by default (SCAN_RESULT_MAX_CANDIDATES). Stored in a canonical order.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ResultCandidateDto)
  candidates?: ResultCandidateDto[];

  @ApiPropertyOptional({
    description:
      'Any further ShoeDNA fields, stored verbatim while the output contract is open. Max SCAN_RESULT_RAW_MAX_BYTES (8 KB) serialized, 6 levels deep.',
    example: { embeddingVersion: 'v3' },
  })
  @IsOptional()
  @IsObject()
  raw?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: '2026-10-05T10:15:00.000Z',
    description: 'When the device produced the result. Defaults to now.',
  })
  // Stays a string: the global ValidationPipe runs with enableImplicitConversion,
  // so a `Date` here would be converted before validation and @IsISO8601 — which
  // only ever accepts a string — would reject every value the app sends.
  @IsOptional()
  @IsISO8601({ strict: true })
  submittedAt?: string;
}
