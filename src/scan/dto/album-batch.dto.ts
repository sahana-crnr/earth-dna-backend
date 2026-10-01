import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const SAFE = /^[A-Za-z0-9_-]{1,40}$/;

export class AlbumFileRefDto {
  @ApiProperty({
    example: 'f1',
    description: 'Name of the multipart file part',
  })
  @IsString()
  @Matches(SAFE)
  field: string;

  @ApiProperty({ example: 'top', description: 'top | right | left | sole' })
  @IsString()
  @MaxLength(10)
  view: string;
}

export class AlbumShoeDto {
  @ApiProperty({
    example: 'a',
    description: "The app's own label for matching results",
  })
  @IsString()
  @Matches(SAFE)
  ref: string;

  @ApiProperty({ type: [AlbumFileRefDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => AlbumFileRefDto)
  files: AlbumFileRefDto[];
}

/** Parsed from the `manifest` text part. Hard caps here; config caps in the service. */
export class AlbumManifestDto {
  @ApiProperty({ type: [AlbumShoeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AlbumShoeDto)
  shoes: AlbumShoeDto[];
}

/** Text fields of the album multipart request. */
export class AlbumBatchBodyDto {
  @ApiProperty({
    description:
      'JSON: { "shoes": [ { "ref": "a", "files": [ { "field": "f1", "view": "top" } ] } ] }',
  })
  @IsString()
  @MaxLength(8192)
  manifest: string;
}
