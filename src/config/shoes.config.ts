// F5 My Shoes settings: photo cap and signed-URL lifetime for the profile,
// and how public share links are built. Upload size / type rules are the F1
// ones (SCAN_PHOTO_*), read from scan config by the shoes service.
import { registerAs } from '@nestjs/config';
import { parsePositiveInt } from './scan.config';

export interface ShoesConfig {
  /** Photos per My Shoes entry, scan views included (Figma "Photos (4/8)"). */
  maxPhotos: number;
  /** Signed URL lifetime on the profile and the public share view. */
  photoUrlTtlSeconds: number;
  /** Prefix of share links, e.g. https://earthdna.app. Null → request origin. */
  shareBaseUrl: string | null;
  /** Length of the random part of a share token (base32 chars). */
  shareTokenRandomChars: number;
  /** S3 key prefix for photos uploaded from the Edit screen. */
  uploadPrefix: string;
}

export default registerAs(
  'shoes',
  (): ShoesConfig => ({
    maxPhotos: parsePositiveInt(process.env.SHOE_MAX_PHOTOS, 8),
    photoUrlTtlSeconds: parsePositiveInt(
      process.env.SHOE_PHOTO_URL_TTL_SECONDS,
      3600,
    ),
    shareBaseUrl: nonEmptyUrl(process.env.SHARE_BASE_URL),
    shareTokenRandomChars: parsePositiveInt(
      process.env.SHARE_TOKEN_RANDOM_CHARS,
      12,
    ),
    uploadPrefix: cleanPrefix(process.env.SHOE_UPLOAD_PREFIX, 'shoes'),
  }),
);

function nonEmptyUrl(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  return v.length > 0 ? v : null;
}

function cleanPrefix(raw: string | undefined, fallback: string): string {
  const v = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return v.length > 0 ? v : fallback;
}
