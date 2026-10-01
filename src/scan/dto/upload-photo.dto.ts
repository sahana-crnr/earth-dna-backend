import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/** Text fields of the multipart upload (the file itself is the `file` part). */
export class UploadPhotoBodyDto {
  @ApiPropertyOptional({
    example: '2026-09-29T10:15:00.000Z',
    description: 'When the photo was taken (ISO 8601). Optional.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  takenAt?: string;
}

/** Swagger-only: documents the multipart form for E6. */
export class UploadPhotoFormDoc extends UploadPhotoBodyDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'JPG/JPEG/PNG, max SCAN_PHOTO_MAX_BYTES (1 MB)',
  })
  file: unknown;
}
