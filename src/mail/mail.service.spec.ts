import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

jest.mock('@aws-sdk/client-ses', () => {
  const send = jest.fn().mockResolvedValue({});
  return {
    SESClient: jest.fn().mockImplementation(() => ({ send })),
    SendEmailCommand: jest.fn().mockImplementation((input) => input),
    __mockSend: send,
  };
});

const { __mockSend: mockSesSend } = jest.requireMock('@aws-sdk/client-ses');

describe('MailService', () => {
  let service: MailService;

  const configGet = jest.fn((key: string) => {
    const map: Record<string, unknown> = {
      'mail.awsRegion': 'us-east-1',
      'mail.fromName': 'Earth DNA',
      'mail.fromEmail': 'noreply@example.com',
      'mail.dryRun': false,
      'mail.resetTokenExpiryMinutes': 30,
    };
    return map[key];
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        {
          provide: ConfigService,
          useValue: { get: configGet },
        },
      ],
    }).compile();

    service = module.get<MailService>(MailService);
  });

  it('logs reset URL in dry-run mode without calling SES', async () => {
    const dryRunGet = jest.fn((key: string) => {
      const map: Record<string, unknown> = {
        'mail.awsRegion': 'us-east-1',
        'mail.fromName': 'Earth DNA',
        'mail.fromEmail': 'noreply@example.com',
        'mail.dryRun': true,
        'mail.resetTokenExpiryMinutes': 15,
      };
      return map[key];
    });

    const module = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: ConfigService, useValue: { get: dryRunGet } },
      ],
    }).compile();

    const dryRunMail = module.get<MailService>(MailService);

    await dryRunMail.sendPasswordResetEmail(
      'user@example.com',
      'http://localhost:3000/reset-password?token=abc',
    );

    expect(mockSesSend).not.toHaveBeenCalled();
  });

  it('sends email via SES with configured expiry in body', async () => {
    await service.sendPasswordResetEmail(
      'user@example.com',
      'http://localhost:3000/reset-password?token=abc',
    );

    expect(SendEmailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Destination: { ToAddresses: ['user@example.com'] },
        Message: expect.objectContaining({
          Body: expect.objectContaining({
            Text: expect.objectContaining({
              Data: expect.stringContaining('expires in 30 minutes'),
            }),
          }),
        }),
      }),
    );
    expect(mockSesSend).toHaveBeenCalled();
  });

  it('throws when from email is missing', async () => {
    configGet.mockImplementation((key: string) => {
      const map: Record<string, unknown> = {
        'mail.awsRegion': 'us-east-1',
        'mail.fromName': 'Earth DNA',
        'mail.fromEmail': '',
        'mail.dryRun': false,
        'mail.resetTokenExpiryMinutes': 15,
      };
      return map[key];
    });

    const module = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    const mail = module.get<MailService>(MailService);

    await expect(
      mail.sendPasswordResetEmail('user@example.com', 'http://reset'),
    ).rejects.toThrow('AWS_SES_FROM_EMAIL is not configured');
  });
});
