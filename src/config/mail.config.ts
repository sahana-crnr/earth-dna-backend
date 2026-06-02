import { registerAs } from '@nestjs/config';

/** Strip trailing slashes so reset URLs are built consistently. */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export default registerAs('mail', () => {
  const backendUrl = normalizeBaseUrl(
    process.env.BACKEND_URL || 'http://localhost:1234',
  );

  return {
    fromName: process.env.MAIL_FROM_NAME || 'Earth DNA',
    fromEmail: process.env.AWS_SES_FROM_EMAIL || '',
    dryRun: process.env.MAIL_DRY_RUN === 'true',
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    resetTokenExpiryMinutes: parseInt(
      process.env.RESET_PASSWORD_TOKEN_EXPIRY_MINUTES ?? '15',
      10,
    ),
    /** Base URL for password-reset links (the backend API). */
    backendUrl,
  };
});
