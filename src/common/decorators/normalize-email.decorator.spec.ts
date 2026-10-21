// Emails are trimmed and lowercased by the global ValidationPipe (same options
// as main.ts) on every DTO that identifies an account, so "Jane@Example.com "
// registers, logs in and requests a reset as the same user.
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RegisterDto } from '../../auth/dto/register.dto';
import { LoginDto } from '../../auth/dto/login.dto';
import { ForgotPasswordDto } from '../../auth/dto/forgot-password.dto';

describe('NormalizeEmail', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const run = <T>(value: object, metatype: new () => T): Promise<T> =>
    pipe.transform(value, { type: 'body', metatype }) as Promise<T>;

  const messy = '  Jane.Doe_1@Example.COM ';
  const clean = 'jane.doe_1@example.com';

  it('normalises the email on register', async () => {
    const dto = await run(
      {
        fullName: 'Jane Doe',
        email: messy,
        password: 'Str0ngPassw0rd!',
        country: 'USA',
      },
      RegisterDto,
    );
    expect(dto.email).toBe(clean);
  });

  it('normalises the email on login', async () => {
    const dto = await run({ email: messy, password: 'x' }, LoginDto);
    expect(dto.email).toBe(clean);
  });

  it('normalises the email on forgot-password', async () => {
    const dto = await run({ email: messy }, ForgotPasswordDto);
    expect(dto.email).toBe(clean);
  });

  it('still rejects a non-string email', async () => {
    await expect(run({ email: 42 }, ForgotPasswordDto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
