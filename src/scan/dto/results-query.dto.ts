// Query options for E11. The "Scan processing" screen polls that route every
// couple of seconds, so the expensive part of a result — the free-form `raw`
// blob, capped at SCAN_RESULT_RAW_MAX_BYTES *per shoe* — is opt-in rather than
// sent on every poll. E10 still returns it unconditionally.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/** Optional parts of a result the caller can ask for by name. */
export const RESULT_INCLUDES = ['raw'] as const;
export type ResultInclude = (typeof RESULT_INCLUDES)[number];

export class ResultsQueryDto {
  @ApiPropertyOptional({
    enum: RESULT_INCLUDES,
    description:
      'Opt into fields omitted by default. `raw` adds the verbatim ShoeDNA blob to every shoe; leave it off while polling.',
  })
  @IsOptional()
  @IsIn(RESULT_INCLUDES)
  include?: ResultInclude;
}
