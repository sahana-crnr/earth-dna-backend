import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private sesClient: SESClient;

  constructor(private readonly config: ConfigService) {
    this.sesClient = new SESClient({
      region: this.config.get<string>('mail.awsRegion'),
    });
  }

  // Logs how mail is configured at boot. The forgot-password endpoint answers
  // 200 even when sending fails, so this line is the first place to look when
  // users report that reset emails never arrive.
  onModuleInit(): void {
    if (this.parseBooleanConfig('mail.dryRun')) {
      this.logger.warn(
        'MAIL_DRY_RUN is on: reset emails are only logged, never sent',
      );
      return;
    }
    const fromEmail = this.config.get<string>('mail.fromEmail');
    if (!fromEmail) {
      this.logger.error(
        'AWS_SES_FROM_EMAIL is not set: every reset email will fail',
      );
      return;
    }
    this.logger.log(
      `Reset emails sent through SES from ${fromEmail} in ${this.config.get<string>('mail.awsRegion')}`,
    );
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const fromName = this.config.get<string>('mail.fromName') || 'Earth DNA';
    const fromEmail = this.config.get<string>('mail.fromEmail');
    const expiryMinutes =
      this.config.get<number>('mail.resetTokenExpiryMinutes') ?? 15;

    const isDryRun = this.parseBooleanConfig('mail.dryRun');

    if (isDryRun) {
      this.logger.log(
        `[MAIL DRY RUN] Password reset  link for ${to}: ${resetUrl}`,
      );
      return;
    }

    if (!fromEmail) {
      throw new Error('AWS_SES_FROM_EMAIL is not configured');
    }

    try {
      const result = await this.sesClient.send(
        new SendEmailCommand({
          Source: `${fromName} <${fromEmail}>`,
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: {
              Data: 'Reset your Earth DNA password',
              Charset: 'UTF-8',
            },
            Body: {
              Html: {
                Charset: 'UTF-8',
                Data: this.buildResetEmailHtml(resetUrl, expiryMinutes),
              },
              Text: {
                Charset: 'UTF-8',
                Data: `Reset your password by visiting: ${resetUrl}\n\nThis link expires in ${expiryMinutes} minutes.`,
              },
            },
          },
        }),
      );
      this.logger.log(
        `Password reset email sent to ${to} (SES MessageId ${result.MessageId})`,
      );
    } catch (error) {
      const err = error as Error;
      // MessageRejected "Email address is not verified" means SES is still in
      // sandbox (recipient not verified) or the sender identity is not verified.
      this.logger.error(
        `SES rejected password reset email to ${to}: ${err.name}: ${err.message}`,
      );
      throw error;
    }
  }

  private buildResetEmailHtml(resetUrl: string, expiryMinutes: number): string {
    return `
<!DOCTYPE html>
<html>
  <body style="font-family: sans-serif; color: #333; max-width: 480px; margin: 0 auto; padding: 24px;">
    <h2>Reset your password</h2>
    <p>Click the button below to reset your Earth DNA password. This link expires in <strong>${expiryMinutes} minutes</strong>.</p>
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

  private parseBooleanConfig(configKey: string): boolean {
    const value = this.config.get<unknown>(configKey);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
    }
    return false;
  }
}
