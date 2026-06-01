import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private sesClient: SESClient;

  constructor(private readonly config: ConfigService) {
    this.sesClient = new SESClient({
      region: this.config.get<string>('mail.awsRegion'),
    });
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const fromName = this.config.get<string>('mail.fromName');
    const fromEmail = this.config.get<string>('mail.fromEmail');

    if (this.config.get<boolean>('mail.dryRun')) {
      this.logger.log(`[MAIL DRY RUN] Password reset link for ${to}: ${resetUrl}`);
      return;
    }

    await this.sesClient.send(
      new SendEmailCommand({
        Source: `${fromName} <${fromEmail}>`,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: 'Reset your Earth DNA password', Charset: 'UTF-8' },
          Body: {
            Html: {
              Charset: 'UTF-8',
              Data: this.buildResetEmailHtml(resetUrl),
            },
            Text: {
              Charset: 'UTF-8',
              Data: `Reset your password by visiting: ${resetUrl}\n\nThis link expires in 15 minutes.`,
            },
          },
        },
      }),
    );
  }

  private buildResetEmailHtml(resetUrl: string): string {
    return `
<!DOCTYPE html>
<html>
  <body style="font-family: sans-serif; color: #333; max-width: 480px; margin: 0 auto; padding: 24px;">
    <h2>Reset your password</h2>
    <p>Click the button below to reset your Earth DNA password. This link expires in <strong>15 minutes</strong>.</p>
    <a href="${resetUrl}"
       style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">
      Reset Password
    </a>
    <p style="margin-top:24px;font-size:12px;color:#999;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </body>
</html>`;
  }
}
