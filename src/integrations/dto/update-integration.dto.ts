// PUT /admin/integrations/{name} body (F7). Every field is optional: absent
// keeps the stored value, null clears it (see applyUpdate). Unknown fields are
// a 400 via the global forbidNonWhitelisted.
//
// baseUrl must be https: the backend will send shoe photos and user data to
// it once F2/F5 wire the calls, so a plaintext endpoint is never acceptable.
//
// Both baseUrl and authRef are returned verbatim by GET, so neither may carry
// a credential. baseUrl rejects user:pass@, ?query and #fragment - the usual
// places an API key gets pasted. authRef must look like one of our Secrets
// Manager names (earthdna/…), so a raw key fails validation instead of being
// stored and echoed back.
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

// AWS Secrets Manager name characters, under our `earthdna/` prefix.
export const AUTH_REF_PATTERN = /^earthdna\/[A-Za-z0-9/_+=.@-]+$/;

export class UpdateIntegrationDto {
  @ApiPropertyOptional({
    example: 'https://shoedna.example.com/v2',
    nullable: true,
    description:
      'https only, no user:pass@, query or #fragment; null clears it (only while disabled)',
  })
  @IsOptional()
  @IsUrl(
    {
      protocols: ['https'],
      require_protocol: true,
      disallow_auth: true,
      allow_query_components: false,
      allow_fragments: false,
    },
    {
      message:
        'baseUrl must be an https URL without credentials, query string or fragment',
    },
  )
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
      'Name of the secret holding the credential (AWS Secrets Manager, must start with "earthdna/") - never the credential itself',
  })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  @Matches(AUTH_REF_PATTERN, {
    message:
      'authRef must be a secret name starting with "earthdna/" (letters, digits and /_+=.@- only)',
  })
  authRef?: string | null;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
