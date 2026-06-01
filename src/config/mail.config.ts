import { registerAs } from '@nestjs/config';

export default registerAs('mail', () => ({
  fromName: process.env.MAIL_FROM_NAME || 'Earth DNA',
  fromEmail: process.env.AWS_SES_FROM_EMAIL || '',
  dryRun: process.env.MAIL_DRY_RUN === 'true',
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  resetTokenExpiryMinutes: parseInt(
    process.env.RESET_PASSWORD_TOKEN_EXPIRY_MINUTES ?? '15',
    10,
  ),
  appUrl: process.env.APP_URL || 'http://localhost:1234',
}));
