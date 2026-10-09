// Query parameters of the catalog list routes. `q` is capped at 50 characters
// and every id is a v4 UUID, as the global ValidationPipe enforces them.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class BrandsQueryDto {
  @ApiPropertyOptional({ description: 'Prefix search on the brand name' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  q?: string;
}

export class SizesQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Brand to list sizes for; generic list when absent or unknown',
  })
  @IsOptional()
  @IsUUID('4')
  brandId?: string;
}

export class ModelsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  brandId: string;

  @ApiPropertyOptional({ description: 'Prefix search on the model name' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  q?: string;
}

export class ColoursQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  brandId: string;

  @ApiPropertyOptional({
    description: 'Exact model name (case-insensitive) to narrow colours',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;
}
