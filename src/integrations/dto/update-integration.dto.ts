// PUT /admin/integrations/{name} body (F7). Every field is optional: absent
// keeps the stored value, null clears it (see applyUpdate). Unknown fields are
// a 400 via the global forbidNonWhitelisted.
//
// baseUrl must be https: the backend will send shoe photos and user data to
// it once F2/F5 wire the calls, so a plaintext endpoint is never acceptable.
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
} from 'class-validator';

export class UpdateIntegrationDto {
  @ApiPropertyOptional({
    example: 'https://shoedna.example.com/v2',
    nullable: true,
    description: 'https only; null clears it (only while disabled)',
  })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  baseUrl?: string | null;

  @ApiPropertyOptional({ example: '2.3.0', nullable: true })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  version?: string | null;

  @ApiPropertyOptional({
    example: 'earthdna/be/shoedna-api-key-dev2',
    nullable: true,
    description:
      'Name of the secret holding the credential (e.g. AWS Secrets Manager) - never the credential itself',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  authRef?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
